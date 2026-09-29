import { RobloxApi } from './RobloxApi.js';
import { PlayerLookupService } from './PlayerLookupService.js';
import { GameStatusService } from './GameStatusService.js';
import { GamePassService } from './GamePassService.js';

/**
 * Roblox integration — public web APIs only.
 *
 *   players  who a Roblox account is: id, age, avatar, bans, old names, group rank
 *   game       live stats for the studio's experience: players, visits, favourites
 *   gamePasses which of the studio's game passes a player owns, per Roblox
 *
 * Both share one API client, so they share one cache and one set of timeouts.
 *
 * Verification — proving which Discord user owns which Roblox account — is not
 * here, on purpose. Rover/Bloxlink do that. Pizza Bot only ever looks up a
 * Roblox account by a name or id it was given.
 */
export class RobloxService {
  constructor({ groupId = null, universeId = null } = {}) {
    this.api = new RobloxApi();
    this.players = new PlayerLookupService(this.api, { groupId });
    this.game = new GameStatusService(this.api, { universeId });
    this.gamePasses = new GamePassService(this.api, { universeId });
  }
}

export { RobloxApi, RobloxApiError } from './RobloxApi.js';
export { PlayerLookupService } from './PlayerLookupService.js';
export { GameStatusService } from './GameStatusService.js';
export { GamePassService } from './GamePassService.js';
