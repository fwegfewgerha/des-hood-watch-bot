const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags, EmbedBuilder } = require('discord.js');
const store = require('../utils/store');
const { logEvent } = require('../handlers/modLog');
const { RULES } = require('../utils/automodRules');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('automod')
    .setDescription('Always-on filtering of content Discord’s rules prohibit.')
    .addSubcommand((sub) => sub.setName('on').setDescription('Turn automod on (it is on by default).'))
    .addSubcommand((sub) => sub.setName('off').setDescription('Turn automod off.'))
    .addSubcommand((sub) => sub.setName('status').setDescription('Show whether automod is on and what it filters.'))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setDMPermission(false),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();

    if (sub === 'status') {
      const enabled = await store.isAutoModEnabled(interaction.guild.id);
      const embed = new EmbedBuilder()
        .setColor(enabled ? '#6fcbd9' : '#8b8b8b')
        .setTitle(`Automod is ${enabled ? 'on' : 'off'}`)
        .setDescription(
          [
            'Runs on every message and every edit, from every member, for as long as the bot is online.',
            '',
            '**Categories filtered**',
            ...RULES.map((rule) => `• ${rule.label}${rule.staffExempt ? ' *(staff exempt)*' : ''}`),
            '• message flooding and repeated message spam',
            '',
            'Violations are deleted with a short public notice, and logged to the `/modlog` channel if one is set.',
          ].join('\n')
        );
      return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    }

    const enabled = sub === 'on';
    await store.setAutoModEnabled(interaction.guild.id, enabled);

    await interaction.reply({
      content: enabled
        ? '🛡️ Automod is now **on** — messages breaking Discord’s rules will be deleted automatically.'
        : '⚠️ Automod is now **off**. Nothing will be filtered until you run `/automod on`.',
      flags: MessageFlags.Ephemeral,
    });

    await logEvent(
      interaction.guild,
      enabled
        ? `🛡️ **Automod enabled** by ${interaction.user}.`
        : `⚠️ **Automod disabled** by ${interaction.user}.`
    );
  },
};
