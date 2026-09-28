import { createLogger } from '../../utils/logger.js';

const log = createLogger('roblox-api');

/**
 * Minimal client for Roblox's public web APIs.
 *
 * Uses Node's built-in `fetch` — no SDK, no dependency. Every endpoint used
 * here is public and needs no API key or cookie: users, thumbnails, groups and
 * games. Response shapes were checked against the live API, not written from
 * memory.
 *
 * Three rules, because this runs inside ticket creation and a slow or broken
 * Roblox must never block support:
 *
 *   1. **Bounded time.** Every request has a hard timeout.
 *   2. **Not found is not an error.** An unknown username or deleted account
 *      returns `null`, and the caller shows "not found".
 *   3. **Failure is contained.** Network errors and Roblox outages throw
 *      `RobloxApiError`; callers catch it and degrade to "Roblox unavailable"
 *      rather than failing the ticket, the command or the transcript.
 */

const TIMEOUT_MS = 6000;

/** Hard cap so a busy bot cannot grow the cache without limit. */
const MAX_CACHE_ENTRIES = 5000;

export class RobloxApiError extends Error {
  constructor(message, status = null) {
    super(message);
    this.name = 'RobloxApiError';
    this.status = status;
  }
}

export class RobloxApi {
  constructor() {
    /** key -> { value, expiresAt } */
    this.cache = new Map();
  }

  /**
   * Cached request.
   *
   * @param {string} key    cache key
   * @param {number} ttlMs  how long a result stays fresh
   * @param {Function} load produces the value; `null` is cached too, so a
   *                        missing username is not re-queried on every call
   */
  async cached(key, ttlMs, load) {
    const hit = this.cache.get(key);
    if (hit && hit.expiresAt > Date.now()) return hit.value;

    const value = await load();

    if (this.cache.size >= MAX_CACHE_ENTRIES) {
      // Map iterates in insertion order, so the first key is the oldest.
      this.cache.delete(this.cache.keys().next().value);
    }
    this.cache.set(key, { value, expiresAt: Date.now() + ttlMs });
    return value;
  }

  /**
   * One HTTP call with timeout and a single retry for rate limits and
   * transient server errors.
   *
   * @returns {Promise<any|null>} parsed JSON, or `null` on 404/400
   */
  async request(url, init = {}, attempt = 1) {
    let res;
    try {
      res = await fetch(url, {
        ...init,
        headers: { Accept: 'application/json', ...(init.headers ?? {}) },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      const reason = err.name === 'TimeoutError' ? `timed out after ${TIMEOUT_MS}ms` : err.message;
      throw new RobloxApiError(`Roblox request failed: ${reason}`);
    }

    // Roblox answers an invalid id with 400 or 404. Both mean "no such thing".
    if (res.status === 404 || res.status === 400) return null;

    if (res.status === 429 || res.status >= 500) {
      if (attempt < 2) {
        const retryAfter = Number(res.headers.get('retry-after'));
        const waitMs = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, 5000) : 1000;
        log.warn({ url, status: res.status, waitMs }, 'Roblox API throttled or failing — retrying once');
        await new Promise((resolve) => setTimeout(resolve, waitMs));
        return this.request(url, init, attempt + 1);
      }
      throw new RobloxApiError(`Roblox API returned ${res.status}`, res.status);
    }

    if (!res.ok) throw new RobloxApiError(`Roblox API returned ${res.status}`, res.status);

    try {
      return await res.json();
    } catch {
      throw new RobloxApiError('Roblox API returned malformed JSON');
    }
  }

  clearCache() {
    this.cache.clear();
  }
}
