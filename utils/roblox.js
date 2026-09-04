// Roblox group control, used by /group.
//
// This talks to two different Roblox APIs, because Roblox currently only
// covers half of what a ranking bot needs in the modern one:
//
//   - Ranking (read roles, read a membership, change a rank) goes through
//     Open Cloud at apis.roblox.com/cloud/v2, authenticated with an
//     x-api-key. This is the supported path and the safer credential: the
//     key is scoped to group:read + group:write, can be IP-restricted, and
//     can be revoked without touching the account that owns it.
//   - Kicking and banning have no Open Cloud equivalent, so they use the
//     legacy groups.roblox.com/v1 routes, which authenticate with the
//     account's .ROBLOSECURITY cookie. That cookie *is* the whole Roblox
//     account, so it is deliberately optional here: leave ROBLOX_COOKIE
//     unset and ranking still works, while /group kick and /group ban say
//     they are unconfigured instead of failing cryptically.
//
// Roblox's own permission model still applies on top of all of this — an
// API key cannot rank anyone at or above its owner's rank, and the cookie
// account cannot kick or ban someone ranked above it.

const OPEN_CLOUD = 'https://apis.roblox.com/cloud/v2';
const LEGACY_GROUPS = 'https://groups.roblox.com/v1';
const USERS = 'https://users.roblox.com/v1';

const REQUEST_TIMEOUT_MS = 10000;
const ROLE_CACHE_TTL_MS = 5 * 60 * 1000;

// Failures that are the operator's to fix (a bad username, a rank ceiling,
// a missing credential) rather than a bug. The command layer shows
// `message` to the user as-is; anything else gets a generic reply and a
// stack trace in the logs.
class RobloxError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RobloxError';
    this.expected = true;
  }
}

const groupId = () => process.env.ROBLOX_GROUP_ID;

function requireRankingConfig() {
  if (!groupId() || !process.env.ROBLOX_API_KEY) {
    throw new RobloxError(
      'Roblox ranking is not configured. Set `ROBLOX_GROUP_ID` and `ROBLOX_API_KEY` (an Open Cloud key ' +
        'with the **group:read** and **group:write** permissions) and restart the bot.'
    );
  }
}

function requireCookieConfig(action) {
  if (!groupId() || !process.env.ROBLOX_COOKIE) {
    throw new RobloxError(
      `Roblox ${action} is not configured. It has no Open Cloud equivalent, so it needs \`ROBLOX_COOKIE\` ` +
        '(the `.ROBLOSECURITY` cookie of an account holding that permission in the group) on top of ' +
        '`ROBLOX_GROUP_ID`.'
    );
  }
}

function isRankingConfigured() {
  return Boolean(groupId() && process.env.ROBLOX_API_KEY);
}

function isCookieConfigured() {
  return Boolean(groupId() && process.env.ROBLOX_COOKIE);
}

async function readBody(res) {
  const text = await res.text().catch(() => '');
  try {
    return { json: JSON.parse(text), text };
  } catch {
    return { json: null, text };
  }
}

function unreachable(err) {
  return new RobloxError(
    `Could not reach Roblox (${err.name === 'TimeoutError' ? 'timed out' : err.message}).`
  );
}

// Roblox rate limits are per-route and were tightened recently, so a 429 is
// a normal thing to hit rather than an edge case — it gets its own message
// with the wait time instead of being lumped in with real errors.
function rateLimitError(res) {
  const retryAfter = Number(res.headers.get('retry-after'));
  const wait =
    Number.isFinite(retryAfter) && retryAfter > 0 ? ` — try again in ${retryAfter}s` : ' — try again shortly';
  return new RobloxError(`Roblox is rate-limiting this bot${wait}.`);
}

