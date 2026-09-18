# Pizza Guy's Time — Bot Architecture

Internal community infrastructure for the studio Discord. Scope is deliberately
narrow: **security, tickets, moderation, staff operations**. Rules, FAQ,
welcome messages and basic automod stay with Dyno/Carl-bot — this bot does not
duplicate them.

---

## 1. Architecture overview

### Layering

```
  Discord Gateway
        │
   ┌────▼──────────────────────────────────────────┐
   │  events/        thin adapters                 │  translate gateway events
   │                 no business logic             │  into system calls
   └────┬──────────────────────────────────────────┘
   ┌────▼──────────────────────────────────────────┐
   │  systems/       all business logic            │  the only layer that
   │                 security, tickets, moderation │  decides anything
   └────┬──────────────────────────────────────────┘
   ┌────▼──────────────────────────────────────────┐
   │  database/      models + connection           │  the only layer that
   └───────────────────────────────────────────────┘  touches Mongo
        ▲
   ┌────┴──────────────────────────────────────────┐
   │  commands/ + interactions/                    │  parse input, call a
   │                 thin adapters                 │  system, render a reply
   └───────────────────────────────────────────────┘
```

The rule that keeps this maintainable: **a command never talks to a model
directly, and a system never builds an embed.** `/ban` validates arguments and
calls `moderation.ban(...)`; the system writes the case, DMs the user, bans, and
emits a log event.

That matters because every feature here has more than one entry point. A ban
comes from `/ban`, from denying an appeal, or from a security response. A ticket
closes from a button, a command, or the close modal. One implementation, one set
of side effects, one place to audit.

### Directory map

```
src/
├── index.js                  entrypoint: env check → DB → handlers → login
├── core/
│   ├── PizzaClient.js        extended Client; registries, systems, timers
│   ├── CommandRegistry.js    recursive loader + cooldowns
│   ├── EventRegistry.js      recursive loader, wraps handlers so one throw
│   │                         cannot take down the process
│   ├── InteractionRouter.js  custom-id parser → button/modal/select handler
│   └── errors.js             UserError vs InternalError taxonomy
├── config/
│   ├── env.js                validated, frozen env — nothing else reads process.env
│   ├── constants.js          colours, permission nodes, default ranks, enums
│   └── guildConfig.js        cached DB config with explicit invalidation
├── database/
│   ├── connection.js         mongoose lifecycle, buffering disabled
│   └── models/               Counter, GuildConfig, User, Punishment,
│                             Ticket, SecurityLog, StaffNote
├── systems/
│   ├── logging/              LogService (5 embed feeds) + server-event builders
│   ├── staff/                permissions.js — nodes, ranks, hierarchy
│   ├── tickets/              TicketManager, categories, components, transcript
│   ├── moderation/           ModerationService, caseEmbeds
│   ├── security/             SecurityService, AntiSpam, AntiRaid, AntiNuke,
│   │                         Lockdown, SlidingWindow
│   └── roblox/               interfaces only — no API calls
├── commands/
│   ├── moderation/           warn kick ban unban timeout clear history case
│   ├── tickets/              panel ticket
│   ├── security/             lockdown
│   ├── staff/                staffinfo
│   └── system/               setup config
├── events/
│   ├── client/               ready (system bootstrap + timers)
│   ├── interaction/          interactionCreate (the single gate)
│   ├── member/               add, remove, update
│   ├── message/              messageCreate (anti-spam + ticket metrics)
│   └── guild/                channelDelete, roleDelete, roleUpdate,
│                             guildBanAdd, webhooksUpdate
├── interactions/
│   ├── buttons/              ticketActions, securityConfirm
│   ├── modals/               ticketSubmit, ticketClose
│   └── selects/              ticketOpen
├── utils/                    logger, embeds, time, ids, safeAction
└── scripts/                  deploy-commands.js, doctor.js
```

### Cross-cutting decisions

