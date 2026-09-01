const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');
const store = require('../utils/store');
const { logEvent } = require('../handlers/modLog');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('secure')
    .setDescription('Auto-delete Discord invite links posted by regular members.')
    .addSubcommand((sub) => sub.setName('on').setDescription('Turn invite-link auto-delete on.'))
    .addSubcommand((sub) => sub.setName('off').setDescription('Turn invite-link auto-delete off.'))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setDMPermission(false),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    const enabled = sub === 'on';
    await store.setSecureEnabled(interaction.guild.id, enabled);

    await interaction.reply({
      content: enabled
        ? '🛡️ Invite-link auto-delete is now **on**. Admins and members with Manage Messages are exempt.'
        : 'Invite-link auto-delete is now **off**.',
      flags: MessageFlags.Ephemeral,
    });

    await logEvent(
      interaction.guild,
      enabled
        ? `🛡️ **Secure enabled** by ${interaction.user} — invite links from regular members will be auto-deleted.`
        : `**Secure disabled** by ${interaction.user}.`
    );
  },
};
