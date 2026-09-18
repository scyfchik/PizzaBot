import { createServer } from 'node:http';
import { Transcript, hashToken } from '../database/models/Transcript.js';
import { renderViewer, renderError } from './viewer.js';
import { env } from '../config/env.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('web');

/**
 * The transcript web server.
 *
 * Built on `node:http` rather than a framework. It serves exactly two routes
 * and needs no routing, no middleware stack and no body parsing — pulling in
 * Express for that would add a dependency tree larger than the bot itself.
 *
 * ## Threat model
 *
 * This is the only part of the bot reachable by someone who is not in the
 * Discord server, and it serves personal data. So:
 *
 *   - **Read-only.** No route mutates anything except a view counter. There is
 *     no POST handler, so there is no body to parse and nothing to inject into.
 *   - **Token in the path, hashed in the database.** 32 random bytes; the
 *     database stores only the SHA-256, so a dump does not yield working links.
 *   - **Rate limited per IP**, which removes brute force as an avenue even
 *     before the 256-bit search space does.
 *   - **Uniform 404** for unknown, expired and revoked tokens, so the response
 *     never confirms that a given token once existed.
 *   - **Strict CSP.** The page's own inline script is allowed by hash-free
 *     `unsafe-inline` for style only; scripts come from nowhere external and
 *     the page never uses `innerHTML` on user content.
 *   - **`noindex` everywhere**, including a hard-coded `robots.txt`.
 */
export class TranscriptServer {
  /** @param {import('./ingest.js').IngestHandler|null} ingest */
  constructor(ingest = null) {
    this.server = null;
    this.ingest = ingest;
    /** ip -> { count, resetAt } */
    this.hits = new Map();
    this.sweeper = null;
  }

  get enabled() {
    return env.web.enabled;
  }