| Decision | Rationale |
|---|---|
| ESM (`"type": "module"`) | discord.js v14 is ESM-first. |
| Config in Mongo, secrets in env | Thresholds must be tunable **during** an incident, not after a redeploy. `.env` holds secrets and `OWNER_IDS`, nothing else. |
| In-memory detector state | Raid/spam windows are seconds long. A Mongo write per message costs latency and money for data worthless 30s later. Mongo stores the *outcome*. |
| Counters, not `count()` | Ticket and case numbers come from an atomic `$inc`. Counting documents is racy. |
| Fail-closed security, fail-open UX | A failed permission check denies. A missing log channel does not stop a ban. |
| Operational log ≠ Discord audit log | `utils/logger` (pino, file + stdout) is for whoever runs the server. `systems/logging` is the embed feed staff read. |

---

## 2. Database design

Eleven collections.

### The later four

**`StaffActivity`** — per-staff counters, `(guildId, userId)` unique plus
`(guildId, totals.actions: -1)`. One `$inc` per action at the moment it happens;
`/staff leaderboard` is then a single indexed `find().sort().limit()` instead of
an aggregation across every Punishment and Ticket ever written. The trade-off is
that these are derived numbers which can drift if a write fails — acceptable,
because nothing disciplinary is decided from them. They answer "who is carrying
the load", not "what did this person do".

**`BugReport`** — separate from the ticket that produced it, because the two
have different lifetimes: the support conversation ends when the channel is
deleted, the bug stays open until a build fixes it. Linked by `ticketId`. Every
status transition is appended to `history`, so a bug that was rejected and later
reopened does not read as though it was always open.

**`RobloxProfile`** — **global, not per-guild.** A Roblox account belongs to the
person, not to their membership of one server; storing it per-guild would mean
re-verifying everywhere and holding the same link N times with N chances to
disagree. This replaced the embedded `User.roblox` block. `verified` defaults to
`false` and nothing treats an unverified row as identity.

**`Changelog`** — stored as well as posted, so an announcement can be corrected
and re-rendered from the record, and `BugReport.fixedInVersion` can point at a
version that actually exists.

### The original seven

**`Counter`** — atomic sequences. `_id: "ticket:<guildId>"`, `seq`. One
`findOneAndUpdate($inc)` per number: gapless, unique, safe across processes.

**`GuildConfig`** — one document per guild. Staff ranks, log channels, ticket
settings, every security threshold, escalation ladder, reserved Roblox block.
Cached in memory with explicit invalidation on write, so `messageCreate` never
blocks on a database read.

**`User`** — per-guild member projection. Denormalised counters, the Roblox link
block, flags (`watched`, `ticketBlocked`), and the anti-spam strike count. This
exists so `/history` is one document read; **Punishment stays source of truth.**
Strikes live here rather than in memory because a punishment ladder that resets
on every deploy is trivially farmable.

**`Punishment`** — the case log. One immutable document per action. Carries
`evidence[]`, staff-only `notes[]`, and an `appeal` block
(`status`, `ticketId`, `reviewedBy`, `decisionReason`). A lifted punishment is
not deleted: `active: false`, `voidedBy`, `voidReason`. That is what makes a
`/history` printout defensible in an appeal and stops a compromised staff
account erasing its own record.

Indexes: `(guildId, caseId)` unique, `(guildId, userId, createdAt)`,
`(guildId, moderatorId, createdAt)` for staff activity, `(guildId,
appeal.status)` for the appeal queue, `(active, expiresAt)` for the sweeper.

**`Ticket`** — the record; the channel is disposable. Modal answers are stored
as an ordered `[{key, label, value}]` array, so adding a question never needs a
migration. Tracks `firstResponseMs` and `resolutionTimeMs` — the two numbers
that tell you whether support is working.

**`SecurityLog`** — forensic record, written on detection **before** the
response runs, so an incident is reconstructable even when the response fails.
`incidentId` groups every line from one raid. A TTL index expires low-severity
noise after 14 days; high and critical set `expiresAt: null` and are kept.

**`StaffNote`** — annotations, deliberately separate from `Punishment`. A note
must never appear in an appeal as a punishment.

---

## 3. Security system design

Three detectors sharing one shape: **in-memory sliding window → threshold →
`SecurityLog` write → response → alert.**

### Anti-spam (`messageCreate`)

