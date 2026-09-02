const { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder, MessageFlags } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('ping')
    .setDescription("Check the bot's latency.")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setDMPermission(false),

  async execute(interaction) {
    // Discord stamps createdTimestamp when it builds the interaction, so this
    // covers the network hop to us plus any time we spent queued behind other
    // work in the event loop. It's the half of the trip our code can affect.
    const inbound = Date.now() - interaction.createdTimestamp;

    await interaction.reply({ content: 'Measuring…', flags: MessageFlags.Ephemeral });
    const reply = await interaction.fetchReply();
    const roundTrip = reply.createdTimestamp - interaction.createdTimestamp;

    // Heartbeat RTT over the gateway websocket, tracked by discord.js. It is
    // -1 until the first heartbeat completes after a (re)connect.
    const heartbeat = Math.round(interaction.client.ws.ping);

    const embed = new EmbedBuilder()
      .setColor('#5865F2')
      .setTitle('Latency')
      .addFields(
        { name: 'Inbound', value: `${inbound}ms`, inline: true },
        { name: 'Round-trip', value: `${roundTrip}ms`, inline: true },
        {
          name: 'Gateway heartbeat',
          value: heartbeat < 0 ? 'Not measured yet' : `${heartbeat}ms`,
          inline: true,
        }
      )
      .setFooter({
        text: 'Inbound: Discord → bot. Round-trip: Discord → bot → Discord. Heartbeat: websocket RTT.',
      });

    await interaction.editReply({ content: '', embeds: [embed] });
  },
};
