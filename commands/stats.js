const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const store = require('../utils/store');

function formatDuration(ms) {
  const totalMinutes = Math.floor(ms / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0 && minutes === 0) return 'Less than a minute';
  const parts = [];
  if (hours > 0) parts.push(`${hours}h`);
  parts.push(`${minutes}m`);
  return parts.join(' ');
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('stats')
    .setDescription("View a member's server stats.")
    .addUserOption((opt) =>
      opt.setName('user').setDescription('Whose stats to view (defaults to you)').setRequired(false)
    )
    .setDMPermission(false),

  async execute(interaction) {
    const target = interaction.options.getUser('user') || interaction.user;
    // Cache hit is the common case (the member usually already showed up via
    // a message/voice/join event) and skips a REST round-trip entirely.
    const member =
      interaction.guild.members.cache.get(target.id) ??
      (await interaction.guild.members.fetch(target.id).catch(() => null));

    if (!member) {
      return interaction.reply({
        content: 'That member is no longer in this server.',
        flags: MessageFlags.Ephemeral,
      });
    }

    const stats = await store.getMemberStats(interaction.guild.id, target.id);
    const isMuted = Boolean(member.communicationDisabledUntil) && member.communicationDisabledUntil > new Date();

    const embed = new EmbedBuilder()
      .setColor('#5865F2')
      .setAuthor({ name: target.tag, iconURL: target.displayAvatarURL() })
      .addFields(
        { name: 'Messages sent', value: String(stats.messages), inline: true },
        { name: 'Voice time', value: formatDuration(stats.voiceMs), inline: true },
        {
          name: 'Muted',
          value: isMuted
            ? `Yes, until <t:${Math.floor(member.communicationDisabledUntil.getTime() / 1000)}:R>`
            : 'No',
          inline: true,
        }
      )
      .setFooter({ text: "Counts since the bot started tracking — not full server history." });

    await interaction.reply({ embeds: [embed] });
  },
};