Per-user rolling buffer of recent messages with content hashes and
mention/emoji/link counts. Detects rate spam, duplicate spam (hash matched
across channels — the cross-channel case per-channel checks always miss),
mention spam, emoji spam, link spam and invites.

Escalation by strike count within `decayMinutes`:
1 → delete + public nudge · 2 → 5m timeout · 3 → 1h · 4 → 24h.
Timeouts create a real case, so spam shows up in `/history` like anything else.
Staff who can moderate are exempt; three strikes raises a medium alert.

Deliberately gentle at the start: most "spam" in a Roblox community is an
excited twelve-year-old posting four messages in a row, not an attacker.

### AutoMod — content filtering

Scam patterns and the word blacklist run **inside** the anti-spam pass, not as a
separate system. A second `messageCreate` handler would race the first to delete
the same message and double-punish the author.

Content is checked *before* volume: a scam link posted once matters more than six
harmless messages in five seconds, and checking content first means the log names
the offending message rather than "6 messages".

Two deliberate biases:

- **Every scam pattern needs two independent signals.** "Free robux" alone is
  something players say constantly — it is only a scam paired with a link or a
  claim instruction. Over-blocking a children's community means deleting normal
  conversation, and nothing destroys trust in a moderation bot faster.
- **Content rules override the strike ladder.** A scam link does not get a free
  pass for being someone's first message; that is exactly how a compromised
  account gets one shot at the whole server.

Text is normalised before matching — case, Unicode look-alikes, zero-width
characters, leetspeak and single-character padding (`f r e e  r o b u x`). The
blacklist matches on word boundaries, so `ass` does not trip on `assassin`.
Neither the blacklisted term nor the scam text is ever echoed back into the
channel or the log.

### Anti-raid (`guildMemberAdd`)

Three signals in increasing order of confidence:

1. **Raw join rate** — noisy; a YouTuber shout-out looks identical.
2. **New-account rate** — much stronger; organic spikes are mostly aged accounts.
3. **Username similarity** — catches botnets that stagger joins under the rate
   threshold. Cheap prefix bucketing, not a full edit-distance matrix.

The response only fires on signal 2 or 3, or on signal 1 combined with a
majority of new accounts. Acting on raw join rate alone means punishing a
successful game launch — the worst possible day to lock the server.

Response ladder: alert → quarantine the wave → optional auto-lockdown (off by
default). **Quarantine rather than kick or ban, because it is reversible.** If
the detector is wrong, a quarantined player gets their roles back; a banned one
is just gone.

Lockdown snapshots each channel's existing `@everyone` SendMessages value —
allow, deny, or unset — and restores exactly that on lift, instead of
blanket-allowing and silently opening channels that were locked on purpose. It
carries an expiry, because the common failure is not a bad lockdown but one
nobody remembers to lift.

### Anti-nuke — defensive by design

Threat model: an administrator account, already trusted by the permission
system, deleting channels or mass-banning.

Detection covers mass channel deletion, mass role deletion, mass bans, mass
kicks, webhook floods, and dangerous permission grants. Executors are resolved
from the audit log, then counted in a per-executor sliding window.

**The response never bans and never kicks.** Three paths:

| Who | Response |
|---|---|
| **Guild owner** | Alert only, stating plainly that no bot can restrict the owner and that the account must be secured by its holder. |
| **Protected rank** (Owner → Developer by default) | Nothing automatic. The action is **held** and posted with `[Remove permissions]` / `[This was authorised]` buttons for the security team. |
| **Anyone else** | Remove every role granting dangerous permissions, then alert with a one-click **restore** button. |

The reasoning: a false positive that strips a role is an inconvenience; a false
positive that bans the Game Director during a launch is a catastrophe. A buggy
detector with ban rights *is* the nuke. Anything that would take power from
senior staff waits for a human.

Permission escalation (a role gaining Administrator, Manage Guild, …) is
**alert-only** — it is legitimate often enough that automatic reversal would
break normal server administration.

Two limits stated rather than papered over: the guild owner cannot be stopped,
and deleted messages are gone forever. This bot is not a backup.

---

## 4. Ticket workflow

