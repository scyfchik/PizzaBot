# Project Status Report

**Pizza Guy's Time — Discord infrastructure bot**
Report date: 18 September 2026 · Version 0.1.0 · Not yet run against a live server

---

## Summary

The bot is **code-complete for v1 and verified to start**, but has **never run
against a real Discord server or a real MongoDB Atlas cluster**. Every system is
written and every module loads, starts and shuts down cleanly. What has not been
proven is behaviour against live Discord — tickets, moderation actions and the
security detectors have been tested at the unit and boot level only.

| | |
|---|---|
| Source files | 77 JavaScript files, ~7,600 lines |
| Slash commands | 14, all serialising to valid Discord payloads |
| Interaction handlers | 10 (buttons, modals, select menus) |
| Gateway events | 11 bound |
| Database models | 7 |
| Runtime | Node 24.19.0 LTS · discord.js 14.27 · mongoose 8.24 |
| Blocking issue | None in code. Needs credentials and a live server. |

---

## 1. Completed

### Core
- Entrypoint with ordered boot: env validation → database → handler loading → login.
- Recursive loaders for commands, events and interaction handlers.
- Custom-ID router (`pgt:<domain>:<action>:<args>`) — components are stateless and survive restarts.
- Error taxonomy: `UserError` shown to users, everything else becomes a generic message plus an incident ID.
- Graceful shutdown on SIGINT/SIGTERM with a forced-exit backstop.
- Structured operational logging (pino → stdout + daily file), separate from the Discord audit feed.

### Configuration
- `.env` holds only secrets and `OWNER_IDS`. Everything else lives in MongoDB.
- `/setup` — seeds ranks, checks bot permissions and role position, prints a nine-step first-run checklist with progress.
- `/config` — ranks, permission nodes, log channels, ticket settings, security thresholds, moderation escalation, all editable live.
- In-memory config cache with explicit invalidation on write.

### Permissions
- No hardcoded tiers. A rank is `{key, name, position, roleIds[], permissions[], protected}` in the database.
- 25 permission nodes plus a wildcard. Every check asks for a node, never a rank name.
- Ten default ranks (Owner → Trial Moderator), shipped with no roles attached.
- Hierarchy validation on every target: not self, not bot, not guild owner, not above the bot, not an equal/higher rank, not a higher Discord role.

### Tickets
- Six categories, each a data object with its own modal form.
- Sequential numbering from an atomic counter.
- Private channel per ticket with overwrites derived from permission nodes.
- **Claim / Unclaim toggle** — one button slot, swapping with state.
- Header embed showing 👤 User · 🎮 Roblox · 📂 Category · 📊 Status · 🕒 Created, rewritten on every state change so the embed and buttons can never disagree with the database.
- Status: 🔴 Waiting for staff → 🟢 Claimed by @staff → ⚫ Closed.
- In-channel announcement when a ticket is claimed or released.
- Close: confirmation modal → transcript → MongoDB → DM to opener → ticket log → channel deleted after 5 seconds.
- Self-contained HTML transcripts.
- Ban appeals auto-post the opener's last five cases as a separate message.
- `/ticket add · note · priority · transfer · info`, `/panel post · refresh`.

### Moderation
- `/warn` `/timeout` `/kick` `/ban` `/unban` `/clear` `/history` `/case`.
- Immutable case log with evidence, staff notes and appeal status (active / appealed / reviewed / accepted / rejected).
- Accepting an appeal voids the case so it stops counting toward escalation.
- Auto-escalation on repeat warnings; expiry sweeper for temp-bans and quarantines.
- Bans and kicks made outside the bot are detected from the audit log and reported.

### Security
- **Anti-spam** — rate, duplicate (cross-channel), mention, emoji, link and invite detection, with a strike ladder that persists across restarts.
- **Anti-raid** — join-rate, new-account-rate and username-similarity signals; only acts when confident. Quarantine by default because it is reversible.
- **Anti-nuke** — never bans or kicks. Ordinary members lose dangerous-permission roles with a one-click restore; protected ranks are held for human confirmation; the guild owner is alerted only.
- **Lockdown** — snapshots each channel's prior `@everyone` state and restores it exactly, with an auto-lift timer.

### Logging
- Five separate embed feeds: security, moderation, tickets, staff, server.
- Logging failures never block the action being logged.

