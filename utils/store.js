// PostgreSQL-backed persistence for per-guild stats and security settings.
// Requires DATABASE_URL (Railway sets this automatically once a Postgres
// service is added to the project and referenced on this service's
// Variables tab as ${{Postgres.DATABASE_URL}}).
//
// Every function here is async — reflecting that this replaced an earlier
// JSON-file store where the same functions were synchronous.
//
// SPEED DESIGN: every guild_settings field (secureEnabled, automodEnabled,
// raidProtectActive, minAccountAgeDays, logChannelId, lockedChannels,
// joinBaseline) lives in one in-memory cache per guild. Every read goes through that cache — never Postgres
// directly. Every write updates the cache immediately and then fires the
// actual Postgres write in the background (not awaited) — callers get
// their promise back as soon as the cache is updated, not after a network
// round-trip to the database. Postgres remains the durable source of
// truth (it's what the cache is warmed from on startup), it's just never
// on the critical path of an actual security action.

const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  console.error('Missing DATABASE_URL. Add a Postgres database in Railway and reference its DATABASE_URL on this service.');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Railway's internal Postgres connections don't need a verified cert chain.
  ssl: process.env.DATABASE_URL.includes('railway') ? { rejectUnauthorized: false } : undefined,
  // pg closes idle connections after 10s by default. On a quiet server that
  // means nearly every command's first query pays a fresh TCP+TLS+auth
  // handshake — far more expensive than the query itself. Hold connections
  // open instead; an idle socket costs effectively nothing here.
  idleTimeoutMillis: 0,
  keepAlive: true,
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
  // Added after the table shipped, so it has to be an ALTER rather than a
  // column in the CREATE above. Defaults to TRUE: automod is meant to be
  // running from the moment the bot joins, without anyone turning it on.
  await pool.query(`
    ALTER TABLE guild_settings
    ADD COLUMN IF NOT EXISTS automod_enabled BOOLEAN NOT NULL DEFAULT TRUE
  `);
  // Learned join-rate baseline (utils/joinBaseline.js). Empty object means
  // "nothing learned yet", which the alert treats as its fixed floor.
  await pool.query(`
    ALTER TABLE guild_settings
    ADD COLUMN IF NOT EXISTS join_baseline JSONB NOT NULL DEFAULT '{}'::jsonb
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

// ---- Message / voice stats -------------------------------------------------
// Not part of the speed-critical security path, so these still write
// straight through. (messageTracking.js fires addMessage in the
// background anyway, so it never blocks the /secure check either.)

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

// ---- Unified guild settings cache ----------------------------------------------

const guildCache = new Map(); // guildId -> { secureEnabled, automodEnabled, raidProtectActive, minAccountAgeDays, logChannelId, lockedChannels }

// In-flight load promises, keyed by guildId — dedupes concurrent cold
// loads for the same guild so they all resolve to the SAME cache entry
// object. Without this, two concurrent setters (e.g. setRaidProtectActive
// + setMinAccountAgeDays running together in a Promise.all) would each
// build their own separate entry object on a cold cache, and whichever
// finished last would silently clobber the other's mutation.
const guildCacheLoads = new Map(); // guildId -> Promise<entry>

function defaultEntry() {
  return {
    secureEnabled: false,
    automodEnabled: true,
    raidProtectActive: false,
    minAccountAgeDays: null,
    logChannelId: null,
    lockedChannels: [],
    joinBaseline: null,
  };
}

function loadGuildCache(guildId) {
  if (guildCache.has(guildId)) return Promise.resolve(guildCache.get(guildId));
  if (guildCacheLoads.has(guildId)) return guildCacheLoads.get(guildId);

  const p = (async () => {
    const res = await pool.query(
      `SELECT secure_enabled, automod_enabled, raid_protect_active, min_account_age_days, log_channel_id, locked_channels, join_baseline
       FROM guild_settings WHERE guild_id = $1`,
      [guildId]
    );
    // Another concurrent caller may have populated it while we awaited.
    if (guildCache.has(guildId)) return guildCache.get(guildId);
    const row = res.rows[0];
    const entry = row
      ? {
          secureEnabled: row.secure_enabled,
          automodEnabled: row.automod_enabled,
          raidProtectActive: row.raid_protect_active,
          minAccountAgeDays: row.min_account_age_days,
          logChannelId: row.log_channel_id,
          lockedChannels: row.locked_channels ?? [],
          joinBaseline: row.join_baseline ?? null,
        }
      : defaultEntry();
    guildCache.set(guildId, entry);
    return entry;
  })().finally(() => guildCacheLoads.delete(guildId));

  guildCacheLoads.set(guildId, p);
  return p;
}

// Pre-loads the cache for every guild that already has a settings row, so
// even the very first check after a fresh deploy is instant rather than
// paying one lazy-load query. Call once at startup.
async function warmRaidProtectCache() {
  const res = await pool.query(
    `SELECT guild_id, secure_enabled, automod_enabled, raid_protect_active, min_account_age_days, log_channel_id, locked_channels, join_baseline
     FROM guild_settings`
  );
  for (const row of res.rows) {
    guildCache.set(row.guild_id, {
      secureEnabled: row.secure_enabled,
      automodEnabled: row.automod_enabled,
      raidProtectActive: row.raid_protect_active,
      minAccountAgeDays: row.min_account_age_days,
      logChannelId: row.log_channel_id,
      lockedChannels: row.locked_channels ?? [],
      joinBaseline: row.join_baseline ?? null,
    });
  }
}

// Fires a single-column upsert in the background. Never awaited by
// callers — the cache (already updated by the setter before this runs)
// is what every read goes through, so nothing is gained by waiting for
// the actual write to land before returning control to the caller.
function persistField(guildId, column, value) {
  pool
    .query(
      `INSERT INTO guild_settings (guild_id, ${column}) VALUES ($1, $2)
       ON CONFLICT (guild_id) DO UPDATE SET ${column} = $2`,
      [guildId, value]
    )
    .catch((err) => console.error(`Failed to persist ${column} for guild ${guildId}:`, err));
}

// ---- Secure -----------------------------------------------------------------

async function isSecureEnabled(guildId) {
  const entry = await loadGuildCache(guildId);
  return entry.secureEnabled;
}

async function setSecureEnabled(guildId, enabled) {
  const entry = await loadGuildCache(guildId);
  entry.secureEnabled = enabled;
  persistField(guildId, 'secure_enabled', enabled);
}

// ---- Automod ----------------------------------------------------------------

async function isAutoModEnabled(guildId) {
  const entry = await loadGuildCache(guildId);
  return entry.automodEnabled;
}

async function setAutoModEnabled(guildId, enabled) {
  const entry = await loadGuildCache(guildId);
  entry.automodEnabled = enabled;
  persistField(guildId, 'automod_enabled', enabled);
}

// ---- Raid protect -------------------------------------------------------------

async function isRaidProtectActive(guildId) {
  const entry = await loadGuildCache(guildId);
  return entry.raidProtectActive;
}

async function setRaidProtectActive(guildId, active) {
  const entry = await loadGuildCache(guildId);
  entry.raidProtectActive = active;
  persistField(guildId, 'raid_protect_active', active);
}

async function getMinAccountAgeDays(guildId) {
  const entry = await loadGuildCache(guildId);
  return entry.minAccountAgeDays;
}

async function setMinAccountAgeDays(guildId, days) {
  const entry = await loadGuildCache(guildId);
  entry.minAccountAgeDays = days;
  persistField(guildId, 'min_account_age_days', days);
}

async function getLockedChannels(guildId) {
  const entry = await loadGuildCache(guildId);
  return entry.lockedChannels;
}

async function setLockedChannels(guildId, channelIds) {
  const entry = await loadGuildCache(guildId);
  entry.lockedChannels = channelIds;
  // locked_channels is JSONB, so it needs an explicit cast — can't go
  // through the generic persistField() helper.
  pool
    .query(
      `INSERT INTO guild_settings (guild_id, locked_channels) VALUES ($1, $2::jsonb)
       ON CONFLICT (guild_id) DO UPDATE SET locked_channels = $2::jsonb`,
      [guildId, JSON.stringify(channelIds)]
    )
    .catch((err) => console.error(`Failed to persist locked_channels for guild ${guildId}:`, err));
}

// ---- Join-rate baseline -------------------------------------------------------

async function getJoinBaseline(guildId) {
  const entry = await loadGuildCache(guildId);
  return entry.joinBaseline;
}

async function setJoinBaseline(guildId, baseline) {
  const entry = await loadGuildCache(guildId);
  entry.joinBaseline = baseline;
  // JSONB, so it needs the same explicit cast as locked_channels.
  pool
    .query(
      `INSERT INTO guild_settings (guild_id, join_baseline) VALUES ($1, $2::jsonb)
       ON CONFLICT (guild_id) DO UPDATE SET join_baseline = $2::jsonb`,
      [guildId, JSON.stringify(baseline)]
    )
    .catch((err) => console.error(`Failed to persist join_baseline for guild ${guildId}:`, err));
}

// ---- Mod log ------------------------------------------------------------------

async function getLogChannelId(guildId) {
  const entry = await loadGuildCache(guildId);
  return entry.logChannelId;
}

async function setLogChannelId(guildId, channelId) {
  const entry = await loadGuildCache(guildId);
  entry.logChannelId = channelId;
  persistField(guildId, 'log_channel_id', channelId);
}

module.exports = {
  init,
  warmRaidProtectCache,
  addMessage,
  addVoiceMs,
  getMemberStats,
  isSecureEnabled,
  setSecureEnabled,
  isAutoModEnabled,
  setAutoModEnabled,
  getLockedChannels,
  setLockedChannels,
  isRaidProtectActive,
  setRaidProtectActive,
  getMinAccountAgeDays,
  setMinAccountAgeDays,
  getJoinBaseline,
  setJoinBaseline,
  getLogChannelId,
  setLogChannelId,
};