```
  Panel (persistent select menu, static custom ID)
        │ user picks a category
        ▼
  Modal — category-specific questions
        │ submit
        ▼
  Counter.next("ticket:<guild>") → #000152     ← number reserved first, so a
        │                                        mid-way failure leaves a gap,
        ├─ create private channel  bug-000152    not a duplicate
        ├─ overwrites: opener + every rank holding ticket.claim
        ├─ persist the Ticket document
        └─ header embed + [Claim] [Close] [Transcript]
        │
        ▼
  CLAIMED ──► 🟢 header updated, Claim swapped for Unclaim
        │     staff replies (firstResponseMs captured in messageCreate)
        │     /ticket note · add · priority · transfer
        │     Unclaim ──► back to 🔴 Waiting for staff
        ▼
  CLOSE ──► confirmation modal (resolution required)
        ├─ HTML transcript generated (while messages still exist)
        ├─ outcome written to MongoDB
        ├─ DM'd to the opener with a summary
        ├─ posted to the ticket log
        └─ channel deleted after a 5s grace period
```

There is no archive category. Archived ticket channels accumulate without
limit, and a channel list holding two thousand dead tickets is worse than
useless — the transcript, the form answers and the full audit trail all live in
the `Ticket` document and the ticket log, which is where staff actually look
them up.

| Category | Fields collected |
|---|---|
| 🐛 Bug Report | Roblox username · description · reproduction steps · media |
| 🚨 Player Report | reported player · reason · evidence |
| ⚖️ Ban Appeal | Roblox username · Discord username · punishment reason · appeal · evidence |
| 💳 Purchase Issue | Roblox username · purchase info · problem |
| 📋 Staff Application | Roblox username · position · availability · experience · motivation |
| ❓ General Support | subject · description |

Each category is a data object in `systems/tickets/categories.js` declaring its
label, emoji, channel prefix, default priority and modal fields. A seventh
category is one object — no changes to the manager, panel or handlers.

Design notes:
- **Ban appeals auto-attach the opener's last five cases** to the header. Staff
  should not have to run `/history` in another channel to judge an appeal.
- **Staff applications carry `requiredPermission`**, so only ranks holding
  `ticket.applications` can see them. Applications contain personal data.
- Panel components use **static custom IDs**; a panel posted months ago still
  works after a redeploy. Ticket buttons carry the immutable ticket number.
- `maxOpenPerUser` plus `flags.ticketBlocked` prevent support spam.
- Transcripts are self-contained HTML — no external CSS or JS, readable from a
  `file://` URL years later. They contain whatever players typed, so
  `transcripts/` is sensitive.

---

## 5. Staff workflow

**Claim → act → record → audit.**

| Command | Purpose |
|---|---|
| `/setup` | Seed ranks, check bot permissions and role position, print a checklist of what is still missing. Safe to re-run — never overwrites. |
| `/config` | Everything tunable, live: ranks, permission nodes, log channels, ticket settings, security thresholds, escalation. |
| `/panel` | Post or refresh the ticket panel. |
| `/lockdown` | `enable` / `disable` / `status`. |
| `/staffinfo` | Rank, live permission list, activity over N days, all-time totals. Doubles as the answer to "why can't I run that command?" |
| `/case` | `view` · `reason` · `evidence` · `note` · `appeal` · `void`. |
| `/history` | Full member record: cases, tickets, notes, Roblox link. |
| `/ticket` | `add` · `note` · `priority` · `transfer` · `info`. |

Case edits, voids and appeal decisions all write to the **staff log**, separate
from the moderation log — the people who can edit the record are exactly the
people whose edits need witnessing.

Accepting an appeal voids the case automatically. Otherwise "your appeal was
accepted" would be a lie the next time escalation counted that warning.

---

## 5a. QA workflow

```
  /bug report  ─┐
                ├─► BugReport (OPEN)  ──► board channel embed
  🐛 ticket    ─┘        │
                         │ /bug assign
                         ▼
                    TESTING  ──► /bug status ──► FIXED / REJECTED
                         │                            │
                         └──── reopen clears ─────────┘
                              the resolution
```

