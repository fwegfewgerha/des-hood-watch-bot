const { SlashCommandBuilder, PermissionFlagsBits, ChannelType, MessageFlags } = require('discord.js');
const store = require('../utils/store');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('modlog')
    .setDescription('Set or clear the channel security events get logged to.')
    .addSubcommand((sub) =>
      sub
        .setName('set')
        .setDescription('Set the log channel.')
        .addChannelOption((opt) =>
          opt
            .setName('channel')
            .setDescription('Where to send security event logs')
            .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
            .setRequired(true)
        )
    )
    .addSubcommand((sub) => sub.setName('off').setDescription('Stop logging security events.'))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setDMPermission(false),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();

    if (sub === 'set') {
      const channel = interaction.options.getChannel('channel');
      await store.setLogChannelId(interaction.guild.id, channel.id);
      return interaction.reply({
        content: `Security events will now be logged to ${channel}.`,
        flags: MessageFlags.Ephemeral,
      });
    }

    await store.setLogChannelId(interaction.guild.id, null);
    return interaction.reply({
      content: 'Security event logging is now off.',
      flags: MessageFlags.Ephemeral,
    });
  },
};
