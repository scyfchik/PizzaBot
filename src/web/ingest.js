import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '../config/env.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('ingest');

/** Largest request body accepted, before parsing. */
const MAX_BODY_BYTES = 256 * 1024;

/** Events accepted in one batch. Roblox should batch rather than spam. */
const MAX_BATCH = 50;

/**
 * The game → bot ingest endpoint.
 *
 * `POST /api/v1/events` with a shared-secret signature. This is the only route
 * in the whole bot that writes to the database from outside Discord, so it is
 * the one that has to be paranoid.
 *
 * ## Authentication
 *
 * HMAC-SHA256 over the raw body, keyed on `GAME_API_KEY`, sent as
 * `X-Signature: sha256=<hex>`, with `X-Timestamp` folded into the signed
 * payload. That combination gives three properties a bare bearer token does
 * not:
 *
 *   - the key never travels, so it cannot be captured from a request log;
 *   - the body cannot be altered in flight;
 *   - a captured request cannot be replayed later, because timestamps outside
 *     a five-minute window are refused.
 *
 * A plain bearer token is accepted as a fallback, because signing in Luau is
 * fiddly and a studio that is only reporting playtime may reasonably not want
 * the ceremony. It is strictly weaker — anything that sees the request sees the
 * key — and is rejected outright when the server is not on HTTPS.
 *
 * ## What it does not trust
 *
 * Everything in the payload is attacker-controlled the moment the key leaks
 * from a game script. `GameDataService.ingest` coerces and clamps every field,
 * rejects unknown event types, and makes purchase writes idempotent, so the
 * worst a leaked key achieves is noise in an expiring collection.
 */
export class IngestHandler {
  constructor(gameData, guildId) {
    this.gameData = gameData;
    this.guildId = guildId;
    /** ip -> { count, resetAt } */
    this.hits = new Map();
  }

  get configured() {
    return Boolean(env.game.apiKey);
  }

  /** @returns {boolean} whether this handler claimed the request. */
  async handle(req, res, { path, clientIp, send }) {
    if (path !== '/api/v1/events') return false;

    if (req.method !== 'POST') {
      send(res, 405, json({ error: 'method_not_allowed' }), 'application/json');
      return true;
    }

    if (!this.configured) {
      send(res, 503, json({ error: 'ingest_not_configured' }), 'application/json');
      return true;
    }

    if (!this.#allow(clientIp)) {
      send(res, 429, json({ error: 'rate_limited' }), 'application/json');
      return true;
    }

    let raw;
    try {
      raw = await readBody(req);
    } catch (err) {
      send(res, 413, json({ error: err.message }), 'application/json');
      return true;
    }

    const auth = this.#authenticate(req, raw);
    if (!auth.ok) {
      // Deliberately vague: a precise reason tells a prober how close they are.
      log.warn({ ip: clientIp, reason: auth.reason }, 'Ingest authentication failed');
      send(res, 401, json({ error: 'unauthorized' }), 'application/json');
      return true;
    }

    let payload;
    try {
      payload = JSON.parse(raw.toString('utf8'));
    } catch {
      send(res, 400, json({ error: 'invalid_json' }), 'application/json');
      return true;
    }

    const events = Array.isArray(payload) ? payload : [payload?.event ?? payload];
    if (!events.length || events.length > MAX_BATCH) {
      send(res, 400, json({ error: `batch must hold 1-${MAX_BATCH} events` }), 'application/json');
      return true;
    }

    // One bad event does not fail the batch — the game cannot retry only the
    // failures, so rejecting all of them would lose the good ones too.
    const results = [];
    for (const event of events) {
      try {
        results.push(await this.gameData.ingest(this.guildId, event));
      } catch (err) {
        log.error({ err, type: event?.type }, 'Ingest failed for one event');
        results.push({ ok: false, reason: 'internal_error' });
      }
    }

    const accepted = results.filter((r) => r.ok).length;
    send(
      res,
      200,
      json({
        accepted,
        rejected: results.length - accepted,
        errors: results.filter((r) => !r.ok).map((r) => r.reason).slice(0, 10),
      }),
      'application/json',
    );
    return true;
  }

  /**
   * Verify the request came from the game.
   *
   * Signature first; bearer only as an explicit fallback.
   */
  #authenticate(req, rawBody) {
    const key = env.game.apiKey;
    const signature = req.headers['x-signature'];

    if (typeof signature === 'string' && signature.length) {
      const timestamp = String(req.headers['x-timestamp'] ?? '');
      if (!/^\d{10,13}$/.test(timestamp)) return { ok: false, reason: 'bad_timestamp' };

      // Replay window. Roblox HTTP calls are fast; five minutes is generous
      // and still short enough that a captured request goes stale quickly.
      const ms = timestamp.length === 10 ? Number(timestamp) * 1000 : Number(timestamp);
      if (Math.abs(Date.now() - ms) > 5 * 60_000) return { ok: false, reason: 'stale_timestamp' };

      const expected = createHmac('sha256', key)
        .update(`${timestamp}.`)
        .update(rawBody)
        .digest('hex');

      const provided = signature.replace(/^sha256=/, '');
      if (!safeEqualHex(expected, provided)) return { ok: false, reason: 'bad_signature' };
      return { ok: true, method: 'hmac' };
    }

    if (!env.game.allowBearer) return { ok: false, reason: 'signature_required' };

    const header = req.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!token || !safeEqualUtf8(token, key)) return { ok: false, reason: 'bad_bearer' };
    return { ok: true, method: 'bearer' };
  }

  /** 120 requests per minute per IP — a batching game needs far fewer. */
  #allow(ip, limit = 120, windowMs = 60_000) {
    const now = Date.now();
    const entry = this.hits.get(ip);

    if (!entry || entry.resetAt <= now) {
      this.hits.set(ip, { count: 1, resetAt: now + windowMs });
      return true;
    }
    entry.count += 1;
    return entry.count <= limit;
  }

  prune() {
    const now = Date.now();
    for (const [ip, entry] of this.hits) if (entry.resetAt <= now) this.hits.delete(ip);
  }
}

function json(value) {
  return JSON.stringify(value);
}

/** Read the body with a hard cap, destroying the socket if it is exceeded. */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;

    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('payload_too_large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function safeEqualHex(a, b) {
  if (!/^[0-9a-f]+$/i.test(b) || a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

function safeEqualUtf8(a, b) {
  const bufA = Buffer.from(String(a), 'utf8');
  const bufB = Buffer.from(String(b), 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
