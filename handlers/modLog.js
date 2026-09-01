const { EmbedBuilder } = require('discord.js');
const store = require('../utils/store');

async function logEvent(guild, description) {
  const channelId = store.getLogChannelId(guild.id);
  if (!channelId) return;

  const channel = guild.channels.cache.get(channelId);
  if (!channel || !channel.isTextBased()) return;

  const embed = new EmbedBuilder().setColor('#6fcbd9').setDescription(description).setTimestamp();

  try {
    await channel.send({ embeds: [embed] });
  } catch (err) {
    console.error('Mod-log: failed to send log message:', err.message);
  }
}

module.exports = { logEvent };
