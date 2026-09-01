const store = require('../utils/store');

// userId -> { guildId, since } — in-memory only; a redeploy loses the
// exact join time, but primeVoiceSessions() re-seeds anyone still in a
// channel at startup so ongoing time keeps counting from that point.
const activeSessions = new Map();

function primeVoiceSessions(client) {
  const now = Date.now();
  for (const guild of client.guilds.cache.values()) {
    for (const voiceState of guild.voiceStates.cache.values()) {
      if (voiceState.channelId && voiceState.member && !voiceState.member.user.bot) {
        activeSessions.set(voiceState.member.id, { guildId: guild.id, since: now });
      }
    }
  }
}

function endSession(userId) {
  const session = activeSessions.get(userId);
  if (!session) return;
  const elapsed = Date.now() - session.since;
  if (elapsed > 0) store.addVoiceMs(session.guildId, userId, elapsed);
  activeSessions.delete(userId);
}

function handleVoiceStateUpdate(oldState, newState) {
  const user = newState.member?.user ?? oldState.member?.user;
  if (!user || user.bot) return;

  const userId = user.id;
  const guildId = newState.guild.id;
  const wasIn = Boolean(oldState.channelId);
  const isIn = Boolean(newState.channelId);

  if (!wasIn && isIn) {
    // Joined voice.
    activeSessions.set(userId, { guildId, since: Date.now() });
  } else if (wasIn && !isIn) {
    // Left voice entirely.
    endSession(userId);
  }
  // Switching between channels (wasIn && isIn) falls through — the
  // session keeps running, it's still "in voice" the whole time.
}

module.exports = { handleVoiceStateUpdate, primeVoiceSessions };
