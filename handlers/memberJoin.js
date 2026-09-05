const store = require('../utils/store');
const { isAllowedUser } = require('../utils/allowlist');
const { lockAllChannels } = require('./raidLock');
const { checkJoinForRaidSignals } = require('./raidAlert');
const { logEvent } = require('./modLog');

const {
  BURST_JOIN_COUNT,
  BURST_WINDOW_MS,
  DEFAULT_MIN_ACCOUNT_AGE_DAYS,
} = require('../utils/raidThresholds');

// guildId -> [{ member, time }] for joins in the current rolling window.
// In-memory only — losing this on a restart just means the burst window
// restarts empty, which is harmless.
const recentJoins = new Map();

function recordJoin(guildId, member) {
  const now = Date.now();
  const existing = recentJoins.get(guildId) || [];
  const recent = existing.filter((j) => now - j.time <= BURST_WINDOW_MS);
  recent.push({ member, time: now });
  recentJoins.set(guildId, recent);
  return recent;
}

// Kicks a single member if their account is younger than the threshold.
// Kicking is one fast API call — unlike channel locking, there's no need
// to run this in the background to keep things snappy.
async function kickIfUnderAge(member, minAgeDays, guild) {
  const accountAgeMs = Date.now() - member.user.createdTimestamp;
  if (accountAgeMs >= minAgeDays * 24 * 60 * 60 * 1000) return false;

  try {
    await member.kick(`Raid protection: account younger than ${minAgeDays} day(s).`);
    await logEvent(
      guild,
      `👢 Auto-kicked ${member.user.tag} (${member.id}) — account created <t:${Math.floor(
        member.user.createdTimestamp / 1000
      )}:R>, under the ${minAgeDays}-day threshold.`
    );
    return true;
  } catch (err) {
    console.error('Auto-kick failed:', err.message);
    return false;
  }
}

async function handleGuildMemberAdd(member) {
  if (member.user.bot) return;
  // Whitelisted users are exempt from the whole join path: never
  // auto-kicked over account age, and never counted toward the burst
  // window or the raid alert — someone on the operator list rejoining
  // isn't evidence of anything.
  if (isAllowedUser(member.id)) return;
  const guild = member.guild;

  // Early warning, on a lower threshold than the auto-lockdown below.
  // Fired without await for the same reason logEvent is: an alert to the
  // mod-log must never delay a kick or a lockdown.
  checkJoinForRaidSignals(member).catch((err) => console.error('Raid alert failed:', err.message));

  if (!(await store.isRaidProtectActive(guild.id))) {
    const recent = recordJoin(guild.id, member);
    if (recent.length < BURST_JOIN_COUNT) return; // not a burst (yet)

    // Burst detected. Flip the flag first — the in-memory cache inside
    // store.js makes this effectively instant (no waiting on the Postgres
    // write), so every join event from this point forward, including ones
    // arriving while we're still processing this one, sees
    // raidProtectActive=true immediately and gets auto-kick-checked.
    await Promise.all([
      store.setRaidProtectActive(guild.id, true),
      store.setMinAccountAgeDays(guild.id, DEFAULT_MIN_ACCOUNT_AGE_DAYS),
    ]);
    recentJoins.delete(guild.id);

    // Lock channels in the background. This is the slow part — it scales
    // with channel count — so it must not block the kicks below.
    lockAllChannels(guild)
      .then(({ locked, failed }) =>
        logEvent(
          guild,
          `⚠️ **Raid protection auto-triggered** — ${BURST_JOIN_COUNT}+ joins within ${BURST_WINDOW_MS / 1000}s. ` +
            `Locked ${locked.length} channel${locked.length === 1 ? '' : 's'}${failed ? `, ${failed} failed` : ''}. ` +
            `New joins are being auto-kicked (accounts under ${DEFAULT_MIN_ACCOUNT_AGE_DAYS}d old) until \`/raidprotect off\`.`
        )
      )
      .catch((err) => console.error('Auto-lockdown failed:', err));

    // Retroactively check every join that made up the burst, not just the
    // one that tripped the threshold — they're all equally suspicious.
    // Kicking is fast, so this is awaited rather than backgrounded.
    await Promise.allSettled(
      recent.map((j) => kickIfUnderAge(j.member, DEFAULT_MIN_ACCOUNT_AGE_DAYS, guild))
    );
    return;
  }

  // Raid protection already active — evaluate this single join normally.
  const minAgeDays = (await store.getMinAccountAgeDays(guild.id)) ?? DEFAULT_MIN_ACCOUNT_AGE_DAYS;
  await kickIfUnderAge(member, minAgeDays, guild);
}

module.exports = { handleGuildMemberAdd, BURST_JOIN_COUNT, BURST_WINDOW_MS, DEFAULT_MIN_ACCOUNT_AGE_DAYS };