### Tooling and docs
- `npm run doctor` — five-stage pre-flight check including a live Discord login.
- `npm run deploy` / `deploy:clear`, `npm start`, `npm run dev`.
- `docs/SETUP-WINDOWS.md` — ten steps from a clean machine, plus troubleshooting.
- `docs/ARCHITECTURE.md` — full design and the reasoning behind each decision.
- `src/systems/roblox/` — three service interfaces, scaffolding only, no API calls.

---

## 2. Tested

All of the following were executed on this machine with Node 24.19.0 and a real
MongoDB (in-memory server), not merely reviewed.

### Module loading
- 14 commands, 10 interaction handlers, 11 events load.
- All 14 commands serialise to valid Discord JSON.
- Every command declares a permission node (verified programmatically).
- No duplicate command names or handler keys.

### Process lifecycle — 7 scenarios, all clean exits with correct codes
| Scenario | Result |
|---|---|
| Start, dev mode, bad token | exit 1, 5.7s |
| Start, production mode, bad token | exit 1, 12.4s |
| Deploy with bad token | exit 1, one-line error |
| `doctor --offline` | exit 1 |
| `doctor` with Discord login attempt | exit 1, clean `401` |
| `doctor` with no environment at all | exit 1, 0.1s |
| `client.shutdown()`, timers cleared | exit 0 |

### Database (against real MongoDB)
- Counter is atomic: 20 concurrent calls produced 20 unique sequential numbers.
- `(guildId, caseId)` unique index rejects duplicates.
- Invalid enum values are rejected.
- `User.ensure` upsert is idempotent.
- Config cache stays coherent across save/reload.
- Ticket, Punishment, SecurityLog and StaffNote documents create correctly with defaults and subdocuments.

### `/setup` rendering
Executed end-to-end against a mock interaction and a real database, in two
states — fresh guild with no permissions and bad role position, and fully
configured. Both produce embeds within Discord's limits (8 fields, 2,752 chars
worst case; every field under the 1,024 limit).

### Ticket components
Verified across unclaimed / claimed / closed:
- Correct button set per state (Claim ↔ Unclaim, all disabled when closed).
- Status line, embed colour and footer track the claim state.
- Custom IDs round-trip through the parser.
- Embed stays within field limits with long form answers.

---

## 3. Not tested

**This is the important section.** Everything below is written but unproven.

### Requires a live Discord server
- Opening a ticket from the panel, end to end.
- Claim, Unclaim and Close as real clicks.
- Channel creation with permission overwrites.
- Transcript generation from a real conversation.
- DM delivery of transcripts and punishment notices.
- Channel deletion after close.
- All moderation commands against real members (`/warn` `/kick` `/ban` `/unban` `/timeout` `/clear`).
- Log embeds actually arriving in their channels.
- `/setup`, `/config`, `/panel`, `/staffinfo`, `/case`, `/history` as real invocations.
- Autocomplete on `/unban` and `/config`.
- Slash command deployment with a valid token.

### Requires deliberate simulation
- **Anti-spam** — no message burst has ever been run through it.
- **Anti-raid** — no join wave; the username-similarity clustering is unexercised.
- **Anti-nuke** — no mass deletion; the audit-log executor resolution is unexercised.
- **Anti-nuke confirmation buttons** — the held-action path for protected ranks has never been clicked.
- **Lockdown** — the permission snapshot and restore has never run against real channels.
- Auto-escalation on repeat warnings.
- The expiry sweeper for temp-bans and quarantines.

### Other gaps
- No automated test suite. All verification so far was throwaway scripts in a scratch directory.
- No load or concurrency testing beyond the 20-call counter check.
- MongoDB Atlas specifically has not been used — only a local in-memory server.
- Never run for longer than about 15 seconds continuously.

---

## 4. Known issues

### Resolved during this phase
These were real bugs found by running the code, and are fixed:
1. **Crash on exit** — `process.exit()` after `client.destroy()` raised a libuv `UV_HANDLE_CLOSING` assertion. Fixed in `src/utils/exit.js`.
2. **47-second startup failure** — index building blocked boot. Moved to `ensureIndexes()`, called after ready. Now ~6s.
3. **Deploy errors dumped the entire command payload.** Now one actionable line.
4. **Mongoose errors logged ~300 lines** of topology. Fixed with a pino error serializer.
5. **"Application did not respond"** — both `showModal` paths (panel select, close button) did database reads before responding, risking Discord's 3-second deadline. All such reads now happen after the response.

