const store = require('../utils/store');
const { logEvent } = require('./modLog');

// Matches discord.gg/xxx, discord.com/invite/xxx, discordapp.com/invite/xxx,
// with or without a protocol/www prefix.
const INVITE_RE = /(?:https?:\/\/)?(?:www\.)?(?:discord\.gg|discord(?:app)?\.com\/invite)\/[a-zA-Z0-9-]+/i;

async function handleMessageCreate(message) {
  if (!message.guild || message.author.bot) return;

  // Stats tracking doesn't gate anything below it, so it shouldn't make
  // every message in a busy channel wait on a database write before the
  // security check even runs. Fire it and move on.
  store.addMessage(message.guild.id, message.author.id).catch((err) =>
    console.error('Failed to record message stats:', err)
  );

  if (!(await store.isSecureEnabled(message.guild.id))) return; // cached — no DB wait
  if (!INVITE_RE.test(message.content)) return;

  // Staff are exempt — the goal is catching compromised/spam accounts,
  // not blocking mods from sharing a partner server's invite.
  const member = message.member;
  const isExempt = member && (
    member.permissions.has('Administrator') || member.permissions.has('ManageMessages')
  );
  if (isExempt) return;

  // The delete is the actual protective action — it's awaited so a
  // failure is caught and reported. Everything after it (the notice, the
  // mod-log entry) doesn't need to finish before this handler returns.
  try {
    await message.delete();
  } catch (err) {
    console.error('Secure: failed to delete invite message:', err.message);
    return;
  }

  message.channel
    .send(`${message.author}, links to other servers aren't allowed here.`)
    .then((notice) => setTimeout(() => notice.delete().catch(() => {}), 5000))
    .catch((err) => console.error('Secure: failed to send notice:', err.message));

  logEvent(
    message.guild,
    `🗑️ Deleted an invite link from ${message.author} in ${message.channel}.`
  ).catch((err) => console.error('Secure: failed to log event:', err.message));
}

module.exports = { handleMessageCreate, INVITE_RE };
