// The ALLOWED_USER_IDS whitelist, in one place.
//
// It started as the interaction gate in index.js — who may *use* the bot —
// and is now also the exemption list for the passive features: whitelisted
// users aren't automodded, aren't caught by /secure's invite scanning, and
// aren't auto-kicked or counted as raid signal on join. The people trusted
// to run lockdowns and ban members shouldn't be moderated by their own bot.
//
// index.js is responsible for refusing to start when the variable is unset;
// this module just parses whatever is there, so requiring it can never
// throw out from under that check.
const ALLOWED_USER_IDS = new Set(
  (process.env.ALLOWED_USER_IDS ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean)
);

function isAllowedUser(userId) {
  return ALLOWED_USER_IDS.has(userId);
}

module.exports = { ALLOWED_USER_IDS, isAllowedUser };
