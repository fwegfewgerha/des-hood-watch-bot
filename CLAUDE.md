# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Des Hood Watch — a Discord.js v14 bot (CommonJS) for a single Discord server. It provides a slash-command embed builder, content automod, invite-link auto-moderation, raid protection (channel lockdown + new-account auto-kick), mod-action logging, member activity stats, and Roblox group control (ranking, kicks and bans). Persistence is PostgreSQL via `pg`.

## Commands

```bash
npm install          # install dependencies
npm start             # run the bot (node index.js)
npm run deploy         # register/update slash commands with Discord (node deploy-commands.js)
```

There is no lint or test setup in this repo (no eslint config, no test script/framework in `package.json`) — don't invent commands for these.

`npm run avatar` is defined in `package.json` but `set-avatar.js` does not exist in the repo — that script is currently broken/missing.

**After adding, removing, or changing the signature of any slash command**, you must run `npm run deploy` for Discord to see the change. Set `GUILD_ID` in `.env` during development for near-instant guild-scoped registration; omit it for global registration (takes up to ~1 hour to propagate).

### Required environment variables (`.env`, not committed)

- `DISCORD_TOKEN` — bot token (index.js, deploy-commands.js)
- `CLIENT_ID` — application/client ID (deploy-commands.js)
- `GUILD_ID` — optional; if set, `npm run deploy` registers commands to just that guild instead of globally
- `DATABASE_URL` — Postgres connection string (store.js). On Railway, add a Postgres service and reference it as `${{Postgres.DATABASE_URL}}` on this service's Variables tab.
- `ALLOWED_USER_IDS` — comma-separated Discord user IDs allowed to use the bot. **Required**; the bot refuses to start without it (index.js), and an empty/unset value would otherwise silently mean "no authorization".
- `ROBLOX_GROUP_ID` — the group `/group` acts on. Optional; without it every `/group` subcommand replies that it isn't configured.
- `ROBLOX_API_KEY` — Open Cloud API key with the **group:read** and **group:write** permissions, created at create.roblox.com/dashboard/credentials by an account ranked *above* whatever roles you want to assign. Powers `/group rank|promote|demote|info`. The key's IP allowlist must include the bot host (`0.0.0.0/0` if Railway's egress IP isn't pinned).
- `ROBLOX_COOKIE` — the `.ROBLOSECURITY` cookie of an account with kick/ban permission in the group. Only needed for `/group kick|ban|unban`, which have no Open Cloud equivalent. This is a full account credential, so it is deliberately optional and separate — leave it unset and ranking still works while those three subcommands report themselves unconfigured. It dies whenever that account logs out or changes its password.

### Discord Developer Portal setup

Two privileged gateway intents must be enabled on the bot (discord.com/developers/applications → your app → Bot), or the corresponding features silently fail to fire:
- **Server Members Intent** — required for `guildMemberAdd` to fire at all (raid protection auto-kick and burst-join detection).
- **Message Content Intent** — required for `/secure`'s invite-link scanning and the embed builder's "Move Existing" source-message lookup to read message content.

## Architecture

### Command registration and dispatch

Slash commands live in `commands/*.js`, each exporting `{ data, execute }` (`data` is a `SlashCommandBuilder`). `commands/index.js` is the single array all commands must be added to — `index.js` builds `client.commands` from it, and `deploy-commands.js` reads the same array to register with Discord. Adding a command means: create the file, add it to `commands/index.js`, run `npm run deploy`.

`index.js` is the only place gateway events are wired up; it dispatches to handler functions in `handlers/`. All non-slash-command interactions (buttons, select menus, modals) are routed there by matching `interaction.customId` prefixes — see the embed builder below.

A command may also export an optional `autocomplete(interaction)` alongside `execute` (`commands/group.js` is the only one so far). Autocomplete is dispatched ahead of the authorization gate below, because it cannot be answered with a message — an unauthorized user gets an empty suggestion list instead of a rejection they could never see, and the real refusal happens when they submit the command.

**Authorization**: the `Events.InteractionCreate` handler in `index.js` rejects any interaction whose `interaction.user.id` isn't in the `ALLOWED_USER_IDS` whitelist, before any command or component handler runs. This is a single global gate covering slash commands *and* the embed builder's components, and it is independent of (and stricter than) the per-command `setDefaultMemberPermissions(Administrator)` gating, which Discord alone enforces. Passive features (message/voice stat tracking, invite-link deletion, raid protection) are deliberately *not* whitelisted — those apply to every member of the server.

