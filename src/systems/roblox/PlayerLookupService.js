import { NotImplementedError } from './errors.js';

/**
 * Looks up Roblox players.
 *
 * NOT IMPLEMENTED. Contract only.
 *
 * Purpose: every ticket category already collects a Roblox username as free
 * text, which means typos and impersonation. Once this exists, those strings
 * can be resolved to a real account and shown in the ticket header — staff stop
 * guessing whether `Pizzaenjoyer` and `PizzaEnjoyer_` are the same person.
 *
 * Implementation notes for later:
 *   - `users.roblox.com/v1/usernames/users` resolves names to IDs in bulk.
 *   - Responses should be cached; the same username gets looked up repeatedly
 *     across a ticket's life, and Roblox rate-limits by IP.
 *   - Every method must degrade gracefully. Roblox's API has outages, and a
 *     ticket must still open when it is down.
 */
export class PlayerLookupService {
  constructor(config = {}) {
    this.config = config;
    this.enabled = false;
  }

  /**
   * @param {string} username
   * @returns {Promise<{ id: string, name: string, displayName: string } | null>}
   */
  async getUserByUsername(username) {
    throw new NotImplementedError('PlayerLookupService.getUserByUsername');
  }

  /**
   * @param {string} robloxId
   * @returns {Promise<{ id: string, name: string, created: Date, description: string, isBanned: boolean } | null>}
   */
  async getUserInfo(robloxId) {
    throw new NotImplementedError('PlayerLookupService.getUserInfo');
  }

  /** Avatar headshot URL, for embed thumbnails. */
  async getAvatarUrl(robloxId) {
    throw new NotImplementedError('PlayerLookupService.getAvatarUrl');
  }

  /**
   * Group membership and rank — the basis for tester and staff verification.
   * @returns {Promise<{ rank: number, roleName: string } | null>}
   */
  async getGroupRank(robloxId, groupId) {
    throw new NotImplementedError('PlayerLookupService.getGroupRank');
  }

  /** Previous usernames — useful when judging a ban appeal. */
  async getUsernameHistory(robloxId) {
    throw new NotImplementedError('PlayerLookupService.getUsernameHistory');
  }
}
