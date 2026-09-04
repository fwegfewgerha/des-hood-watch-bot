// Deleting a flagged message is the one part of automod and /secure that
// has to actually land, and the two ways it fails need opposite handling:
//
//   - The message is already gone — a mod got to it first, or the
//     messageCreate and messageUpdate paths raced each other over the same
//     message. Nothing is wrong and nothing is left to do, so warning
//     about it just puts noise in the mod log.
//   - The call failed in transit (a Discord connect timeout, a 5xx). The
//     message is still up, and the only thing keeping it up is a blip that
//     a second attempt usually clears.
//
// So this retries the transient case with a short backoff and reports the
// three outcomes separately, instead of collapsing them into one catch.

const { RESTJSONErrorCodes } = require('discord.js');

const DELETED = 'deleted';
const ALREADY_GONE = 'already_gone';
const FAILED = 'failed';

const RETRY_DELAYS_MS = [500, 1500];
const DELETE_ATTEMPTS = RETRY_DELAYS_MS.length + 1;

// The message (or the channel holding it) no longer exists, so there is
// nothing left to delete.
const GONE_CODES = new Set([
  RESTJSONErrorCodes.UnknownMessage,
  RESTJSONErrorCodes.UnknownChannel,
]);

// A 4xx from Discord is a refusal — missing permissions, a malformed
// request — and it will be refused again just as fast, so retrying only
// delays the mod-log warning. Anything else is worth another go: a 5xx, a
// 429, or no status at all, which is the shape of the undici network
// errors (connect timeouts, resets) that never reached Discord.
function isTransient(err) {
  const status = err?.status;
  return typeof status !== 'number' || status >= 500 || status === 429;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Returns { status, error?, permanent? }. Callers are expected to treat
// ALREADY_GONE as a success that needs no follow-up: whoever deleted the
// message first has already posted whatever notice goes with it.
async function deleteMessageWithRetry(message) {
  for (let attempt = 0; ; attempt++) {
    try {
      await message.delete();
      return { status: DELETED };
    } catch (err) {
      if (GONE_CODES.has(err?.code)) return { status: ALREADY_GONE };

      const transient = isTransient(err);
      if (!transient || attempt >= RETRY_DELAYS_MS.length) {
        return { status: FAILED, error: err, permanent: !transient };
      }
      await sleep(RETRY_DELAYS_MS[attempt]);
    }
  }
}

module.exports = {
  deleteMessageWithRetry,
  DELETED,
  ALREADY_GONE,
  FAILED,
  DELETE_ATTEMPTS,
};