async function cloudRequest(method, path, body) {
  requireRankingConfig();

  let res;
  try {
    res = await fetch(`${OPEN_CLOUD}${path}`, {
      method,
      headers: {
        'x-api-key': process.env.ROBLOX_API_KEY,
        'Content-Type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    throw unreachable(err);
  }

  if (res.ok) return (await readBody(res)).json;
  if (res.status === 429) throw rateLimitError(res);

  const { json, text } = await readBody(res);
  const detail = json?.message || text.slice(0, 200);

  if (res.status === 401 || res.status === 403) {
    throw new RobloxError(
      'Roblox rejected the API key. Check that `ROBLOX_API_KEY` is valid, has the **group:read** and ' +
        '**group:write** permissions for this group, and that the bot host is allowed by the key’s IP list.'
    );
  }
  if (res.status === 400) {
    // Open Cloud answers almost every bad rank change with a flat "the
    // request was invalid", so the likely causes are worth spelling out
    // rather than passing that straight through.
    throw new RobloxError(
      `Roblox rejected the request${detail ? ` (${detail})` : ''}. The usual causes are the target already ` +
        'holding that role, or the API key owner being ranked at or below the role being assigned — Roblox ' +
        'will not let an account rank anyone to its own level or above.'
    );
  }
  const err = new RobloxError(`Roblox returned ${res.status}${detail ? ` — ${detail}` : ''}.`);
  err.status = res.status;
  throw err;
}

// The legacy routes want a CSRF token you can only obtain by making a
// request without one and reading it off the 403. The token stays valid
// for many requests, so it is cached and only refetched when rejected.
let csrfToken = null;

async function legacyRequest(method, path, body, { retriedCsrf = false } = {}) {
  let res;
  try {
    res = await fetch(`${LEGACY_GROUPS}${path}`, {
      method,
      headers: {
        Cookie: `.ROBLOSECURITY=${process.env.ROBLOX_COOKIE}`,
        'Content-Type': 'application/json',
        ...(csrfToken ? { 'x-csrf-token': csrfToken } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    throw unreachable(err);
  }

  const freshToken = res.headers.get('x-csrf-token');
  if (res.status === 403 && freshToken && !retriedCsrf) {
    csrfToken = freshToken;
    return legacyRequest(method, path, body, { retriedCsrf: true });
  }
  if (freshToken) csrfToken = freshToken;

  if (res.ok) return (await readBody(res)).json;
  if (res.status === 429) throw rateLimitError(res);

  const { json, text } = await readBody(res);
  const detail = json?.errors?.[0]?.message || text.slice(0, 200);

  if (res.status === 401) {
    throw new RobloxError(
      'Roblox rejected the account cookie. `ROBLOX_COOKIE` has expired or been invalidated — logging that ' +
        'account out anywhere, or changing its password, kills the cookie. Set a fresh one and restart.'
    );
  }
  if (res.status === 403) {
    throw new RobloxError(
      `Roblox refused that action${detail ? ` (${detail})` : ''}. The cookie account needs the matching group ` +
        'permission, and cannot act on someone ranked at or above itself.'
    );
  }
  throw new RobloxError(`Roblox returned ${res.status}${detail ? ` — ${detail}` : ''}.`);
}

// Accepts a username or a numeric user ID, returns { id, name, displayName }.
async function resolveUser(input) {
  const query = String(input ?? '').trim();
  if (!query) throw new RobloxError('Give a Roblox username or user ID.');

  let res;
  try {
    if (/^\d+$/.test(query)) {
      res = await fetch(`${USERS}/users/${query}`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (res.status === 404) throw new RobloxError(`No Roblox user has the ID \`${query}\`.`);
      if (!res.ok) throw new RobloxError(`Roblox user lookup failed (${res.status}).`);
      const user = (await readBody(res)).json;
      return { id: user.id, name: user.name, displayName: user.displayName };
    }

    res = await fetch(`${USERS}/usernames/users`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ usernames: [query], excludeBannedUsers: false }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    if (err instanceof RobloxError) throw err;
    throw unreachable(err);
  }

  if (!res.ok) throw new RobloxError(`Roblox username lookup failed (${res.status}).`);
  const match = (await readBody(res)).json?.data?.[0];
  if (!match) throw new RobloxError(`No Roblox user is named \`${query}\`.`);
  return { id: match.id, name: match.name, displayName: match.displayName };
}

// Roles change rarely and every rank command needs them, so they are cached
// briefly rather than refetched per command. Sorted lowest rank first.
let roleCache = { at: 0, roles: null, groupId: null };

async function listRoles({ force = false } = {}) {
  const gid = groupId();
  const fresh = roleCache.roles && roleCache.groupId === gid && Date.now() - roleCache.at < ROLE_CACHE_TTL_MS;
  if (fresh && !force) return roleCache.roles;

  const data = await cloudRequest('GET', `/groups/${gid}/roles?maxPageSize=100`);
  const roles = (data?.groupRoles ?? [])
    .map((role) => ({
      // `path` is "groups/<gid>/roles/<roleId>". That id is what a rank
      // change needs, and it is not the same number as `rank`.
      id: role.id ?? String(role.path ?? '').split('/').pop(),
      name: role.displayName,
      rank: role.rank,
      memberCount: role.memberCount,
    }))
    // Rank 0 is Guest — held by everyone who is *not* in the group, and
    // not assignable, so it has no business in a rank picker.
    .filter((role) => role.rank > 0 && role.id)
    .sort((a, b) => a.rank - b.rank);

  roleCache = { at: Date.now(), roles, groupId: gid };
  return roles;
}

// Returns { membershipId, roleId } for a group member, or null if the user
// is not in the group.
async function getMembership(userId) {
  const filter = encodeURIComponent(`user == 'users/${userId}'`);
  const data = await cloudRequest(
    'GET',
    `/groups/${groupId()}/memberships?maxPageSize=1&filter=${filter}`
  );

  const membership = data?.groupMemberships?.[0];
  if (!membership) return null;

  return {
    membershipId: String(membership.path ?? '').split('/').pop(),
    roleId: String(membership.role ?? '').split('/').pop(),
  };
}

// The membership plus its resolved role. Null if the user isn't a member.
async function getMemberRole(userId) {
  const membership = await getMembership(userId);
  if (!membership) return null;

  const roles = await listRoles();
  const role = roles.find((r) => String(r.id) === String(membership.roleId));
  return { membership, role: role ?? { id: membership.roleId, name: 'Unknown role', rank: null } };
}

async function setRank(userId, roleId) {
  const gid = groupId();
  const membership = await getMembership(userId);
  if (!membership) throw new RobloxError('That user is not a member of the group.');

  await cloudRequest('PATCH', `/groups/${gid}/memberships/${membership.membershipId}`, {
    role: `groups/${gid}/roles/${roleId}`,
  });
}

// Join requests are Open Cloud as well, so letting someone into the group
// needs only the API key — no cookie. Accept and decline address a request
// by its own id rather than by user, so it has to be looked up first.
async function findJoinRequest(userId) {
  const filter = encodeURIComponent(`user == 'users/${userId}'`);

  let data;
  try {
    data = await cloudRequest(
      'GET',
      `/groups/${groupId()}/join-requests?maxPageSize=1&filter=${filter}`
    );
  } catch (err) {
    // Filtering this list by a user with no pending request answers 404
    // rather than an empty page, unlike every other list route. That is a
    // normal "nothing pending", not a failure.
    if (err.status === 404) return null;
    throw err;
  }

  const request = (data?.groupJoinRequests ?? data?.joinRequests ?? [])[0];
  if (!request) return null;
  return { id: String(request.path ?? '').split('/').pop(), createTime: request.createTime };
}

// `action` is 'accept' or 'decline'; both are custom methods, so the colon
// in the path is syntax and must not be encoded.
async function respondToJoinRequest(userId, action) {
  const request = await findJoinRequest(userId);
  if (!request) {
    throw new RobloxError(
      'That user has no pending join request. They have to request to join the group first — ' +
        'and if the group is set to accept everyone automatically, there is nothing to approve.'
    );
  }

  await cloudRequest('POST', `/groups/${groupId()}/join-requests/${request.id}:${action}`, {});
  return request;
}

const acceptJoinRequest = (userId) => respondToJoinRequest(userId, 'accept');
const declineJoinRequest = (userId) => respondToJoinRequest(userId, 'decline');

async function kickFromGroup(userId) {
  requireCookieConfig('kicking');
  await legacyRequest('DELETE', `/groups/${groupId()}/users/${userId}`);
}

async function banFromGroup(userId) {
  requireCookieConfig('banning');
  await legacyRequest('POST', `/groups/${groupId()}/bans/${userId}`);
}

async function unbanFromGroup(userId) {
  requireCookieConfig('unbanning');
  await legacyRequest('DELETE', `/groups/${groupId()}/bans/${userId}`);
}

module.exports = {
  RobloxError,
  isRankingConfigured,
  isCookieConfigured,
  resolveUser,
  listRoles,
  getMembership,
  getMemberRole,
  setRank,
  findJoinRequest,
  acceptJoinRequest,
  declineJoinRequest,
  kickFromGroup,
  banFromGroup,
  unbanFromGroup,
};
