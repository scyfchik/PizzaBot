import { createLogger } from '../../utils/logger.js';

const log = createLogger('roblox-gamepasses');

/** Game passes are checked one request each, so keep a sane ceiling. */
const MAX_PASSES = 60;
const CONCURRENCY = 5;

/**
 * Which of the studio's game passes a player owns — according to Roblox.
 *
 * This is the answer to "I bought VIP and never got it". The game can report
 * what it *granted*; only Roblox can say what the player actually *owns*.
 * When the two disagree, that disagreement is the bug — and it needs no game
 * integration at all, just ROBLOX_UNIVERSE_ID.
 *
 * Endpoints (checked against the live API):
 *   apis.roblox.com/game-passes/v1/universes/{id}/game-passes  — the catalogue
 *   inventory.roblox.com/v1/users/{u}/items/GamePass/{p}        — ownership;
 *     owned = non-empty `data`
 */
export class GamePassService {
  /**
   * @param {import('./RobloxApi.js').RobloxApi} api
   * @param {{ universeId?: string|null }} options
   */
  constructor(api, { universeId = null } = {}) {
    this.api = api;
    this.universeId = universeId ? String(universeId) : null;
  }

  get configured() {
    return Boolean(this.universeId);
  }

  /** Every game pass in the experience. Cached for ten minutes. */
  async listGamePasses() {
    if (!this.universeId) return [];

    return this.api.cached(`gamepasses:${this.universeId}`, 10 * 60_000, async () => {
      const passes = [];
      let token = '';

      // Paginated; stop at the ceiling rather than walking an unbounded list.
      for (let page = 0; page < 5 && passes.length < MAX_PASSES; page++) {
        const body = await this.api.request(
          `https://apis.roblox.com/game-passes/v1/universes/${this.universeId}/game-passes` +
            `?passView=Full&pageSize=100${token ? `&pageToken=${encodeURIComponent(token)}` : ''}`,
        );
        for (const p of body?.gamePasses ?? []) {
          passes.push({
            id: String(p.id),
            name: p.displayName || p.name,
            price: p.price ?? null,
            isForSale: Boolean(p.isForSale),
          });
        }
        token = body?.nextPageToken;
        if (!token) break;
      }

      return passes.slice(0, MAX_PASSES);
    });
  }

  /**
   * Does this player own this pass?
   * @returns {Promise<boolean|null>} null when Roblox would not say
   */
  async owns(robloxId, passId) {
    const user = String(robloxId ?? '');
    const pass = String(passId ?? '');
    if (!/^\d{1,20}$/.test(user) || !/^\d{1,20}$/.test(pass)) return null;

    return this.api.cached(`owns:${user}:${pass}`, 5 * 60_000, async () => {
      const body = await this.api.request(
        `https://inventory.roblox.com/v1/users/${user}/items/GamePass/${pass}`,
      );
      if (body === null) return null;
      return Array.isArray(body.data) && body.data.length > 0;
    });
  }

  /**
   * Ownership of every studio game pass for one player.
   *
   * Individual checks fail independently: one timeout marks that pass
   * `owned: null` ("unknown") instead of losing the whole answer.
   *
   * @returns {Promise<Array<{ id: string, name: string, price: number|null, owned: boolean|null }>>}
   */
  async ownership(robloxId) {
    const passes = await this.listGamePasses();
    const results = [];

    for (let i = 0; i < passes.length; i += CONCURRENCY) {
      const batch = passes.slice(i, i + CONCURRENCY);
      const checks = await Promise.allSettled(batch.map((p) => this.owns(robloxId, p.id)));
      checks.forEach((c, j) => {
        if (c.status === 'rejected') {
          log.warn({ passId: batch[j].id, err: c.reason?.message }, 'Game pass ownership check failed');
        }
        results.push({ ...batch[j], owned: c.status === 'fulfilled' ? c.value : null });
      });
    }

    return results;
  }
}
