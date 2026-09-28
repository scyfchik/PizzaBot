import { createLogger } from '../../utils/logger.js';

const log = createLogger('roblox-game');

/**
 * Public statistics for the studio's experience, straight from Roblox.
 *
 * This works with **no game-side setup at all** — just `ROBLOX_UNIVERSE_ID`.
 * Players online, total visits, favourites and likes come from Roblox's public
 * games API, so `/game stats` shows real numbers from day one, before anyone
 * has wired the in-game reporter.
 *
 * What it cannot give you is anything per-player (playtime, level, purchases).
 * That still has to come from the game through the ingest endpoint.
 */
export class GameStatusService {
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

  /**
   * Live experience stats. Cached for a minute: the player count moves, but
   * not so fast that a Discord command needs a fresh request every time.
   *
   * @returns {Promise<null | {
   *   universeId: string, placeId: string, name: string, creator: string,
   *   playing: number, visits: number, favorites: number, maxPlayers: number,
   *   upVotes: number|null, downVotes: number|null, likeRatio: number|null,
   *   created: Date|null, updated: Date|null, url: string
   * }>}
   */
  async getStats() {
    if (!this.universeId) return null;

    return this.api.cached(`universe:${this.universeId}`, 60_000, async () => {
      const [games, votes] = await Promise.allSettled([
        this.api.request(`https://games.roblox.com/v1/games?universeIds=${this.universeId}`),
        this.api.request(`https://games.roblox.com/v1/games/votes?universeIds=${this.universeId}`),
      ]);

      if (games.status === 'rejected') throw games.reason;
      const game = games.value?.data?.[0];
      if (!game) {
        log.warn({ universeId: this.universeId }, 'Universe not found — check ROBLOX_UNIVERSE_ID');
        return null;
      }

      // Votes are a nice-to-have; losing them must not lose the player count.
      const vote = votes.status === 'fulfilled' ? votes.value?.data?.[0] : null;
      const up = vote?.upVotes ?? null;
      const down = vote?.downVotes ?? null;

      return {
        universeId: String(game.id),
        placeId: String(game.rootPlaceId),
        name: game.name,
        creator: game.creator?.name ?? 'Unknown',
        playing: game.playing ?? 0,
        visits: game.visits ?? 0,
        favorites: game.favoritedCount ?? 0,
        maxPlayers: game.maxPlayers ?? 0,
        upVotes: up,
        downVotes: down,
        likeRatio: up != null && down != null && up + down > 0 ? up / (up + down) : null,
        created: game.created ? new Date(game.created) : null,
        updated: game.updated ? new Date(game.updated) : null,
        url: `https://www.roblox.com/games/${game.rootPlaceId}`,
      };
    });
  }
}
