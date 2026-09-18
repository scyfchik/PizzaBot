# Pizza Guy's Time — Community Infrastructure Bot

The internal operations panel for the Pizza Guy's Time Roblox studio.

Not a general-purpose Discord bot, and deliberately not a replacement for
Dyno/Carl-bot/Ticket Tool. Those handle chat moderation, antispam, verification,
rules and welcome messages. **Pizza Bot handles the studio's own processes:**
support tickets, player analytics, staff activity, game monitoring, economy
tracking and security audit — the things no off-the-shelf bot can do because
they need your game's data.

> **One thing to understand first:** playtime, levels, Robux spent and in-game
> events are **not readable from Roblox**. No API exposes them. Your game sends
> them to the bot. Until you wire that up, those features honestly report "no
> game data" rather than showing zeroes. See
> [`docs/GAME-INTEGRATION.md`](docs/GAME-INTEGRATION.md).

- **First-time setup on Windows:** [`docs/SETUP-WINDOWS.md`](docs/SETUP-WINDOWS.md)
- **Connecting your Roblox game:** [`docs/GAME-INTEGRATION.md`](docs/GAME-INTEGRATION.md)
- Full design and reasoning: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)
- Current state, tested vs untested: [`docs/STATUS.md`](docs/STATUS.md)

---

## Features

| System | What it does |
|---|---|
| **Support tickets** | 6 categories with per-category forms, sequential numbering, claim/unclaim/close, outcome tracking (Accepted/Denied/Resolved), response-time metrics, queue view |
| **Transcripts** | Web viewer with summary, timeline, player context and purchase history above a Discord-style chat log — searchable, mobile-friendly, print-to-PDF. Reached from 🌐/📥 buttons on the close message; falls back to an HTML attachment if the viewer is down |
| **Player analytics** | One lookup for Discord, Roblox, playtime, level, spend, tickets, warnings and bugs |
| **Economy** | Per-player transaction history including failures, deduplicated on Roblox's receipt id |
| **Game monitoring** | Live player counts, active servers, event feed, connection health |
| **Staff activity** | Counters incremented at the point of action; activity panel and leaderboard |
| **QA** | Bug reports with OPEN → TESTING → FIXED / REJECTED, tester assignment, synced board |
| **Security** | Anti-nuke (**defensive — never auto-bans; holds actions against senior staff for human confirmation**), anti-raid, snapshot-based lockdown, searchable audit log |
| **Moderation** | Case log with evidence and appeal status — kept because ban appeals and player profiles need the history, not to compete with your automod bot |
| **Logging** | Separate embed feeds for security, moderation, tickets, staff and server events |

**Off by default**, because other bots do them better: anti-spam, scam
detection, the word blacklist. The implementations are kept and tested — a
server with no other automod bot can enable them with
`/config security anti-spam:true`.

### Commands

Everything is grouped under a noun, so related things live together.

```
Players
  /player profile     Discord + Roblox + game stats + support history
  /player history     moderation and support record
  /player economy     spend summary
  /player purchases   transactions, including failures
  /player link        link a Roblox account   (/player unlink)

Support
  /tickets list       browse the queue        (/tickets queue, /tickets stats)
  /ticket view        one ticket              (/ticket history <member>)
  /ticket add · note · priority · transfer
  /transcript link · revoke · info

Game
  /game stats         players online, servers, spend
  /game events        raw reported event feed
  /game connection    is the game wired up?

Staff
  /staff profile      rank, permissions, recent activity
  /staff activity     full counter breakdown
  /staff leaderboard  most active staff

QA
  /bug report · view · list · assign · status · stats

Security
  /security logs      searchable audit trail  (/security summary)
  /security lockdown · unlock · status

Moderation (record-keeping)
  /warn  /timeout  /kick  /ban  /unban  /clear
  /case view · reason · evidence · note · appeal · void

Setup
  /setup   /config   /panel
```

Renamed from earlier versions: `/staffinfo` → `/staff profile`, `/history` →
`/player history`, `/profile` → `/player profile`, `/verify` → `/player link`,
`/lockdown` → `/security lockdown`. `/changelog` was removed — announcements
belong in a bot built for them.

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
  `transcripts/` directory and the `Transcript` collection as sensitive.
- **A transcript link is a password.** Anyone holding the URL can read the whole
  ticket — there is no login. Links go only to the staff ticket log and the
  opener's DMs, expire after 90 days by default, and can be killed with
  `/transcript revoke`. Only the hash is stored, so a lost link is regenerated
  with `/transcript link`, never recovered.
- **The web viewer binds to `127.0.0.1` by default.** Put a reverse proxy with
  TLS in front before exposing it; `npm run doctor` fails the run if it finds
  plain HTTP bound to a public interface.

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
