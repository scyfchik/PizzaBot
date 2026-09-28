import './helpers/env.js';
import { setEnv } from './helpers/env.js';
import { connect, disconnect } from './helpers/db.js';
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

/**
 * The web server is the only part of the bot reachable from outside Discord.
 * It serves personal data (transcripts) and accepts writes (game ingest), so
 * these tests attack it rather than just exercise it.
 */
const PORT = '39491';
const KEY = 'test-key-that-is-at-least-32-characters-long';
setEnv({
  WEB_ENABLED: 'true',
  WEB_PORT: PORT,
  WEB_BASE_URL: `http://127.0.0.1:${PORT}`,
  GAME_API_KEY: KEY,
});

await connect();
const { TranscriptServer } = await import('../src/web/TranscriptServer.js');
const { IngestHandler } = await import('../src/web/ingest.js');
const { GameDataService } = await import('../src/systems/game/GameDataService.js');
const { Transcript, generateToken, hashToken, tokensMatch } = await import('../src/database/models/Transcript.js');
const models = await import('../src/database/models/index.js');

const GUILD = '100000000000000002';
const origin = `http://127.0.0.1:${PORT}`;
const gameData = new GameDataService({ channels: { cache: new Map() } }, { server: async () => null });
const server = new TranscriptServer(new IngestHandler(gameData, GUILD));

const XSS = '</script><script>window.__pwned=1</script>';
const IMG = '<img src=x onerror="window.__pwned=1">';

let token;
let revokedToken;
let expiredToken;

before(async () => {
  await server.start();

  token = generateToken();
  await Transcript.create({
    guildId: GUILD,
    ticketId: 152,
    tokenHash: hashToken(token),
    meta: {
      categoryLabel: 'Ban Appeal', guildName: "Pizza Guy's Time", openerTag: `Taenny${IMG}`,
      robloxUsername: 'kirishinp', closeReason: `Resolved. ${XSS}`,
      responses: [{ key: 'appeal', label: `Why?${IMG}`, value: `Please ${XSS}` }],
    },
    messages: [
      { id: '1', authorTag: 'Taenny', content: `hello ${XSS} ${IMG}`, createdAt: new Date(), attachments: [], embeds: [] },
      { id: '2', authorTag: 'Staff', isStaff: true, content: 'Looking', createdAt: new Date(),
        attachments: [{ name: 'proof.png', url: 'https://cdn.discordapp.com/x.png', contentType: 'image/png' }], embeds: [] },
    ],
    messageCount: 2,
    expiresAt: new Date(Date.now() + 86_400_000),
  });

  revokedToken = generateToken();
  await Transcript.create({ guildId: GUILD, ticketId: 153, tokenHash: hashToken(revokedToken), revoked: true });

  expiredToken = generateToken();
  await Transcript.create({ guildId: GUILD, ticketId: 154, tokenHash: hashToken(expiredToken), expiresAt: new Date(Date.now() - 1000) });
});

after(async () => {
  await server.stop();
  await disconnect();
});

// ================================================================== tokens

