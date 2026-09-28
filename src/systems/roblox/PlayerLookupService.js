import { RobloxApiError } from './RobloxApi.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('roblox-players');

const HOUR = 3_600_000;

/** Roblox's own username rules — checked before spending a request. */
const USERNAME_RE = /^[A-Za-z0-9_]{3,20}$/;

/**
 * Roblox player lookups.
 *
 * Answers "who is this Roblox account" — id, display name, account age, avatar,
 * whether Roblox itself has banned it, previous usernames, rank in the studio's
 * group. Everything a staff member needs to judge a ticket or an appeal.
 *
 * What it deliberately does **not** do is decide which Discord user owns which
 * Roblox account. That is verification, and it belongs to Rover/Bloxlink. A
 * Roblox username here is always something a player typed or a game reported.
 */
export class PlayerLookupService {
  /**
   * @param {import('./RobloxApi.js').RobloxApi} api
   * @param {{ groupId?: string|null }} options
   */
  constructor(api, { groupId = null } = {}) {
    this.api = api;
    this.groupId = groupId;
  }

  /**
   * Username -> `{ id, name, displayName, hasVerifiedBadge }`, or `null` when
   * no such account exists. Case-insensitive, as Roblox is.
   */
  async resolveUsername(username) {
    const clean = String(username ?? '').trim();
    if (!USERNAME_RE.test(clean)) return null;

    return this.api.cached(`username:${clean.toLowerCase()}`, HOUR, async () => {
      const body = await this.api.request('https://users.roblox.com/v1/usernames/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // Banned accounts are included on purpose: a ban appeal is precisely
        // when you need to look one up.
        body: JSON.stringify({ usernames: [clean], excludeBannedUsers: false }),
      });

      // Unknown usernames are simply absent from `data` rather than an error.
      const match = body?.data?.[0];
      if (!match) return null;

      return {
        id: String(match.id),
        name: match.name,
        displayName: match.displayName,
        hasVerifiedBadge: Boolean(match.hasVerifiedBadge),
      };
    });
  }

  /**
   * Account details by id, or `null` for an id that does not exist.
   * `isBanned` is Roblox's platform ban — not an in-game ban.
   */
  async getUser(robloxId) {
    const id = String(robloxId ?? '');
    if (!/^\d{1,20}$/.test(id)) return null;

    return this.api.cached(`user:${id}`, HOUR, async () => {
      const body = await this.api.request(`https://users.roblox.com/v1/users/${id}`);
      if (!body?.id) return null;

      return {
        id: String(body.id),
        name: body.name,
        displayName: body.displayName,
        description: body.description ?? '',
        created: body.created ? new Date(body.created) : null,
        isBanned: Boolean(body.isBanned),
        hasVerifiedBadge: Boolean(body.hasVerifiedBadge),
      };
    });
  }

  /** Avatar headshot URL. Roblox's CDN keeps these for 30 days. */
  async getHeadshot(robloxId) {
    const id = String(robloxId ?? '');
    if (!/^\d{1,20}$/.test(id)) return null;

    return this.api.cached(`headshot:${id}`, 6 * HOUR, async () => {
      const body = await this.api.request(
        `https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${id}&size=150x150&format=Png&isCircular=false`,
      );
      const entry = body?.data?.[0];
      // A thumbnail can be "Pending" or "Blocked" (moderated avatar); neither
      // has a usable URL, and showing a broken image is worse than none.
      return entry?.state === 'Completed' ? entry.imageUrl : null;
    });
  }

  /**
   * Previous usernames, newest first.
   * The single most useful signal in a ban appeal: a player who renamed the day
   * after a ban is telling you something.
   */
  async getUsernameHistory(robloxId, limit = 10) {
    const id = String(robloxId ?? '');
    if (!/^\d{1,20}$/.test(id)) return [];

    return this.api.cached(`history:${id}`, HOUR, async () => {
      const body = await this.api.request(
        `https://users.roblox.com/v1/users/${id}/username-history?limit=${limit}&sortOrder=Desc`,
      );
      return (body?.data ?? []).map((entry) => entry.name).filter(Boolean);
    });
  }

  /**
   * The player's role in the studio's own group, when ROBLOX_GROUP_ID is set.
   * @returns {Promise<{ rank: number, name: string }|null>}
   */
  async getStudioGroupRole(robloxId) {
    if (!this.groupId) return null;
    const id = String(robloxId ?? '');
    if (!/^\d{1,20}$/.test(id)) return null;

    return this.api.cached(`group:${this.groupId}:${id}`, 10 * 60_000, async () => {
      const body = await this.api.request(`https://groups.roblox.com/v2/users/${id}/groups/roles`);
      const membership = (body?.data ?? []).find((m) => String(m.group?.id) === String(this.groupId));
      return membership ? { rank: membership.role.rank, name: membership.role.name } : null;
    });
  }

  /**
   * Everything at once, for profiles and tickets.
   *
   * Accepts a username or a numeric id. Each piece is fetched independently, so
   * a slow thumbnail service cannot cost you the account age. Returns `null`
   * only when the account itself does not exist.
   *
   * @returns {Promise<null | {
   *   id: string, name: string, displayName: string, created: Date|null,
   *   accountAgeDays: number|null, isBanned: boolean, hasVerifiedBadge: boolean,
   *   headshotUrl: string|null, previousNames: string[],
   *   groupRole: { rank: number, name: string }|null, profileUrl: string,
   *   partial: boolean
   * }>}
   */
  async getProfile(usernameOrId) {
    const input = String(usernameOrId ?? '').trim();
    if (!input) return null;

    const resolved = /^\d{1,20}$/.test(input)
      ? { id: input }
      : await this.resolveUsername(input);
    if (!resolved) return null;

    const [user, headshot, history, groupRole] = await Promise.allSettled([
      this.getUser(resolved.id),
      this.getHeadshot(resolved.id),
      this.getUsernameHistory(resolved.id),
      this.getStudioGroupRole(resolved.id),
    ]);

    if (user.status === 'rejected') throw user.reason;
    if (!user.value) return null;

    const partial = [headshot, history, groupRole].some((r) => r.status === 'rejected');
    if (partial) {
      log.warn({ robloxId: resolved.id }, 'Some Roblox lookups failed — returning a partial profile');
    }

    const created = user.value.created;
    return {
      ...user.value,
      accountAgeDays: created ? Math.floor((Date.now() - created.getTime()) / 86_400_000) : null,
      headshotUrl: headshot.status === 'fulfilled' ? headshot.value : null,
      previousNames: history.status === 'fulfilled' ? history.value : [],
      groupRole: groupRole.status === 'fulfilled' ? groupRole.value : null,
      profileUrl: `https://www.roblox.com/users/${user.value.id}/profile`,
      partial,
    };
  }

  /**
   * `getProfile` that never throws — for callers where Roblox being down must
   * not interrupt anything (ticket creation, transcripts).
   *
   * @returns {Promise<{ profile: object|null, unavailable: boolean }>}
   */
  async tryGetProfile(usernameOrId) {
    try {
      return { profile: await this.getProfile(usernameOrId), unavailable: false };
    } catch (err) {
      // An outage is expected and logged quietly; anything else is our bug and
      // logged loudly — but neither may break the ticket that asked.
      if (err instanceof RobloxApiError) {
        log.warn({ err: err.message, input: usernameOrId }, 'Roblox API unavailable');
      } else {
        log.error({ err, input: usernameOrId }, 'Unexpected error during Roblox lookup');
      }
      return { profile: null, unavailable: true };
    }
  }
}
