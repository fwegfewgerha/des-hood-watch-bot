const store = require('../utils/store');
const { logEvent } = require('./modLog');

// Matches discord.gg/xxx, discord.com/invite/xxx, discordapp.com/invite/xxx,
// with or without a protocol/www prefix.
const INVITE_RE = /(?:https?:\/\/)?(?:www\.)?(?:discord\.gg|discord(?:app)?\.com\/invite)\/[a-zA-Z0-9-]+/i;

async function handleMessageCreate(message) {
  if (!message.guild || message.author.bot) return;

  // Stats tracking — every human message in a guild counts, regardless
  // of whether /secure is on.
  store.addMessage(message.guild.id, message.author.id);

  if (!store.isSecureEnabled(message.guild.id)) return;
  if (!INVITE_RE.test(message.content)) return;

  // Staff are exempt — the goal is catching compromised/spam accounts,
  // not blocking mods from sharing a partner server's invite.
  const member = message.member;
  const isExempt = member && (
    member.permissions.has('Administrator') || member.permissions.has('ManageMessages')
  );
  if (isExempt) return;

  try {
    await message.delete();
    const notice = await message.channel.send(
      `${message.author}, links to other servers aren't allowed here.`
    );
    setTimeout(() => notice.delete().catch(() => {}), 5000);
    await logEvent(
      message.guild,
      `🗑️ Deleted an invite link from ${message.author} in ${message.channel}.`
    );
  } catch (err) {
    console.error('Secure: failed to delete invite message:', err.message);
  }
}

module.exports = { handleMessageCreate, INVITE_RE };