A 🐛 Bug Report ticket files a tracked `BugReport` alongside the conversation.
The ticket is for talking to the player; the report is what the team works from.
If the report fails to file, the ticket still opens — the player's request is
never lost to a QA bookkeeping error.

`/changelog publish` can close bugs by number, which marks them FIXED, stamps
`fixedInVersion`, and credits the reporters in the announcement. The bug numbers
are validated *before* the announcement goes out, so an update never claims to
fix a bug that does not exist.

## 6. Permission system

**There are no hardcoded tiers.** A rank is a row in `GuildConfig.staffRanks`:

```js
{ key, name, position, roleIds: [...], permissions: [...], protected }
```

Every check in the codebase asks *"does this member hold node `mod.ban`"* —
never *"is this member a Moderator"*. Renaming, reordering or re-scoping a rank
is a `/config` change, not a code change.

Default ranks (all editable, all start with no roles mapped):

| Rank | Position | Protected |
|---|---:|:--:|
| Owner | 100 | ✔ |
| Co-Owner | 90 | ✔ |
| Game Director | 80 | ✔ |
| Lead Developer | 70 | ✔ |
| Developer | 60 | ✔ |
| QA Lead | 55 | |
| QA Tester | 50 | |
| Community Manager | 45 | |
| Moderator | 30 | |
| Trial Moderator | 20 | |

`position` orders the hierarchy. `protected` means security systems will not act
against the rank automatically — they hold the action and ask a human.

Permission nodes are grouped `ticket.*`, `mod.*`, `case.*`, `staff.*`,
`security.*`, `config.*`, plus the `*` wildcard. A member holding several staff
roles gets the union of their nodes and the highest of their positions.

Two independent gates, both must pass:
1. **Node check** — declared per command in a `meta` block, enforced in
   `interactionCreate` before `execute` is ever called, so it cannot be
   forgotten inside a handler.
2. **Discord permissions** — `setDefaultMemberPermissions` hides commands in the
   client rather than merely rejecting them.

On top, every target-taking action runs **hierarchy validation**: not yourself,
not the bot, not the guild owner, not above the bot's top role, not an equal or
higher rank, not a higher Discord role. Rule five is what stops a compromised
moderator account from removing the rest of staff.

`OWNER_IDS` in `.env` bypasses everything. That is the bootstrap — without it a
fresh server has nobody who can run `/setup`.

---

## 7. Roblox integration (storage live, API still not implemented)

**No API call is made anywhere.** What exists now:

- `RobloxProfile` — the global link collection, with `verified` defaulting to
  `false`.
- `/verify link` records a *claimed* username. `/verify approve` lets staff
  vouch for it manually and grants the verified role.
- `/profile`, `/history` and the ticket embed all label unverified links as
  unverified, and never display an unresolved Roblox ID — printing one would
  imply a check that has not happened.
- Three services with documented signatures, every method still throwing
  `NotImplementedError`.

A manual vouch records a *staff member's judgement*, not proof. When the API
lands it replaces `/verify approve`'s guesswork with a profile-code check and
fills in `robloxId` — no schema migration, no command changes.

See `src/systems/roblox/README.md`.

---

## 8. Reliability

- **Fail-fast boot** — env validated before login; a half-configured security
  system never starts.
- **Graceful shutdown** — `SIGINT`/`SIGTERM` clear timers, destroy the client,
  close Mongo, with a 10s force-exit backstop.
- **Global handlers** — `unhandledRejection` is logged and survived;
  `uncaughtException` logs and exits so the process manager restarts clean.
- **Event isolation** — `EventRegistry` wraps every handler; one throwing
  listener cannot stop the others or kill the process.
- **`safeAction`** — every Discord mutation that is allowed to fail is wrapped,
  so a missing permission degrades to a logged warning instead of killing an
  incident response halfway through.
- **Interaction safety** — `UserError` becomes an ephemeral message; anything
  else becomes a generic message plus an incident ID that also appears in the
  operational log.
- **`npm run doctor`** — verifies env, loads every command and interaction
  handler (catching syntax errors and duplicate names), connects to Mongo and
  reports configuration gaps, all without logging in.
