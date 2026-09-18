import { NotImplementedError } from './errors.js';

/**
 * Game status and update announcements.
 *
 * NOT IMPLEMENTED. Contract only.
 *
 * Purpose: a support bot that knows the game is down can answer half the
 * tickets before they are opened — "servers are offline, we know, here is the
 * status" is better than five identical bug reports.
 *
 * Planned:
 *   - poll `games.roblox.com/v1/games?universeIds=` for player counts and
 *     whether the place is playable
 *   - post an announcement embed when a new version ships
 *   - optionally auto-disable the Bug Report ticket category during a known
 *     outage, using `GuildConfig.tickets.disabledCategories`
 */
export class GameStatusService {
  constructor(client, config = {}) {
    this.client = client;
    this.config = config;
    this.enabled = false;
  }

  /**
   * @returns {Promise<{ playing: number, visits: number, maxPlayers: number, isPlayable: boolean }>}
   */
  async getGameStats() {
    throw new NotImplementedError('GameStatusService.getGameStats');
  }

  /** Is the universe currently up and joinable? */
  async isOnline() {
    throw new NotImplementedError('GameStatusService.isOnline');
  }

  /**
   * Post an update announcement.
   * @param {{ version: string, title: string, changes: string[], media?: string }} update
   */
  async publishUpdate(update) {
    throw new NotImplementedError('GameStatusService.publishUpdate');
  }

  /** Start polling. Called from ready.js once the integration is enabled. */
  startPolling(intervalMs = 300_000) {
    throw new NotImplementedError('GameStatusService.startPolling');
  }
}
