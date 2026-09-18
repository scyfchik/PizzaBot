# Pizza Guy's Time — Community Infrastructure Bot

Internal Discord bot for the Pizza Guy's Time Roblox studio community.

Scope is intentionally narrow — **security, player support, tickets, moderation
and staff operations**. Rules messages, FAQ embeds, welcome messages and basic
automod are handled by Dyno/Carl-bot; this bot does not duplicate them.

- **Setting it up for the first time on Windows:** [`docs/SETUP-WINDOWS.md`](docs/SETUP-WINDOWS.md)
- Full design and reasoning: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)

---

## Features

| System | What it does |
|---|---|
| **Tickets** | 6 categories with per-category forms, sequential numbering, claim/close/transcript buttons, HTML transcripts, response-time metrics, internal notes |
| **Security** | Anti-raid (join waves, new-account waves, username patterns, reversible quarantine, snapshot-based lockdown), anti-spam (rate, duplicate, mention, emoji, link, invite + strike escalation), anti-nuke (**defensive — never auto-bans; holds actions against senior staff for human confirmation**) |
| **Moderation** | `/warn` `/kick` `/ban` `/unban` `/timeout` `/clear` `/history`, permanent case log with evidence, staff notes and appeal status, auto-escalation, temp-punishment expiry |
| **Staff** | Role-driven permissions, case management, audit trail, **activity counters and leaderboard** |
| **AutoMod** | Scam-pattern detection (free-robux, nitro, phishing, credential requests) and a configurable word blacklist, folded into the anti-spam pass |
| **QA** | Bug reports with OPEN → TESTING → FIXED / REJECTED lifecycle, tester assignment, synced board channel, full transition history |
| **Community** | Player profiles, Roblox account linking, game update announcements |
| **Logging** | Separate embed feeds for security, moderation, tickets, staff and server events |
| **Roblox** | Storage, commands and manual verification live; **the API itself is still not implemented** |

### Commands

```
Setup & config
  /setup       initialise and check what still needs configuring
  /config      ranks · nodes · channels · tickets · security · automod · qa · changelog · roblox
  /panel       post or refresh the ticket panel

Support
  /ticket      add · note · priority · transfer · info

Moderation & security
  /warn  /timeout  /kick  /ban  /unban  /clear
  /case        view · reason · evidence · note · appeal · void
  /history     a member's full record
  /lockdown    enable · disable · status

Staff
  /staffinfo   rank, permissions and recent activity
  /staff       activity · leaderboard

QA
  /bug         report · view · list · assign · status · stats

Community & development
  /profile     player profile (public-safe)
  /verify      link · status · approve · unlink
  /changelog   publish · view · list
```

### Permissions

There are no hardcoded staff tiers. A rank is a name, some **Discord role IDs**,
a position, and a list of permission nodes — all stored in MongoDB and edited
with `/config rank`. Ten ranks ship as defaults (Owner → Trial Moderator) with
no roles attached; map them to your own roles during setup.

```bash
/config rank set rank:Moderator role:@Mod
/config rank permission rank:QA Tester node:mod.warn grant:true
```

---

## Requirements

- **Node.js 20.10+** (ESM, native `--watch`)
- **MongoDB 6+** — Atlas free tier is sufficient
- A Discord application with a bot user

---

## Installation

```bash
git clone <your-repo> pizzabot
cd pizzabot
npm install
cp .env.example .env
```

