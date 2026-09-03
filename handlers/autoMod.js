// Always-on message automod. Unlike the slash commands, this is a passive
// feature: it runs for every member of the server on every message and
// every edit, for as long as the bot is up — there is no ALLOWED_USER_IDS
// gate on it, the same way /secure's invite scanning has none.
//
// The rules it enforces live in utils/automodRules.js.

const { PermissionFlagsBits } = require('discord.js');
const store = require('../utils/store');
const { logEvent } = require('./modLog');
const { RULES, buildContext } = require('../utils/automodRules');

const NOTICE = 'you violated server rules — message deleted.';
const NOTICE_LIFETIME_MS = 6000;

// Spam thresholds. These need memory across messages, so they live here
// rather than in the (stateless) rule table.
const BURST_WINDOW_MS = 7000;
const BURST_LIMIT = 6; // messages within the window
const DUPLICATE_WINDOW_MS = 30000;
const DUPLICATE_LIMIT = 4; // identical messages within the window
const HISTORY_TTL_MS = 60000;

const SPAM_RULES = {
  burst: { id: 'spam_burst', label: 'message flooding', severity: 'low', quoteInLog: false },
  duplicate: { id: 'spam_duplicate', label: 'repeated message spam', severity: 'low', quoteInLog: false },
};

const history = new Map(); // `${guildId}:${userId}` -> [{ at, text }]

// The bot is meant to stay up indefinitely, so the history map can't be
// allowed to keep an entry for every member who ever spoke. Entries age
// out on access, and this sweep catches the ones nobody comes back to.
const sweep = setInterval(() => {
  const cutoff = Date.now() - HISTORY_TTL_MS;
  for (const [key, entries] of history) {
    if (entries.length === 0 || entries[entries.length - 1].at < cutoff) history.delete(key);
  }
}, 5 * 60 * 1000);
if (typeof sweep.unref === 'function') sweep.unref();

// Records this message and reports whether the author is now flooding.
// Applies to everyone, staff included — a mod account posting at spam
// speed is exactly what a compromised mod account looks like.
function trackAndDetectSpam(message, ctx) {
  const key = `${message.guild.id}:${message.author.id}`;
  const now = Date.now();
  const entries = (history.get(key) ?? []).filter((e) => now - e.at < HISTORY_TTL_MS);
  entries.push({ at: now, text: ctx.normalized.trim() });
  history.set(key, entries);

  if (entries.filter((e) => now - e.at < BURST_WINDOW_MS).length >= BURST_LIMIT) {
    return SPAM_RULES.burst;
  }

  const text = ctx.normalized.trim();
  if (text.length >= 3) {
    const dupes = entries.filter((e) => now - e.at < DUPLICATE_WINDOW_MS && e.text === text);
    if (dupes.length >= DUPLICATE_LIMIT) return SPAM_RULES.duplicate;
  }

  return null;
}

// Returns true if the message was deleted, so the caller can skip the
// rest of its message pipeline (stats, invite scanning) for it.
async function handleAutoMod(rawMessage) {
  let message = rawMessage;
  if (message.partial) {
    try {
      message = await message.fetch();
    } catch {
      return false; // deleted or unreadable before we got to it
    }
  }

  if (!message.guild || !message.author || message.author.bot || message.system) return false;
  if (!(await store.isAutoModEnabled(message.guild.id))) return false; // cached — no DB wait

  const ctx = buildContext(message);
  const member = message.member;
  const isStaff = Boolean(
    member &&
      (member.permissions.has(PermissionFlagsBits.Administrator) ||
        member.permissions.has(PermissionFlagsBits.ManageMessages))
  );

  const spamHit = trackAndDetectSpam(message, ctx);

  let hit = RULES.find((rule) => !(isStaff && rule.staffExempt) && rule.test(ctx));
  if (!hit) hit = spamHit;
  if (!hit) return false;

  // The delete is the actual moderation action, so it's awaited and its
  // failure is reported. The notice and the log entry follow it and
  // don't need to finish before this handler returns.
  try {
    await message.delete();
  } catch (err) {
    console.error(`Automod: failed to delete ${hit.id} message:`, err.message);
    logEvent(
      message.guild,
      `⚠️ **Automod could not delete** a message from ${message.author} in ${message.channel} (${hit.label}) — check the bot's Manage Messages permission.`
    ).catch(() => {});
    return false;
  }

  message.channel
    .send(`${message.author}, ${NOTICE}`)
    .then((notice) => setTimeout(() => notice.delete().catch(() => {}), NOTICE_LIFETIME_MS))
    .catch((err) => console.error('Automod: failed to send notice:', err.message));

  let description = `🚫 **Automod** deleted a message from ${message.author} in ${message.channel}\nRule: **${hit.label}**`;
  if (hit.quoteInLog && ctx.raw.trim()) {
    description += `\n\`\`\`\n${ctx.raw.slice(0, 300).replace(/`/g, "'")}\n\`\`\``;
  }
  if (hit.severity === 'critical') {
    // logEvent posts an embed, where a role mention wouldn't actually
    // ping anyone — so this is a flag for whoever reads the log, not an
    // alert. Escalate by hand if you want to be paged for it.
    description +=
      '\n⚠️ Zero-tolerance category under Discord’s own rules — ban the account and report it at dis.gd/report.';
  }
  logEvent(message.guild, description).catch((err) =>
    console.error('Automod: failed to log event:', err.message)
  );

  return true;
}

module.exports = { handleAutoMod };
