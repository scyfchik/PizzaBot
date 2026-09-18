import { NotImplementedError } from './errors.js';

/**
 * Links a Discord account to a Roblox account.
 *
 * NOT IMPLEMENTED. This is the contract the rest of the bot is written
 * against, so when the integration lands nothing outside this folder changes.
 *
 * The storage side already exists: `User.roblox` holds `userId`, `username`,
 * `verifiedAt`, `verificationMethod`, `isTester` and `groupRank`, and
 * `/history` already renders them when present.
 *
 * Planned verification flow (code method):
 *   1. `beginVerification` returns a short phrase.
 *   2. The player puts it in their Roblox profile "About" section.
 *   3. `completeVerification` reads the profile and compares.
 *   4. On success: write `User.roblox`, add the verified role.
 *
 * Why a profile code rather than OAuth: it needs no Roblox app registration,
 * no redirect URL, and no hosting — which matters for a studio bot that may be
 * running on someone's home machine.
 */
export class RobloxVerificationService {
  constructor(client, config = {}) {
    this.client = client;
    this.config = config;
    this.enabled = false;
  }

  /**
   * Start verification for a Discord user.
   * @param {string} discordId
   * @param {string} robloxUsername
   * @returns {Promise<{ code: string, expiresAt: Date }>}
   */
  async beginVerification(discordId, robloxUsername) {
    throw new NotImplementedError('RobloxVerificationService.beginVerification');
  }

  /**
   * Check the player's profile for the code and finalise the link.
   * @param {string} discordId
   * @returns {Promise<{ verified: boolean, robloxId?: string, username?: string }>}
   */
  async completeVerification(discordId) {
    throw new NotImplementedError('RobloxVerificationService.completeVerification');
  }

  /**
   * Re-check an existing link: has the account been renamed, deleted, or left
   * the group? Intended to run on a schedule.
   * @param {string} discordId
   */
  async revalidate(discordId) {
    throw new NotImplementedError('RobloxVerificationService.revalidate');
  }

  /**
   * Apply verified / tester / group-rank roles in Discord.
   * @param {import('discord.js').GuildMember} member
   */
  async syncRoles(member) {
    throw new NotImplementedError('RobloxVerificationService.syncRoles');
  }

  /** Drop the link (used when a player asks, or on a false verification). */
  async unlink(discordId) {
    throw new NotImplementedError('RobloxVerificationService.unlink');
  }
}