### Persistence: cache-first store (`utils/store.js`)

Per-guild settings (`secureEnabled`, `raidProtectActive`, `minAccountAgeDays`, `logChannelId`, `lockedChannels`) live in an in-memory `Map` (one entry per guild), loaded lazily on first access (with in-flight-load deduping) and pre-warmed at startup via `warmRaidProtectCache()`. **Every read goes through the cache, never Postgres directly.** Every setter updates the cache synchronously and fires the Postgres write in the background via `persistField()`, unawaited — Postgres is the durable source of truth but is never on the critical path of a security action. When adding a new per-guild setting, follow this same pattern (extend `defaultEntry()`, the `SELECT` in `loadGuildCache`/`warmRaidProtectCache`, and add a getter + `persistField`-based setter) rather than querying Postgres directly.

Message/voice stats (`member_stats` table) are a separate, simpler always-write-through path since they aren't on any security-critical path.

`utils/state.js` is a distinct, deliberately non-persistent in-memory store — one embed-builder draft per user, lost on restart by design (it's a short editing session, not a durable object).

### Feature areas

- **Embed builder** (`/embed`): `commands/embed.js` starts a draft; all follow-up interaction handling (buttons, the channel select, modal submissions) is in `handlers/embedInteractions.js`, dispatched from `index.js` by the `ehb:` custom-ID prefix (`ehb:field:<key>`, `ehb:move`, `ehb:channel`, `ehb:modal:<key>`). `utils/embedRender.js` renders the draft summary + component rows and builds the final `EmbedBuilder`; `utils/modals.js` defines the per-field modal config (`FIELD_CONFIG`) that both the button labels and modal handling key off of. "Move Existing" (`utils/parseMessageUrl.js`) reposts an embed from another message in the same guild and deletes the original, rather than building a new one.

- **Automod**: always-on content filtering, enabled by default for every guild (the `automod_enabled` column defaults to `TRUE`, as does `defaultEntry()`), toggled with `/automod on|off` and inspected with `/automod status`. `handlers/autoMod.js` runs on both `messageCreate` and `messageUpdate` (so an edit can't sneak content in after the fact) and returns whether it deleted the message — `index.js` skips the rest of the message pipeline when it did. The rules themselves are pure functions in `utils/automodRules.js`: an ordered table checked most-serious-first, matching against a leetspeak/zero-width-normalized copy of the content. Only the adult-content rule sets `staffExempt` — every other category, spam included, applies to Administrators too. Spam detection (bursts, repeated messages) needs cross-message state, so it lives in the handler rather than the rule table. To add or loosen a category, edit the word lists or the `RULES` entry — `AMBIGUOUS_SLURS` is the list to trim first if members trip the filter innocently.

- **Security**: `/secure` toggles invite-link auto-deletion, enforced in `handlers/messageTracking.js` (admins/Manage Messages are exempt). `/raidprotect on|off` locks/unlocks all text channels (`handlers/raidLock.js`, via `Promise.allSettled` over per-channel permission edits) and toggles auto-kicking of under-age accounts on join (`handlers/memberJoin.js`). `memberJoin.js` also auto-triggers the same lockdown when it detects a join burst (10+ joins within 10s) even if raid protection wasn't manually enabled, and retroactively age-checks every join in that burst. Below that bar, `handlers/raidAlert.js` posts a "potential raid" embed to the mod-log on any one of four signals — 5+ joins in 10s, 3+ accounts created in the last 48h, 3+ usernames sharing a stem, or a join rate that beats the **learned baseline** for this hour of day — with a 5-minute per-guild cooldown. That last signal comes from `utils/joinBaseline.js`, which counts joins into aligned 10-minute buckets and folds each completed bucket into one of 24 hour-of-day slots as an EWMA mean and variance (persisted per guild in the `join_baseline` JSONB column, cache-first like every other setting). It alerts above `mean + 3σ`, floored at 6 so a quiet server can't be alerted by a handful of joins, and falls back to that floor until a slot has ~2 days of samples. Two rules keep a raid from teaching it that raids are normal: a bucket at or above 2× the current threshold is not learned from at all, and anything below that is clipped to the threshold before folding — without the first rule, a measured 3-hour attack walked a dead 03:00 slot's threshold from 6 up to 55. The ticker that folds completed buckets (including empty ones — a quiet stretch is real evidence) is started from `ClientReady` via `startBaselineTicker()`, next to `primeVoiceSessions()`. The lockdown thresholds it quotes back to the reader live in `utils/raidThresholds.js`, shared by both handlers because `memberJoin.js` already imports `raidAlert.js` and importing back would be a cycle. It's advisory only: it never locks, kicks or deletes, it's called unawaited from `handleGuildMemberAdd` so it can't delay the protective path, and it goes quiet entirely once raid protection is already active. `/modlog set|off` controls where `handlers/modLog.js`'s `logEvent()` posts — it's called from across the security features and is a no-op if no log channel is configured.

- **Roblox group control** (`/group`): `commands/group.js` + `utils/roblox.js` drive the Roblox group from Discord — `rank` (set any role), `promote`/`demote` (one step along the rank ladder), `accept`/`decline` (pending join requests), `kick`, `ban`, `unban`, and `info`. **This spans two Roblox APIs on purpose.** Ranking uses Open Cloud (`apis.roblox.com/cloud/v2`) with an `x-api-key`: list roles, find the target's membership via ``filter=user == 'users/<id>'``, then `PATCH .../memberships/<membershipId>` with `{ "role": "groups/<gid>/roles/<roleId>" }`. Join requests are Open Cloud too — `GET .../join-requests?filter=user == 'users/<id>'` to find the request, then `POST .../join-requests/<id>:accept` or `:decline` (the colon is custom-method syntax and must not be URL-encoded) — so approving members needs only the API key. Kick/ban/unban are the exception: they have no Open Cloud equivalent, so they fall back to the legacy `groups.roblox.com/v1` routes, which need the `.ROBLOSECURITY` cookie and a CSRF token — the token is obtained by making the request without one, reading `x-csrf-token` off the 403, and retrying once (cached thereafter). Because the cookie is a whole-account credential and the API key isn't, the two are separate env vars and each half degrades on its own: `isRankingConfigured()` / `isCookieConfigured()` gate their subcommands with an explanatory reply rather than a stack trace. Roblox's own rank rules still apply on top — an account can't rank, kick or ban anyone at or above its own rank, and Open Cloud reports that as a flat `400 The request was invalid`, which `cloudRequest` translates into something actionable. Role lists are cached for 5 minutes (they rarely change and every rank command needs them); rank 0 (Guest) is filtered out since it isn't assignable. Errors carry `expected = true` when they're the operator's to fix, which is how the command layer decides between showing the message verbatim and letting `index.js` log a real bug.

- **Stats**: `/stats` reads message counts (tracked in `messageTracking.js`) and voice time (tracked in `handlers/voiceTracking.js`, which sums session durations and re-primes in-progress sessions on startup via `primeVoiceSessions()` so a redeploy doesn't lose currently-active voice time).

### Concurrency conventions used throughout

These patterns recur across the security features and should be followed for consistency:
- When an action has a "flip a flag" part and a "slow API-bound" part, the flag is set (and awaited) first so protection is live immediately, and the slow part (e.g. locking N channels) runs after/in the background.
- Bulk per-channel Discord API calls use `Promise.allSettled` so one failing channel (missing permissions) doesn't block the others.
- Logging (`logEvent`) and stats writes are fired without `await` when they don't gate the actual protective action, so a slow log-channel send never delays message deletion, kicks, or lockdowns.
- Discord entity lookups check the gateway cache before falling back to a REST `fetch` (`getChannelCached()` in `embedInteractions.js`, the member lookup in `stats.js`) — the cache hit is the common case and avoids a network round-trip per command. Prefer this over a bare `.fetch()` for anything on a user-facing path.
- Deleting a flagged message goes through `deleteMessageWithRetry()` (`utils/deleteMessage.js`) rather than a bare `message.delete()` in a `try`/`catch`, because the failures need opposite handling: a transient network failure (a `discord.com` connect timeout, a 5xx) leaves the message up and is retried twice with backoff, while an already-deleted message (`10008`) is a normal outcome of the `messageCreate`/`messageUpdate` pair racing and is reported as `ALREADY_GONE` so the caller stays quiet instead of double-posting the notice and mod-log entry. A 4xx (missing permissions) is never retried. Use it for any new delete on a moderation path.
