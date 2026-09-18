# Roblox integration — scaffolding

**Nothing here makes an API call.** Every method throws `NotImplementedError`.

## What already exists

| Piece | Where | Status |
|---|---|---|
| Storage for the account link | `User.roblox` (userId, username, verifiedAt, verificationMethod, isTester, groupRank) | ✅ in the schema |
| Per-guild settings | `GuildConfig.roblox` (groupId, universeId, verifiedRoleId, testerRoleId, announcementChannelId) | ✅ in the schema |
| Env placeholders | `ROBLOX_GROUP_ID`, `ROBLOX_UNIVERSE_ID`, `ROBLOX_API_KEY` | ✅ in `.env.example` |
| Display in `/history` | shows the Roblox link when present | ✅ already wired |
| Roblox username on tickets | `Ticket.robloxUsername`, captured from the modals | ✅ already captured |
| The three services | this folder | ⬜ interfaces only |

## Building it later

1. Implement one service at a time. `PlayerLookupService` first — it has no
   auth requirements and the others build on it.
2. Register it in `src/events/client/ready.js` alongside the other systems.
3. Gate everything on `GuildConfig.roblox.enabled`, which defaults to `false`.

## Things to get right when you do

- **Cache lookups.** Roblox rate-limits by IP, and a ticket resolves the same
  username many times over its life.
- **Degrade gracefully.** Roblox has outages. A ticket must still open when the
  API is unreachable — never block the support flow on a third party.
- **Never trust the username field.** It is free text typed by a player and is
  the obvious impersonation vector. Resolve it to an ID before acting on it.
- **Verification proves a claim, not a person.** A verified link means "this
  Discord account controlled that Roblox profile at that moment". Treat it as
  evidence, not identity.
