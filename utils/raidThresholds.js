// Thresholds for the auto-lockdown in handlers/memberJoin.js.
//
// They live here rather than in memberJoin.js because handlers/raidAlert.js
// needs them too — its alert tells mods what will happen if they do nothing,
// and that sentence has to stay true when these numbers change. memberJoin.js
// already imports raidAlert.js, so importing back the other way would be a
// cycle; a shared constants module avoids it.

module.exports = {
  BURST_JOIN_COUNT: 10, // this many joins...
  BURST_WINDOW_MS: 10_000, // ...within this many ms triggers auto-lockdown
  DEFAULT_MIN_ACCOUNT_AGE_DAYS: 7, // auto-kick accounts younger than this
};