describe('tokens', () => {
  test('256-bit, URL-safe, unique', () => {
    const t = generateToken();
    assert.match(t, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(Buffer.from(t, 'base64url').length, 32);
    assert.notEqual(generateToken(), generateToken());
  });

  test('only the hash is stored; comparison is constant-time', async () => {
    const stored = await Transcript.findOne({ ticketId: 152 }).lean();
    assert.ok(!JSON.stringify(stored).includes(token), 'plaintext token must never be stored');
    assert.equal(stored.tokenHash.length, 64);
    assert.ok(tokensMatch(hashToken(token), hashToken(token)));
    assert.ok(!tokensMatch(hashToken(token), hashToken(generateToken())));
    assert.ok(!tokensMatch('', ''));
  });
});

// ================================================================== viewer

describe('transcript viewer', () => {
  test('serves a valid token', async () => {
    const res = await fetch(`${origin}/t/${token}`);
    assert.equal(res.status, 200);
    assert.match(await res.text(), /Ticket #000152/);
  });

  test('neutralises stored XSS in every user-controlled field', async () => {
    const html = await (await fetch(`${origin}/t/${token}`)).text();
    assert.ok(!html.includes('</script><script>window.__pwned'), 'script breakout');
    assert.ok(!html.includes('<img src=x onerror'), 'attribute injection');
    assert.ok(!html.includes('Taenny<img'), 'opener tag');
    assert.ok(!html.includes('.innerHTML'), 'client renders with textContent only');
  });

  test('security headers', async () => {
    const h = (await fetch(`${origin}/t/${token}`)).headers;
    const csp = h.get('content-security-policy') ?? '';
    assert.match(csp, /default-src 'none'/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.match(h.get('x-robots-tag') ?? '', /noindex/);
    assert.match(h.get('cache-control') ?? '', /no-store/);
    assert.equal(h.get('x-content-type-options'), 'nosniff');
    assert.equal(h.get('x-frame-options'), 'DENY');
    assert.equal(h.get('referrer-policy'), 'no-referrer');
  });

  test('/download serves the same bytes as an attachment', async () => {
    const view = await (await fetch(`${origin}/t/${token}`)).text();
    const dl = await fetch(`${origin}/t/${token}/download`);
    assert.equal(dl.status, 200);
    assert.match(dl.headers.get('content-disposition') ?? '', /attachment; filename="ticket-000152\.html"/);
    assert.equal((await dl.text()).length, view.length);
    assert.match(dl.headers.get('x-robots-tag') ?? '', /noindex/);
  });

  test('URL carries only the token — no ticket id', () => {
    const url = server.buildUrl(token);
    assert.equal(new URL(url).pathname, `/t/${token}`);
    assert.equal(server.buildDownloadUrl(token), `${url}/download`);
  });

  test('unknown, revoked and expired are indistinguishable 404s (no oracle)', async () => {
    const bodies = [];
    for (const t of [generateToken(), revokedToken, expiredToken]) {
      for (const suffix of ['', '/download']) {
        const res = await fetch(`${origin}/t/${t}${suffix}`);
        assert.equal(res.status, 404);
        bodies.push(await res.text());
      }
    }
    assert.equal(new Set(bodies).size, 1, 'all 404 bodies must be identical');
  });

  test('routing is strict', async () => {
    assert.equal((await fetch(`${origin}/t/${token}`, { method: 'POST' })).status, 405);
    assert.equal((await fetch(`${origin}/t/${token}`, { method: 'DELETE' })).status, 405);
    assert.equal((await fetch(`${origin}/t/${token}/raw`)).status, 404);
    assert.equal((await fetch(`${origin}/t/abc`)).status, 404);
    assert.equal((await fetch(`${origin}/t/../../etc/passwd`)).status, 404);
    assert.equal((await fetch(`${origin}/`)).status, 404);
    assert.match(await (await fetch(`${origin}/robots.txt`)).text(), /Disallow: \//);
    assert.equal((await fetch(`${origin}/health`)).status, 200);
  });

  test('view counter increments', async () => {
    const before = (await Transcript.findOne({ ticketId: 152 }).lean()).viewCount;
    await fetch(`${origin}/t/${token}`);
    await new Promise((r) => setTimeout(r, 200));
    assert.ok((await Transcript.findOne({ ticketId: 152 }).lean()).viewCount > before);
  });

  test('TTL index exists so expired transcripts are deleted by Mongo', async () => {
    await Transcript.syncIndexes();
    const indexes = await Transcript.collection.indexes();
    assert.ok(indexes.some((i) => i.key?.expiresAt === 1 && i.expireAfterSeconds === 0));
    assert.ok(indexes.some((i) => i.key?.tokenHash === 1 && i.unique));
  });
});

// ================================================================== ingest

const INGEST = `${origin}/api/v1/events`;
function signed(body, { key = KEY, ts = String(Math.floor(Date.now() / 1000)) } = {}) {
  const sig = createHmac('sha256', key).update(`${ts}.`).update(body).digest('hex');
  return { 'Content-Type': 'application/json', 'X-Timestamp': ts, 'X-Signature': `sha256=${sig}` };
}
const post = (body, headers) => fetch(INGEST, { method: 'POST', headers, body });

describe('game ingest — authentication', () => {
  const body = JSON.stringify([{ type: 'player_join', robloxId: '123' }]);

  test('a correctly signed request is accepted', async () => {
    assert.equal((await post(body, signed(body))).status, 200);
  });

  test('missing, wrong-key, tampered, stale and future signatures are rejected', async () => {
    const now = Math.floor(Date.now() / 1000);
    const tampered = JSON.stringify([{ type: 'player_death', robloxId: '999' }]);
    const cases = [
      [body, { 'Content-Type': 'application/json' }],
      [body, signed(body, { key: 'x'.repeat(40) })],
      [tampered, signed(body)],
      [body, signed(body, { ts: String(now - 3600) })],
      [body, signed(body, { ts: String(now + 3600) })],
      [body, { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` }],
    ];
    for (const [b, h] of cases) {
      const res = await post(b, h);
      assert.equal(res.status, 401);
      assert.deepEqual(await res.json(), { error: 'unauthorized' }, 'reason must stay vague');
    }
  });

  test('GET on the ingest route is refused', async () => {
    assert.equal((await fetch(INGEST)).status, 405);
  });
});

describe('game ingest — validation and idempotency', () => {
  test('unknown event types and non-numeric ids are rejected; good events in the batch survive', async () => {
    const b = JSON.stringify([
      { type: 'player_join', robloxId: '555' },
      { type: 'drop_database', robloxId: '555' },
      { type: 'player_join', robloxId: "1' OR 1=1" },
    ]);
    const r = await (await post(b, signed(b))).json();
    assert.equal(r.accepted, 1);
    assert.equal(r.rejected, 2);
  });

  test('oversized batch and invalid JSON are refused', async () => {
    const huge = JSON.stringify(Array.from({ length: 80 }, () => ({ type: 'player_death', robloxId: '1' })));
    assert.equal((await post(huge, signed(huge))).status, 400);
    assert.equal((await post('not json', signed('not json'))).status, 400);
  });

  test('a replayed purchase receipt is counted once', async () => {
    const b = JSON.stringify([{
      type: 'purchase_completed', robloxId: '777',
      data: { transactionId: 'receipt-1', productName: 'Skin', robuxAmount: 250 },
    }]);
    for (let i = 0; i < 3; i++) await post(b, signed(b));
    assert.equal(await models.Purchase.countDocuments({ transactionId: 'receipt-1' }), 1);
    assert.equal((await gameData.getStats(GUILD, '777')).economy.robuxSpent, 250);
  });

  test('level is absolute and session length is clamped', async () => {
    const lvl = JSON.stringify([{ type: 'level_up', robloxId: '888', data: { level: 45 } }]);
    await post(lvl, signed(lvl));
    await post(lvl, signed(lvl));
    assert.equal((await gameData.getStats(GUILD, '888')).progression.level, 45);

    const huge = JSON.stringify([{ type: 'player_leave', robloxId: '888', data: { sessionMinutes: 999999 } }]);
    await post(huge, signed(huge));
    assert.equal((await gameData.getStats(GUILD, '888')).activity.playtimeMinutes, 1440);
  });
});

// ================================================================== rate limit — last, it exhausts the budget

describe('rate limiting', () => {
  test('transcript lookups are throttled per IP', async () => {
    server.hits.clear();
    let limited = 0;
    for (let i = 0; i < 75; i++) {
      if ((await fetch(`${origin}/t/${generateToken()}`)).status === 429) limited++;
    }
    assert.ok(limited > 0, 'brute force should hit 429');
  });
});

describe('lifecycle', () => {
  test('listening reflects reality; links stop once stopped', async () => {
    const s = new TranscriptServer(null);
    assert.equal(s.listening, false);
    assert.equal(s.buildUrl('x'.repeat(43)), null, 'no links before start');
  });
});
