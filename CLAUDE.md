# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Des Hood Watch — a Discord.js v14 bot (CommonJS) for a single Discord server. It provides a slash-command embed builder, content automod, invite-link auto-moderation, raid protection (channel lockdown + new-account auto-kick), mod-action logging, and member activity stats. Persistence is PostgreSQL via `pg`.

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

### Discord Developer Portal setup

Two privileged gateway intents must be enabled on the bot (discord.com/developers/applications → your app → Bot), or the corresponding features silently fail to fire:
- **Server Members Intent** — required for `guildMemberAdd` to fire at all (raid protection auto-kick and burst-join detection).
- **Message Content Intent** — required for `/secure`'s invite-link scanning and the embed builder's "Move Existing" source-message lookup to read message content.

## Architecture

### Command registration and dispatch

Slash commands live in `commands/*.js`, each exporting `{ data, execute }` (`data` is a `SlashCommandBuilder`). `commands/index.js` is the single array all commands must be added to — `index.js` builds `client.commands` from it, and `deploy-commands.js` reads the same array to register with Discord. Adding a command means: create the file, add it to `commands/index.js`, run `npm run deploy`.

`index.js` is the only place gateway events are wired up; it dispatches to handler functions in `handlers/`. All non-slash-command interactions (buttons, select menus, modals) are routed there by matching `interaction.customId` prefixes — see the embed builder below.

**Authorization**: the `Events.InteractionCreate` handler in `index.js` rejects any interaction whose `interaction.user.id` isn't in the `ALLOWED_USER_IDS` whitelist, before any command or component handler runs. This is a single global gate covering slash commands *and* the embed builder's components, and it is independent of (and stricter than) the per-command `setDefaultMemberPermissions(Administrator)` gating, which Discord alone enforces. Passive features (message/voice stat tracking, invite-link deletion, raid protection) are deliberately *not* whitelisted — those apply to every member of the server.

### Persistence: cache-first store (`utils/store.js`)

Per-guild settings (`secureEnabled`, `raidProtectActive`, `minAccountAgeDays`, `logChannelId`, `lockedChannels`) live in an in-memory `Map` (one entry per guild), loaded lazily on first access (with in-flight-load deduping) and pre-warmed at startup via `warmRaidProtectCache()`. **Every read goes through the cache, never Postgres directly.** Every setter updates the cache synchronously and fires the Postgres write in the background via `persistField()`, unawaited — Postgres is the durable source of truth but is never on the critical path of a security action. When adding a new per-guild setting, follow this same pattern (extend `defaultEntry()`, the `SELECT` in `loadGuildCache`/`warmRaidProtectCache`, and add a getter + `persistField`-based setter) rather than querying Postgres directly.

Message/voice stats (`member_stats` table) are a separate, simpler always-write-through path since they aren't on any security-critical path.

`utils/state.js` is a distinct, deliberately non-persistent in-memory store — one embed-builder draft per user, lost on restart by design (it's a short editing session, not a durable object).

### Feature areas

- **Embed builder** (`/embed`): `commands/embed.js` starts a draft; all follow-up interaction handling (buttons, the channel select, modal submissions) is in `handlers/embedInteractions.js`, dispatched from `index.js` by the `ehb:` custom-ID prefix (`ehb:field:<key>`, `ehb:move`, `ehb:channel`, `ehb:modal:<key>`). `utils/embedRender.js` renders the draft summary + component rows and builds the final `EmbedBuilder`; `utils/modals.js` defines the per-field modal config (`FIELD_CONFIG`) that both the button labels and modal handling key off of. "Move Existing" (`utils/parseMessageUrl.js`) reposts an embed from another message in the same guild and deletes the original, rather than building a new one.

- **Automod**: always-on content filtering, enabled by default for every guild (the `automod_enabled` column defaults to `TRUE`, as does `defaultEntry()`), toggled with `/automod on|off` and inspected with `/automod status`. `handlers/autoMod.js` runs on both `messageCreate` and `messageUpdate` (so an edit can't sneak content in after the fact) and returns whether it deleted the message — `index.js` skips the rest of the message pipeline when it did. The rules themselves are pure functions in `utils/automodRules.js`: an ordered table checked most-serious-first, matching against a leetspeak/zero-width-normalized copy of the content. Only the adult-content rule sets `staffExempt` — every other category, spam included, applies to Administrators too. Spam detection (bursts, repeated messages) needs cross-message state, so it lives in the handler rather than the rule table. To add or loosen a category, edit the word lists or the `RULES` entry — `AMBIGUOUS_SLURS` is the list to trim first if members trip the filter innocently.

- **Security**: `/secure` toggles invite-link auto-deletion, enforced in `handlers/messageTracking.js` (admins/Manage Messages are exempt). `/raidprotect on|off` locks/unlocks all text channels (`handlers/raidLock.js`, via `Promise.allSettled` over per-channel permission edits) and toggles auto-kicking of under-age accounts on join (`handlers/memberJoin.js`). `memberJoin.js` also auto-triggers the same lockdown when it detects a join burst (10+ joins within 10s) even if raid protection wasn't manually enabled, and retroactively age-checks every join in that burst. Below that bar, `handlers/raidAlert.js` posts a "potential raid" embed to the mod-log on any one of three signals — 5+ joins in 10s, 3+ accounts created in the last 48h, or 3+ usernames sharing a stem (the latter two over a 60s window) — with a 5-minute per-guild cooldown. The lockdown thresholds it quotes back to the reader live in `utils/raidThresholds.js`, shared by both handlers because `memberJoin.js` already imports `raidAlert.js` and importing back would be a cycle. It's advisory only: it never locks, kicks or deletes, it's called unawaited from `handleGuildMemberAdd` so it can't delay the protective path, and it goes quiet entirely once raid protection is already active. `/modlog set|off` controls where `handlers/modLog.js`'s `logEvent()` posts — it's called from across the security features and is a no-op if no log channel is configured.

- **Stats**: `/stats` reads message counts (tracked in `messageTracking.js`) and voice time (tracked in `handlers/voiceTracking.js`, which sums session durations and re-primes in-progress sessions on startup via `primeVoiceSessions()` so a redeploy doesn't lose currently-active voice time).

### Concurrency conventions used throughout

These patterns recur across the security features and should be followed for consistency:
- When an action has a "flip a flag" part and a "slow API-bound" part, the flag is set (and awaited) first so protection is live immediately, and the slow part (e.g. locking N channels) runs after/in the background.
- Bulk per-channel Discord API calls use `Promise.allSettled` so one failing channel (missing permissions) doesn't block the others.
- Logging (`logEvent`) and stats writes are fired without `await` when they don't gate the actual protective action, so a slow log-channel send never delays message deletion, kicks, or lockdowns.
- Discord entity lookups check the gateway cache before falling back to a REST `fetch` (`getChannelCached()` in `embedInteractions.js`, the member lookup in `stats.js`) — the cache hit is the common case and avoids a network round-trip per command. Prefer this over a bare `.fetch()` for anything on a user-facing path.
