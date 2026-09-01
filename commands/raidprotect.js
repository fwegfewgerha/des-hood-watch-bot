const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const store = require('../utils/store');
const { lockAllChannels, unlockAllChannels } = require('../handlers/raidLock');
const { logEvent } = require('../handlers/modLog');

const DEFAULT_MIN_ACCOUNT_AGE_DAYS = 7;

module.exports = {
  data: new SlashCommandBuilder()
    .setName('raidprotect')
    .setDescription('Lock or unlock every text channel in the server.')
    .addSubcommand((sub) =>
      sub
        .setName('on')
        .setDescription('Lock all text channels and start auto-kicking new accounts.')
        .addIntegerOption((opt) =>
          opt
            .setName('min-account-age')
            .setDescription('Auto-kick joins with accounts younger than this many days (default 7).')
            .setMinValue(0)
            .setMaxValue(365)
            .setRequired(false)
        )
    )
    .addSubcommand((sub) => sub.setName('off').setDescription('Unlock channels and stop auto-kicking.'))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setDMPermission(false),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();

    if (sub === 'on') {
      const minAge = interaction.options.getInteger('min-account-age') ?? DEFAULT_MIN_ACCOUNT_AGE_DAYS;

      // Flip these first — before awaiting the (much slower) channel locks —
      // so auto-kick protection is live as soon as these two quick writes
      // land, not whenever every channel finishes getting locked. Run them
      // concurrently since they touch independent columns.
      await Promise.all([
        store.setRaidProtectActive(interaction.guild.id, true),
        store.setMinAccountAgeDays(interaction.guild.id, minAge),
      ]);

      await interaction.deferReply();
      const { locked, failed } = await lockAllChannels(interaction.guild);

      const summary =
        `🔒 Locked ${locked.length} channel${locked.length === 1 ? '' : 's'}. ` +
        `New joins with accounts under ${minAge} day${minAge === 1 ? '' : 's'} old will be auto-kicked.` +
        (failed ? ` Couldn't lock ${failed} (missing permissions there).` : '');

      await interaction.editReply(summary);
      await logEvent(
        interaction.guild,
        `🔒 **Raid protection enabled** by ${interaction.user} — locked ${locked.length} channels, auto-kick threshold ${minAge}d.`
      );
      return;
    }

    // sub === 'off'
    await interaction.deferReply();
    const { unlocked, failed } = await unlockAllChannels(interaction.guild);

    const summary =
      `🔓 Unlocked ${unlocked} channel${unlocked === 1 ? '' : 's'}.` +
      (failed ? ` Couldn't unlock ${failed}.` : '');

    await interaction.editReply(summary);
    await logEvent(
      interaction.guild,
      `🔓 **Raid protection disabled** by ${interaction.user} — unlocked ${unlocked} channels.`
    );
  },
};