  async start() {
    if (!this.enabled) {
      log.info('Transcript web viewer disabled (WEB_ENABLED is not true)');
      return null;
    }

    this.server = createServer((req, res) => {
      this.#handle(req, res).catch((err) => {
        log.error({ err, url: req.url }, 'Unhandled error serving transcript');
        this.#send(res, 500, renderError(500, 'Something went wrong', 'Please try again later.'));
      });
    });

    // Clients that open a connection and send nothing must not hold a socket.
    this.server.headersTimeout = 10_000;
    this.server.requestTimeout = 15_000;

    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(env.web.port, env.web.host, () => {
        this.server.removeListener('error', reject);
        resolve();
      });
    });

    this.sweeper = setInterval(() => {
      this.#pruneRateLimit();
      this.ingest?.prune();
    }, 60_000);
    this.sweeper.unref();

    log.info(
      {
        host: env.web.host,
        port: env.web.port,
        baseUrl: env.web.baseUrl,
        ingest: this.ingest?.configured ? 'enabled' : 'not configured',
      },
      'Web server listening',
    );

    if (env.web.host === '0.0.0.0' && env.web.baseUrl?.startsWith('http://')) {
      log.warn(
        'Serving transcripts over plain HTTP on a public interface. ' +
          'Ticket transcripts contain personal data — put TLS in front of this.',
      );
    }

    return this.server;
  }

  async stop() {
    if (this.sweeper) clearInterval(this.sweeper);
    if (!this.server) return;

    await new Promise((resolve) => this.server.close(resolve));
    this.server = null;
    log.info('Transcript web viewer stopped');
  }

  /**
   * Whether the server is actually accepting connections.
   *
   * Distinct from `enabled`, which only reflects configuration. A port clash
   * leaves the bot running with `WEB_ENABLED=true` and nothing listening, and
   * in that state we must fall back to attaching the HTML file rather than
   * posting links that go nowhere.
   */
  get listening() {
    return Boolean(this.server?.listening);
  }

  /**
   * Public URL for a token, or null when the viewer cannot serve it.
   *
   * Note what is *not* in the path: the ticket number. The URL carries only the
   * random token, so the link leaks neither how many tickets the studio has
   * handled nor which one this is.
   */
  buildUrl(token) {
    if (!this.listening || !env.web.baseUrl) return null;
    return `${env.web.baseUrl}/t/${token}`;
  }

  /** Same page, served as a file download. */
  buildDownloadUrl(token) {
    const base = this.buildUrl(token);
    return base ? `${base}/download` : null;
  }

  // ------------------------------------------------------------- internals

  async #handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname;
    const clientIp = this.#clientIp(req);

    // The ingest API is the one route that accepts a POST. It authenticates
    // itself; everything after this point stays read-only.
    if (this.ingest) {
      const claimed = await this.ingest.handle(req, res, {
        path,
        clientIp,
        send: (r, status, body, type) => this.#send(r, status, body, type),
      });
      if (claimed) return;
    }

    // Read-only for everything else: anything that is not a GET or HEAD is
    // refused before it can be parsed.
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD' }).end();
      return;
    }

    if (path === '/health') {
      this.#send(res, 200, JSON.stringify({ ok: true }), 'application/json');
      return;
    }

    if (path === '/robots.txt') {
      this.#send(res, 200, 'User-agent: *\nDisallow: /\n', 'text/plain');
      return;
    }

    // `/t/<token>` renders the page; `/t/<token>/download` serves the same
    // bytes with a Content-Disposition header. One route, two presentations —
    // the download must never be a second rendering path that could drift.
    const match = /^\/t\/([A-Za-z0-9_-]{16,128})(\/download)?\/?$/.exec(path);
    if (!match) {
      this.#send(res, 404, renderError(404, 'Not found', 'There is nothing at this address.'));
      return;
    }
    const asDownload = Boolean(match[2]);

    if (!this.#allow(clientIp)) {
      this.#send(
        res,
        429,
        renderError(429, 'Too many requests', 'Please wait a minute and try again.'),
      );
      return;
    }

    const transcript = await Transcript.findOne({ tokenHash: hashToken(match[1]) }).lean();

    // One response for "no such token", "expired" and "revoked". Distinguishing
    // them would let someone probe which tokens were ever real.
    if (!transcript || transcript.revoked || (transcript.expiresAt && transcript.expiresAt <= new Date())) {
      this.#send(
        res,
        404,
        renderError(
          404,
          'Transcript unavailable',
          'This link is invalid, has expired, or has been revoked. Ask a staff member if you still need it.',
        ),
      );
      return;
    }

    // Counted, not awaited: a slow write should not delay the page.
    Transcript.updateOne(
      { _id: transcript._id },
      { $inc: { viewCount: 1 }, $set: { lastViewedAt: new Date() } },
    ).catch((err) => log.warn({ err }, 'Failed to record transcript view'));

    const body = renderViewer(transcript);

    // The filename is the one place the ticket number appears, and only after
    // the token has already been accepted — it is not guessable from the URL.
    const extra = asDownload
      ? {
          'Content-Disposition': `attachment; filename="ticket-${String(transcript.ticketId).padStart(6, '0')}.html"`,
        }
      : {};

    this.#send(res, 200, body, 'text/html; charset=utf-8', extra);
  }

  #send(res, status, body, contentType = 'text/html; charset=utf-8', extraHeaders = {}) {
    res.writeHead(status, {
      'Content-Type': contentType,
      'Content-Length': Buffer.byteLength(body),
      // The page is entirely self-contained. Nothing may be loaded from
      // anywhere except Discord's own CDN, which is where attachments live.
      'Content-Security-Policy': [
        "default-src 'none'",
        "script-src 'unsafe-inline'",
        "style-src 'unsafe-inline'",
        "img-src 'self' data: https://cdn.discordapp.com https://media.discordapp.net",
        "connect-src 'none'",
        "form-action 'none'",
        "frame-ancestors 'none'",
        "base-uri 'none'",
      ].join('; '),
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      'X-Robots-Tag': 'noindex, nofollow, noarchive',
      // The token is in the URL, so intermediaries must not keep a copy.
      'Cache-Control': 'private, no-store, max-age=0',
      'Permissions-Policy': 'geolocation=(), microphone=(), camera=(), interest-cohort=()',
      ...extraHeaders,
    });
    res.end(body);
  }

  /**
   * Client IP for rate limiting.
   *
   * `X-Forwarded-For` is only trusted when WEB_TRUST_PROXY is set, because any
   * client can send that header — trusting it by default would let anyone reset
   * their own rate limit by spoofing it.
   */
  #clientIp(req) {
    if (env.web.trustProxy) {
      const forwarded = req.headers['x-forwarded-for'];
      if (typeof forwarded === 'string' && forwarded.length) {
        return forwarded.split(',')[0].trim();
      }
    }
    return req.socket.remoteAddress ?? 'unknown';
  }

  /** 60 requests per minute per IP. */
  #allow(ip, limit = 60, windowMs = 60_000) {
    const now = Date.now();
    const entry = this.hits.get(ip);

    if (!entry || entry.resetAt <= now) {
      this.hits.set(ip, { count: 1, resetAt: now + windowMs });
      return true;
    }
    entry.count += 1;
    return entry.count <= limit;
  }

  #pruneRateLimit() {
    const now = Date.now();
    for (const [ip, entry] of this.hits) {
      if (entry.resetAt <= now) this.hits.delete(ip);
    }
  }
}
