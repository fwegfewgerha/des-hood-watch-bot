// Keeps the bot's Discord presence showing the live player count of the
// Roblox game in ROBLOX_PLACE_ID.
//
// Two public Roblox endpoints, neither authenticated: a place ID maps to a
// universe ID once (that mapping never changes, so it's resolved lazily and
// cached for the process), and the universe's live player count comes from
// the games list. Nothing here touches the Open Cloud key or the account
// cookie — this is all public data.
//
// The presence is only pushed when the text actually changes. A game
// sitting at the same count for an hour should cost one gateway write, not
// sixty, and Discord rate-limits presence updates far more tightly than
// this polls.

const { ActivityType } = require('discord.js');

const UNIVERSE_LOOKUP = 'https://apis.roblox.com/universes/v1/places';
const GAMES = 'https://games.roblox.com/v1/games';

const POLL_INTERVAL_MS = 60 * 1000;
const REQUEST_TIMEOUT_MS = 10000;

// How many polls in a row may fail before the status stops quoting a number
// it can no longer confirm. Roblox blips for a minute fairly often, and
// flapping the presence on every blip is worse than riding it out — but a
// count that's been unreachable for five minutes shouldn't still be
// presented as current.
const STALE_AFTER_FAILURES = 5;

// Discord caps an activity name at 128 characters.
const MAX_ACTIVITY_LENGTH = 128;

let universeId = null;
let lastActivity = null;
let lastGameName = null;
let consecutiveFailures = 0;
let loggedFailure = false;

async function fetchJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`${url} returned ${res.status}`);
  return res.json();
}

async function resolveUniverseId(placeId) {
  if (universeId) return universeId;

  const data = await fetchJson(`${UNIVERSE_LOOKUP}/${placeId}/universe`);
  if (!data?.universeId) throw new Error(`no universe for place ${placeId}`);

  universeId = data.universeId;
  return universeId;
}

// { playing, name } for the configured place.
async function readPlayerCount(placeId) {
  const universe = await resolveUniverseId(placeId);
  const data = await fetchJson(`${GAMES}?universeIds=${universe}`);

  const game = data?.data?.[0];
  if (!game) throw new Error(`no game data for universe ${universe}`);

  return { playing: game.playing ?? 0, name: game.name };
}

function buildActivity(playing, gameName) {
  const label = `${playing} player${playing === 1 ? '' : 's'} · `;
  const room = MAX_ACTIVITY_LENGTH - label.length;
  const name = gameName.length > room ? `${gameName.slice(0, room - 1)}…` : gameName;
  return `${label}${name}`;
}

function apply(client, text) {
  if (text === lastActivity) return;

  client.user.setPresence({
    status: 'online',
    activities: [{ name: text, type: ActivityType.Watching }],
  });
  lastActivity = text;
}

async function poll(client, placeId) {
  try {
    const { playing, name } = await readPlayerCount(placeId);

    lastGameName = name;
    consecutiveFailures = 0;
    if (loggedFailure) {
      console.log('CCU watch: Roblox reachable again.');
      loggedFailure = false;
    }

    apply(client, buildActivity(playing, name));
  } catch (err) {
    consecutiveFailures++;

    // One line when it breaks and one when it recovers — not one a minute
    // for however long Roblox is having a bad day.
    if (!loggedFailure) {
      console.error('CCU watch: failed to read the player count:', err.message);
      loggedFailure = true;
    }

    // Keep showing the last known count through a short blip; past that,
    // drop the number rather than keep asserting one we can't confirm.
    if (consecutiveFailures >= STALE_AFTER_FAILURES && lastGameName) {
      apply(client, lastGameName.slice(0, MAX_ACTIVITY_LENGTH));
    }
  }
}

function startCcuWatch(client) {
  const placeId = process.env.ROBLOX_PLACE_ID;
  if (!placeId) {
    console.log('CCU watch: ROBLOX_PLACE_ID is not set — leaving the bot presence alone.');
    return null;
  }

  poll(client, placeId);
  const timer = setInterval(() => poll(client, placeId), POLL_INTERVAL_MS);
  if (typeof timer.unref === 'function') timer.unref();
  return timer;
}

module.exports = { startCcuWatch, readPlayerCount, buildActivity };