Fill in `.env` (see [Configuration](#configuration)), then:

```bash
npm run doctor   # verify env, code, database, Discord permissions
npm run deploy   # register slash commands to your guild
npm start
```

| Script | Does |
|---|---|
| `npm start` | Run the bot |
| `npm run dev` | Run with auto-restart on file change |
| `npm run doctor` | Full pre-flight check, including a brief Discord login |
| `npm run doctor:offline` | Same, without contacting Discord |
| `npm run deploy` | Register slash commands to the guild |
| `npm run deploy:clear` | Remove all slash commands from the guild |

Then, in Discord, run `/setup` — it seeds the staff ranks, checks the bot's
permissions and role position, and prints a checklist of what is still missing.
It is safe to run repeatedly and never overwrites existing settings.

---

## Discord developer setup

1. <https://discord.com/developers/applications> → **New Application**.
2. **Bot** tab → **Reset Token** → copy into `BOT_TOKEN`. Never share it; if it
   leaks, reset it immediately.
3. **Bot** tab → enable all three **Privileged Gateway Intents**:
   - **Server Members Intent** — required for anti-raid and join/leave logging
   - **Message Content Intent** — required for anti-spam
   - **Presence Intent** — optional
4. **General Information** → copy **Application ID** into `CLIENT_ID`.
5. **OAuth2 → URL Generator** → scopes `bot` + `applications.commands`, then
   invite with the permissions below.

### Required bot permissions

`Manage Roles`, `Manage Channels`, `Kick Members`, `Ban Members`,
`Moderate Members`, `Manage Messages`, `Read Message History`,
`View Channels`, `Send Messages`, `Embed Links`, `Attach Files`,
`Manage Webhooks`, `View Audit Log`

> **Role position matters.** The bot's highest role must sit above every role it
> is expected to moderate, and above the quarantine role. Discord ignores
> permissions when hierarchy says no.

---

## MongoDB setup

**Atlas (recommended):**
1. Create a free M0 cluster.
2. Database Access → add a user with *Read and write to any database*.
3. Network Access → allowlist your server's IP (`0.0.0.0/0` only for testing).
4. Connect → *Drivers* → copy the URI into `MONGO_URI`, adding a database name:
   `mongodb+srv://user:pass@cluster.mongodb.net/pizzabot`

**Local:** `MONGO_URI=mongodb://127.0.0.1:27017/pizzabot`

Collections and indexes are created automatically on first boot.

---

## Configuration

Only secrets and bootstrap IDs live in `.env`. Everything else — staff roles,
log channels, ticket settings, security thresholds — lives in MongoDB and is
edited in Discord with `/setup` and `/config`, so settings can be changed during
an incident without a redeploy.

Minimum to boot: `BOT_TOKEN`, `CLIENT_ID`, `GUILD_ID`, `MONGO_URI`.

Also set **`OWNER_IDS`** (1–2 Discord user IDs). It is the only permission value
in `.env` and the bootstrap that lets someone run `/setup` before any staff
roles exist. Owners bypass every permission check.

See [`.env.example`](.env.example) for the annotated list.

---

## Running locally

```bash
npm run dev      # auto-restart on file change
npm run deploy   # re-register commands after changing a command definition
npm run doctor   # verify env, database, permissions and channel config
```

Slash commands are registered **per guild**, which updates instantly. Global
registration takes up to an hour and is unnecessary for a single-server bot.

---

## Production deployment

Any Node host works. With `pm2`:

```bash
npm install --omit=dev
npm run deploy
pm2 start src/index.js --name pizzabot --time
pm2 save
```

Checklist:
- `NODE_ENV=production`, `LOG_LEVEL=info`
- `.env` permissions restricted to the service user (`chmod 600 .env`)
- MongoDB reachable and IP-allowlisted from the host
- Bot role positioned above all moderated roles
- Run `npm run doctor` after deploying
- Ship `logs/` somewhere durable, or rely on your process manager's capture

---

## Operational notes

- **Anti-nuke never bans or kicks.** Its strongest automatic action is removing
  roles that grant dangerous permissions, and it will not do even that to a
  **protected** rank — it holds the action and posts confirmation buttons for
  the security team. A buggy detector with ban rights would itself be the nuke.
- **Anti-nuke cannot stop the guild owner.** Discord gives the owner absolute
  power; the bot alerts and says so plainly instead of pretending otherwise.
- **Deleted messages are gone.** This bot is not a backup.
- **Anti-raid quarantines rather than bans**, because quarantine is reversible.
  A wrongly quarantined player gets their roles back; a wrongly banned one does
  not come back.
- **Cases are never deleted**, only voided, with the voiding itself recorded.
- **Transcripts may contain personal data** shared in tickets. Treat the
  `transcripts/` directory as sensitive.

---

## Project layout

```
src/
├── core/          client, registries, interaction router, error taxonomy
├── config/        validated env, constants + permission nodes, cached guild config
├── database/      connection + 7 Mongoose models
├── systems/       all business logic
│   ├── logging/   the five embed feeds
│   ├── staff/     permission nodes, ranks, hierarchy
│   ├── tickets/   manager, categories, components, transcripts
│   ├── moderation/service + case embeds
│   ├── security/  anti-spam, anti-raid, anti-nuke, lockdown
│   └── roblox/    interfaces only
├── commands/      slash commands, grouped by domain
├── events/        gateway event adapters
├── interactions/  button, modal and select-menu handlers
├── utils/         logger, embeds, time, custom IDs, safeAction
└── scripts/       deploy-commands, doctor
```

Commands and events never touch the database directly; they call a system. See
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the reasoning.
