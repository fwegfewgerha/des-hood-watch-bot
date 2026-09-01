// PostgreSQL-backed persistence for per-guild stats and security settings.
// Requires DATABASE_URL (Railway sets this automatically once a Postgres
// service is added to the project and referenced on this service's
// Variables tab as ${{Postgres.DATABASE_URL}}).
//
// Every function here is async — this replaced an earlier JSON-file store
// where the same functions were synchronous, so every call site awaits.

const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  console.error('Missing DATABASE_URL. Add a Postgres database in Railway and reference its DATABASE_URL on this service.');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Railway's internal Postgres connections don't need a verified cert chain.
  ssl: process.env.DATABASE_URL.includes('railway') ? { rejectUnauthorized: false } : undefined,
});

async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS guild_settings (
      guild_id TEXT PRIMARY KEY,
      secure_enabled BOOLEAN NOT NULL DEFAULT FALSE,
      raid_protect_active BOOLEAN NOT NULL DEFAULT FALSE,
      min_account_age_days INTEGER,
      log_channel_id TEXT,
      locked_channels JSONB NOT NULL DEFAULT '[]'::jsonb
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS member_stats (
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      messages INTEGER NOT NULL DEFAULT 0,
      voice_ms BIGINT NOT NULL DEFAULT 0,
      PRIMARY KEY (guild_id, user_id)
    )
  `);
}

async function ensureGuildRow(guildId) {
  await pool.query(
    `INSERT INTO guild_settings (guild_id) VALUES ($1) ON CONFLICT (guild_id) DO NOTHING`,
    [guildId]
  );
}

// ---- Message / voice stats -------------------------------------------------

async function addMessage(guildId, userId) {
  await pool.query(
    `INSERT INTO member_stats (guild_id, user_id, messages, voice_ms)
     VALUES ($1, $2, 1, 0)
     ON CONFLICT (guild_id, user_id) DO UPDATE SET messages = member_stats.messages + 1`,
    [guildId, userId]
  );
}

async function addVoiceMs(guildId, userId, ms) {
  await pool.query(
    `INSERT INTO member_stats (guild_id, user_id, messages, voice_ms)
     VALUES ($1, $2, 0, $3)
     ON CONFLICT (guild_id, user_id) DO UPDATE SET voice_ms = member_stats.voice_ms + $3`,
    [guildId, userId, ms]
  );
}

async function getMemberStats(guildId, userId) {
  const res = await pool.query(
    `SELECT messages, voice_ms FROM member_stats WHERE guild_id = $1 AND user_id = $2`,
    [guildId, userId]
  );
  if (res.rows.length === 0) return { messages: 0, voiceMs: 0 };
  return { messages: res.rows[0].messages, voiceMs: Number(res.rows[0].voice_ms) };
}

// ---- Guild settings ----------------------------------------------------------

async function isSecureEnabled(guildId) {
  const res = await pool.query(`SELECT secure_enabled FROM guild_settings WHERE guild_id = $1`, [guildId]);
  return res.rows[0]?.secure_enabled ?? false;
}

async function setSecureEnabled(guildId, enabled) {
  await ensureGuildRow(guildId);
  await pool.query(`UPDATE guild_settings SET secure_enabled = $2 WHERE guild_id = $1`, [guildId, enabled]);
}

async function getLockedChannels(guildId) {
  const res = await pool.query(`SELECT locked_channels FROM guild_settings WHERE guild_id = $1`, [guildId]);
  return res.rows[0]?.locked_channels ?? [];
}

async function setLockedChannels(guildId, channelIds) {
  await ensureGuildRow(guildId);
  await pool.query(`UPDATE guild_settings SET locked_channels = $2::jsonb WHERE guild_id = $1`, [
    guildId,
    JSON.stringify(channelIds),
  ]);
}

// raidProtectActive and minAccountAgeDays are checked on every single join
// during a raid — potentially many times within the same second. A DB
// round-trip on every check would undercut the whole point of flipping
// this instantly. This in-memory cache is a speed layer only; Postgres
// stays the source of truth and every write still goes through to it.
const raidProtectCache = new Map(); // guildId -> { active: boolean, minAgeDays: number|null }

// logEvent() reads this on every security action (each auto-kick, each
// deleted invite), so it gets the same treatment.
const logChannelCache = new Map(); // guildId -> channelId|null

// Returns the single shared cache entry for a guild, creating it if needed.
//
// The in-flight promise is cached, not just the result — otherwise two
// concurrent callers (e.g. setRaidProtectActive + setMinAccountAgeDays
// running together in a Promise.all) would each start their own DB read,
// each build a separate entry object, and the second one to finish would
// clobber the first one's mutation.
const cacheLoads = new Map(); // guildId -> Promise<entry>

function loadCacheEntry(guildId) {
  if (raidProtectCache.has(guildId)) return Promise.resolve(raidProtectCache.get(guildId));
  if (cacheLoads.has(guildId)) return cacheLoads.get(guildId);

  const p = (async () => {
    const res = await pool.query(
      `SELECT raid_protect_active, min_account_age_days FROM guild_settings WHERE guild_id = $1`,
      [guildId]
    );
    // Re-check: another caller may have populated it while we awaited.
    if (raidProtectCache.has(guildId)) return raidProtectCache.get(guildId);
    const entry = {
      active: res.rows[0]?.raid_protect_active ?? false,
      minAgeDays: res.rows[0]?.min_account_age_days ?? null,
    };
    raidProtectCache.set(guildId, entry);
    return entry;
  })().finally(() => cacheLoads.delete(guildId));

  cacheLoads.set(guildId, p);
  return p;
}

// Pre-loads the cache for every guild that already has a settings row, so
// even the first check after a fresh deploy is instant rather than paying
// one lazy-load query. Call once at startup.
async function warmRaidProtectCache() {
  const res = await pool.query(
    `SELECT guild_id, raid_protect_active, min_account_age_days, log_channel_id FROM guild_settings`
  );
  for (const row of res.rows) {
    raidProtectCache.set(row.guild_id, {
      active: row.raid_protect_active,
      minAgeDays: row.min_account_age_days,
    });
    logChannelCache.set(row.guild_id, row.log_channel_id);
  }
}

async function isRaidProtectActive(guildId) {
  const entry = await loadCacheEntry(guildId);
  return entry.active;
}

async function setRaidProtectActive(guildId, active) {
  const entry = await loadCacheEntry(guildId);
  entry.active = active;
  await ensureGuildRow(guildId);
  await pool.query(`UPDATE guild_settings SET raid_protect_active = $2 WHERE guild_id = $1`, [guildId, active]);
}

async function getMinAccountAgeDays(guildId) {
  const entry = await loadCacheEntry(guildId);
  return entry.minAgeDays;
}

async function setMinAccountAgeDays(guildId, days) {
  const entry = await loadCacheEntry(guildId);
  entry.minAgeDays = days;
  await ensureGuildRow(guildId);
  await pool.query(`UPDATE guild_settings SET min_account_age_days = $2 WHERE guild_id = $1`, [guildId, days]);
}

async function getLogChannelId(guildId) {
  if (logChannelCache.has(guildId)) return logChannelCache.get(guildId);
  const res = await pool.query(`SELECT log_channel_id FROM guild_settings WHERE guild_id = $1`, [guildId]);
  const value = res.rows[0]?.log_channel_id ?? null;
  logChannelCache.set(guildId, value);
  return value;
}

async function setLogChannelId(guildId, channelId) {
  logChannelCache.set(guildId, channelId);
  await ensureGuildRow(guildId);
  await pool.query(`UPDATE guild_settings SET log_channel_id = $2 WHERE guild_id = $1`, [guildId, channelId]);
}

module.exports = {
  init,
  warmRaidProtectCache,
  addMessage,
  addVoiceMs,
  getMemberStats,
  isSecureEnabled,
  setSecureEnabled,
  getLockedChannels,
  setLockedChannels,
  isRaidProtectActive,
  setRaidProtectActive,
  getMinAccountAgeDays,
  setMinAccountAgeDays,
  getLogChannelId,
  setLogChannelId,
};
