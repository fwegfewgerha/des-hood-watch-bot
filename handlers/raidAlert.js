// Early-warning tier for raids.
//
// handlers/memberJoin.js already auto-locks the server at BURST_JOIN_COUNT
// joins inside BURST_WINDOW_MS — that's the emergency brake. This fires
// below that bar: it never locks, kicks or deletes anything, it just tells
// the mods that the join pattern looks wrong while there's still time to
// decide. Deliberately noisier than the lockdown trigger, because the cost
// of a false alarm here is one embed in the log channel.
//
// Alerts go to the /modlog channel, so with no log channel configured this
// feature is a no-op — same as every other logged event in the bot.

const { EmbedBuilder } = require('discord.js');
const store = require('../utils/store');
const joinBaseline = require('../utils/joinBaseline');
const {
  BURST_JOIN_COUNT,
  BURST_WINDOW_MS,
  DEFAULT_MIN_ACCOUNT_AGE_DAYS,
} = require('../utils/raidThresholds');

const WINDOW_MS = 60_000; // how long a join stays interesting
// Same 10s window the auto-lockdown uses, at half the count — so the alert
// and the lockdown are reading the same burst, and a raid that keeps going
// escalates from one to the other on its own.
const PACE_COUNT = 5; // joins...
const PACE_WINDOW_MS = BURST_WINDOW_MS; // ...within this = suspicious pace
const FRESH_ACCOUNT_MAX_AGE_MS = 48 * 60 * 60 * 1000;
// Three, not two: two day-old accounts joining a minute apart is ordinary
// in a growing server, and firing that early would burn the cooldown on a
// weak signal before the stronger ones (pace, matching names) accumulate.
const FRESH_ACCOUNT_COUNT = 3; // brand-new accounts in the window
const SIMILAR_NAME_COUNT = 3; // joins sharing a name stem
const COOLDOWN_MS = 5 * 60_000; // one alert per guild per this long
const MAX_LISTED = 8; // accounts shown in the embed

const windows = new Map(); // guildId -> [{ id, tag, stem, createdTimestamp, at }]
const lastAlertAt = new Map(); // guildId -> timestamp

const sweep = setInterval(() => {
  const cutoff = Date.now() - WINDOW_MS;
  for (const [guildId, joins] of windows) {
    const kept = joins.filter((j) => j.at >= cutoff);
    if (kept.length) windows.set(guildId, kept);
    else windows.delete(guildId);
  }
}, 5 * 60 * 1000);
if (typeof sweep.unref === 'function') sweep.unref();

// Raid accounts are usually minted from one pattern — "coolguy8821",
// "coolguy4417" — so stripping the random tail leaves a shared stem.
// Names too short to be distinctive are ignored rather than matched.
function nameStem(username) {
  const stem = username.toLowerCase().replace(/[^a-z]/g, '');
  return stem.length >= 4 ? stem.slice(0, 8) : null;
}

function record(guild, member) {
  const now = Date.now();
  const joins = (windows.get(guild.id) ?? []).filter((j) => now - j.at < WINDOW_MS);
  joins.push({
    id: member.id,
    tag: member.user.tag,
    stem: nameStem(member.user.username),
    createdTimestamp: member.user.createdTimestamp,
    at: now,
  });
  windows.set(guild.id, joins);
  return joins;
}