### Open
| # | Issue | Severity | Note |
|---|---|---|---|
| 1 | Roblox username is unverified free text | Medium | Shown as `unverified` in the ticket embed. Impersonation is possible until the Roblox integration lands. No ID is displayed, deliberately — printing one would imply a check that has not happened. |
| 2 | Anti-nuke cannot restrict the guild owner | By design | Discord grants the owner absolute power. The bot alerts and says so plainly. |
| 3 | Deleted messages are unrecoverable | By design | Channels can be recreated; history cannot. This is not a backup. |
| 4 | Detector state is per-process | By design | A restart clears raid/spam windows. Spam strikes persist in MongoDB; the message windows do not. |
| 5 | Transcripts capped at 2,000 messages | Low | Longer tickets are truncated. |
| 6 | `transcripts/` contains personal data | Operational | Treat as sensitive; not covered by any retention policy yet. |
| 7 | `resolveStaff` runs on every component interaction | Low | Reads cached config, warmed at boot. If the cache is cold it costs one indexed query. Monitor if timeouts recur. |
| 8 | No test suite | Medium | Verification is currently non-repeatable. |
| 9 | Bans made outside the bot create no case | Low | They are logged to the moderation feed as external actions, but carry no case number. |

---

## 5. Next recommended steps

### Immediate — required before the bot is usable
1. Create the Discord application, enable **Server Members** and **Message Content** intents, invite the bot with the full permission set.
2. Create a MongoDB Atlas M0 cluster and allowlist the host IP.
3. Fill in `.env` — `BOT_TOKEN`, `CLIENT_ID`, `GUILD_ID`, `MONGO_URI`, `OWNER_IDS`.
4. Run `npm run doctor` and fix every failure. This is the first real end-to-end signal.
5. Run `npm run deploy`, then `npm start`.
6. **Move the bot's role to the top of the role list** — above every moderated role and the quarantine role.

Full walkthrough in [`SETUP-WINDOWS.md`](SETUP-WINDOWS.md).

### Short term — prove it works, on a test server first
7. Run `/setup` and work the checklist to 9/9.
8. Open one ticket of each of the six categories. Claim, unclaim, close each one. Confirm the transcript reaches `#ticket-logs` and the opener's DMs, and that the channel is deleted.
9. Test moderation on an alt account: warn → warn → warn (confirm escalation fires) → timeout → kick → ban → unban → `/history` → `/case void`.
10. **Deliberately trigger each security system on the test server**, in this order of risk:
    - anti-spam: post 8 messages in 3 seconds
    - anti-raid: lower `raid-join-threshold` to 3 and have three alts join
    - anti-nuke: create and delete 4 throwaway channels with a non-protected test account, confirm the response and the restore button
    - lockdown: enable and disable, confirm channel permissions return to exactly their prior state
11. Only after all of the above: invite to the real server, with `nuke-response` set to `alert_only` for the first week.

### Medium term
12. Add a real test suite (`node --test`) covering the models, permission resolution, duration parsing and the custom-ID round trip — the parts that need no Discord connection.
13. Decide a retention policy for `transcripts/` and for closed tickets.
14. Set up process management (pm2 or a systemd unit) and durable log shipping.
15. Review anti-spam thresholds against real traffic after a week and tune with `/config`.

### Later
16. Build the Roblox integration, starting with `PlayerLookupService` — it has no auth requirements and the other two build on it. This closes known issue #1.
17. Consider a staff-application review workflow if `📋 Staff Application` tickets see real volume.

---

## Appendix: what changed in the most recent phase

- Ticket archiving removed entirely. Close now always deletes the channel after
  5 seconds; the transcript, form answers and audit trail live in MongoDB and
  the ticket log. `archiveCategoryId` and `deleteOnClose` are gone from the
  schema and from `/config`.
- Claim/Unclaim toggle added, with header rewriting on every state change.
- Ticket embed reformatted to the larger-server layout.
- Header message ID persisted so claim, unclaim and close can update it from
  anywhere, not only from a click on the message itself.
- Header message is now pinned on creation.
