// Simple JSON-file persistence for per-guild stats and security settings.
// Lives at DATA_DIR/store.json (DATA_DIR defaults to ./data next to the code).
//
// IMPORTANT: Railway's container filesystem is wiped on every redeploy
// unless DATA_DIR points at a mounted Volume. Without a Volume, message
// counts, voice time, and raidprotect/secure settings all reset to zero
// the next time new code is pushed. See README for the one-time setup.

const fs = require('node:fs');
const path = require('node:path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const STORE_PATH = path.join(DATA_DIR, 'store.json');
const FLUSH_INTERVAL_MS = 10_000;

let data = { guilds: {} };
let dirty = false;

function load() {
  try {
    const raw = fs.readFileSync(STORE_PATH, 'utf8');
    data = JSON.parse(raw);
    if (!data.guilds) data.guilds = {};
  } catch {
    data = { guilds: {} };
  }
}

function flush() {
  if (!dirty) return;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(STORE_PATH, JSON.stringify(data), 'utf8');
    dirty = false;
  } catch (err) {
    console.error('Failed to write store.json:', err.message);
  }
}

function markDirty() {
  dirty = true;
}

function guild(guildId) {
  if (!data.guilds[guildId]) {
    data.guilds[guildId] = {
      members: {},
      secureEnabled: false,
      lockedChannels: [],
      raidProtectActive: false,
      minAccountAgeDays: null,
      logChannelId: null,
    };
  }
  return data.guilds[guildId];
}

function member(guildId, userId) {
  const g = guild(guildId);
  if (!g.members[userId]) {
    g.members[userId] = { messages: 0, voiceMs: 0 };
  }
  return g.members[userId];
}

function addMessage(guildId, userId) {
  member(guildId, userId).messages += 1;
  markDirty();
}

function addVoiceMs(guildId, userId, ms) {
  member(guildId, userId).voiceMs += ms;
  markDirty();
}

function getMemberStats(guildId, userId) {
  const m = member(guildId, userId);
  return { messages: m.messages, voiceMs: m.voiceMs };
}

function isSecureEnabled(guildId) {
  return guild(guildId).secureEnabled;
}

function setSecureEnabled(guildId, enabled) {
  guild(guildId).secureEnabled = enabled;
  markDirty();
}

function getLockedChannels(guildId) {
  return guild(guildId).lockedChannels;
}

function setLockedChannels(guildId, channelIds) {
  guild(guildId).lockedChannels = channelIds;
  markDirty();
}

function isRaidProtectActive(guildId) {
  return guild(guildId).raidProtectActive;
}

function setRaidProtectActive(guildId, active) {
  guild(guildId).raidProtectActive = active;
  markDirty();
}

function getMinAccountAgeDays(guildId) {
  return guild(guildId).minAccountAgeDays;
}

function setMinAccountAgeDays(guildId, days) {
  guild(guildId).minAccountAgeDays = days;
  markDirty();
}

function getLogChannelId(guildId) {
  return guild(guildId).logChannelId;
}

function setLogChannelId(guildId, channelId) {
  guild(guildId).logChannelId = channelId;
  markDirty();
}

load();
// unref() so this timer alone never keeps the process alive — the bot's
// gateway connection already does that.
setInterval(flush, FLUSH_INTERVAL_MS).unref();
process.on('SIGTERM', () => { flush(); process.exit(0); });
process.on('SIGINT', () => { flush(); process.exit(0); });

module.exports = {
  addMessage,
  addVoiceMs,
  getMemberStats,
  isSecureEnabled,
  setSecureEnabled,
  getLockedChannels,
  setLockedChannels,
  isRaidProtectActive,
  setRaidProtectActive,
  getMinAccountAgeDays,
  setMinAccountAgeDays,
  getLogChannelId,
  setLogChannelId,
  flush,
};