// Returns the human-readable reasons this window looks like a raid, or an
// empty array if it just looks like a busy afternoon. `rate` is the learned
// join-rate verdict from utils/joinBaseline.js, or null if unavailable.
function collectSignals(joins, rate) {
  const now = Date.now();
  const signals = [];

  // The learned signal: how this ten minutes compares to what this server
  // normally does at this time of day. It's the only one that can catch a
  // slow raid — accounts trickling in below the burst threshold — and the
  // only one that stays quiet when a genuine growth spurt makes the fixed
  // thresholds look alarming.
  if (rate?.exceeded) {
    signals.push(
      rate.learned
        ? `**${rate.trailing} joins** in the last 10 minutes — normally about ` +
            `${rate.mean.toFixed(1)} at this time of day (alerting above ${rate.threshold})`
        : `**${rate.trailing} joins** in the last 10 minutes (still learning this server's normal rate)`
    );
  }

  const paced = joins.filter((j) => now - j.at < PACE_WINDOW_MS);
  if (paced.length >= PACE_COUNT) {
    signals.push(`**${paced.length} joins** in the last ${PACE_WINDOW_MS / 1000}s`);
  }

  const fresh = joins.filter((j) => now - j.createdTimestamp < FRESH_ACCOUNT_MAX_AGE_MS);
  if (fresh.length >= FRESH_ACCOUNT_COUNT) {
    signals.push(`**${fresh.length} accounts** created in the last 48h`);
  }

  const stems = new Map();
  for (const j of joins) {
    if (!j.stem) continue;
    stems.set(j.stem, (stems.get(j.stem) ?? 0) + 1);
  }
  for (const [stem, count] of stems) {
    if (count >= SIMILAR_NAME_COUNT) {
      signals.push(`**${count} usernames** starting with \`${stem}\``);
    }
  }

  return signals;
}

async function sendAlert(guild, joins, signals) {
  const channelId = await store.getLogChannelId(guild.id);
  if (!channelId) return;
  const channel = guild.channels.cache.get(channelId);
  if (!channel || !channel.isTextBased()) return;

  const listed = joins
    .slice(-MAX_LISTED)
    .reverse()
    .map((j) => `• ${j.tag} — created <t:${Math.floor(j.createdTimestamp / 1000)}:R>`)
    .join('\n');
  const overflow = joins.length - Math.min(joins.length, MAX_LISTED);

  const embed = new EmbedBuilder()
    .setColor('#e0a63c')
    .setTitle('⚠️ Potential raid')
    .setDescription(
      `${joins.length} account${joins.length === 1 ? '' : 's'} joined in the last minute and the pattern looks off.`
    )
    .addFields(
      { name: 'Why this fired', value: signals.map((s) => `• ${s}`).join('\n') },
      { name: 'Recent joins', value: listed + (overflow > 0 ? `\n…and ${overflow} more` : '') },
      {
        name: 'If this is a raid',
        value:
          `\`/raidprotect on\` locks every text channel and auto-kicks joins with accounts under ${DEFAULT_MIN_ACCOUNT_AGE_DAYS} days old.\n` +
          `Left alone, lockdown triggers on its own at ${BURST_JOIN_COUNT} joins within ${BURST_WINDOW_MS / 1000}s.`,
      }
    )
    .setTimestamp();

  try {
    await channel.send({ embeds: [embed] });
  } catch (err) {
    console.error('Raid alert: failed to send alert:', err.message);
  }
}

// Called for every join. Never throws into the caller's protective path and
// never awaits anything the caller depends on — this is a heads-up, not a
// defence.
async function checkJoinForRaidSignals(member) {
  const guild = member.guild;

  // Recorded before the early return below, so the baseline keeps learning
  // through a lockdown instead of going blind exactly when the numbers are
  // most unusual. joinBaseline clips what it learns from an alarming
  // bucket, so a raid can't teach it that raids are normal here.
  const rate = await joinBaseline
    .noteJoin(guild.id)
    .then(() => joinBaseline.assess(guild.id))
    .catch((err) => {
      console.error('Join baseline unavailable:', err.message);
      return null;
    });

  // Once raid protection is on, the mods already know and every join is
  // being kicked or screened — another alert adds nothing.
  if (await store.isRaidProtectActive(guild.id)) {
    windows.delete(guild.id);
    return false;
  }

  const joins = record(guild, member);
  const signals = collectSignals(joins, rate);
  if (signals.length === 0) return false;

  const now = Date.now();
  if (now - (lastAlertAt.get(guild.id) ?? 0) < COOLDOWN_MS) return false;
  lastAlertAt.set(guild.id, now);

  await sendAlert(guild, joins, signals);
  return true;
}

module.exports = { checkJoinForRaidSignals, nameStem, collectSignals };
