/**
 * Roblox integration — scaffolding only. No API calls are made anywhere.
 *
 * Three services, matching the three things the community actually needs:
 *
 *   RobloxVerificationService  link a Discord account to a Roblox account
 *   PlayerLookupService        resolve usernames, profiles, group ranks
 *   GameStatusService          live player counts, update announcements
 *
 * Nothing registers these with the client yet. When the integration is built,
 * `ready.js` gains three `registerSystem` calls and the commands that use them
 * are added — no schema migration, no config format change, because
 * `User.roblox` and `GuildConfig.roblox` are already in place.
 */
export { RobloxVerificationService } from './RobloxVerificationService.js';
export { PlayerLookupService } from './PlayerLookupService.js';
export { GameStatusService } from './GameStatusService.js';
export { NotImplementedError } from './errors.js';
