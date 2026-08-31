// Parses a Discord message link like:
// https://discord.com/channels/<guildId>/<channelId>/<messageId>
// Returns null if it doesn't match.
function parseMessageUrl(url) {
  if (!url) return null;
  const match = url
    .trim()
    .match(/discord(?:app)?\.com\/channels\/(\d+)\/(\d+)\/(\d+)/);
  if (!match) return null;
  const [, guildId, channelId, messageId] = match;
  return { guildId, channelId, messageId };
}

module.exports = { parseMessageUrl };
