import './helpers/env.js';
import { connect, disconnect } from './helpers/db.js';
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';

/**
 * Player analytics and appeal evidence: what the game reports, how it folds
 * into per-player totals, and the Roblox-side game pass check.
 *
 * These numbers decide ban appeals and refunds, so the tests focus on the ways
 * they could silently be wrong: double counting, lost grants, poisoned keys.
 */
await connect();
const ago = (days) => new Date(Date.now() - days * 86_400_000).toISOString();
const { GameDataService } = await import('../src/systems/game/GameDataService.js');
const { GamePassService } = await import('../src/systems/roblox/GamePassService.js');
const { GameEvent } = await import('../src/database/models/GameEvent.js');
// The eventId unique index is what deduplicates; make sure it exists first.
await GameEvent.init();
const { Purchase } = await import('../src/database/models/Purchase.js');
const { GuildConfig } = await import('../src/database/models/GuildConfig.js');
const { getConfig, clearConfigCache, CONFIG_SCHEMA_VERSION } = await import('../src/config/guildConfig.js');
const { DEFAULT_RANKS, Permission } = await import('../src/config/constants.js');
const { kdRatio } = await import('../src/commands/player/player.js');

const GUILD = '100000000000000003';
const notified = [];
const gameData = new GameDataService(
  { channels: { cache: new Map() } },
  { server: async (_g, embed) => notified.push(embed) },
);

let seq = 0;
const ev = (type, robloxId, data = {}, extra = {}) =>
  gameData.ingest(GUILD, { type, robloxId, robloxUsername: `P${robloxId}`, data, ...extra });
const uid = () => String(900000 + ++seq);

after(disconnect);

describe('combat', () => {
  test('kills and deaths count separately and K/D is derived', async () => {
    const id = uid();
    await ev('player_kill', id);
    await ev('player_kill', id);
    await ev('player_kill', id);
    await ev('player_death', id);

    const stats = await gameData.getStats(GUILD, id);
    assert.equal(stats.combat.kills, 3);
    assert.equal(stats.combat.deaths, 1);
    assert.ok(stats.combat.lastKillAt);
    assert.equal(kdRatio(3, 1), '3.00');
    assert.equal(kdRatio(5, 0), '5.00');
    assert.equal(kdRatio(0, 0), '0.00');
  });

  test('a retried event with the same eventId is not counted twice', async () => {
    const id = uid();
    const eventId = 'a1b2c3d4-0000-4000-8000-000000000001';
    const first = await ev('player_kill', id, {}, { eventId });
    const again = await ev('player_kill', id, {}, { eventId });

    assert.deepEqual(first, { ok: true });
    assert.deepEqual(again, { ok: true, duplicate: true });
    assert.equal((await gameData.getStats(GUILD, id)).combat.kills, 1);
    assert.equal(await GameEvent.countDocuments({ guildId: GUILD, eventId }), 1);
  });

  test('events without an eventId are all kept (old reporters)', async () => {
    const id = uid();
    await ev('player_death', id);
    await ev('player_death', id);
    assert.equal((await gameData.getStats(GUILD, id)).combat.deaths, 2);
  });

  test('a malformed eventId is rejected', async () => {
    const res = await ev('player_kill', uid(), {}, { eventId: '$where: 1' });
    assert.equal(res.ok, false);
  });
});

describe('anticheat', () => {
  test('flags aggregate per check, severity and first/last time', async () => {
    const id = uid();
    await ev('anticheat_flag', id, { check: 'Speed', severity: 'low' }, { occurredAt: ago(20) });
    await ev('anticheat_flag', id, { check: 'speed', severity: 'high', action: 'kicked' }, { occurredAt: ago(10) });
    await ev('anticheat_flag', id, { check: 'fly', severity: 'medium' }, { occurredAt: ago(1) });

    const { anticheat } = await gameData.getStats(GUILD, id);
    assert.equal(anticheat.flags, 3);
    assert.equal(anticheat.highSeverity, 1);
    assert.deepEqual(anticheat.byCheck, { speed: 2, fly: 1 });
    // Events can arrive out of order; first/last reflect arrival, so only
    // check that first was set once and last moved to the latest event.
    assert.ok(anticheat.firstFlagAt < anticheat.lastFlagAt);
    assert.ok(Date.now() - anticheat.firstFlagAt > 19 * 86_400_000);
    assert.equal(anticheat.lastCheck, 'fly');

    const list = await gameData.anticheatFlags(GUILD, id);
    assert.equal(list.length, 3);
  });

  test('check names cannot inject into the update path', async () => {
    const id = uid();
    await ev('anticheat_flag', id, { check: '$set.evil' });
    await ev('anticheat_flag', id, { check: '' });
    const { anticheat } = await gameData.getStats(GUILD, id);
    for (const key of Object.keys(anticheat.byCheck)) {
      assert.match(key, /^[a-z0-9_]+$/);
    }
    assert.ok('unknown' in anticheat.byCheck);
  });

  test('high severity notifies staff, low does not', async () => {
    const before = notified.length;
    await ev('anticheat_flag', uid(), { check: 'speed', severity: 'low' });
    assert.equal(notified.length, before);
    await ev('anticheat_flag', uid(), { check: 'speed', severity: 'high' });
    assert.equal(notified.length, before + 1);
  });

  test('anticheat events are retained for a year', async () => {
    const id = uid();
    await ev('anticheat_flag', id, { check: 'fly' });
    const doc = await GameEvent.findOne({ guildId: GUILD, robloxId: id }).lean();
    const days = (doc.expiresAt - Date.now()) / 86_400_000;
    assert.ok(days > 360 && days <= 365, `retention ${days}`);
  });
});

describe('purchases', () => {
  test('breakdown separates granted, not granted and product types', async () => {
    const id = uid();
    await ev('purchase_completed', id, { transactionId: `t-${id}-1`, productName: 'Floss', robuxAmount: 75, productType: 'emote' });
    await ev('purchase_failed', id, { transactionId: `t-${id}-2`, productName: 'Coins', robuxAmount: 50, failureReason: 'DataStore' });
    await ev('gamepass_purchased', id, { gamePassId: '123', productName: 'VIP', robuxAmount: 299 });
    await ev('gamepass_purchased', id, { gamePassId: '123', productName: 'VIP', robuxAmount: 299 }); // replay

    const b = await gameData.purchaseBreakdown(GUILD, id);
    assert.deepEqual(b.emote, { granted: 1, failed: 0, refunded: 0, robux: 75 });
    assert.equal(b.developer_product.failed, 1);
    assert.equal(b.gamepass.granted, 1);

    const stats = await gameData.getStats(GUILD, id);
    assert.equal(stats.economy.robuxSpent, 374);
    assert.equal(stats.economy.failedPurchaseCount, 1);

    const failed = await gameData.purchases(GUILD, id, 10, { status: 'failed' });
    assert.equal(failed.length, 1);
  });

  test('an unknown product type falls back instead of failing validation', async () => {
    const id = uid();
    await ev('purchase_completed', id, { transactionId: `t-${id}`, robuxAmount: 5, productType: 'hat<script>' });
    const p = await Purchase.findOne({ guildId: GUILD, transactionId: `t-${id}` }).lean();
    assert.equal(p.productType, 'developer_product');
  });

  test('a receipt that failed then succeeded on retry ends up granted, counted once', async () => {
    const id = uid();
    const tx = `retry-${id}`;
    await ev('purchase_failed', id, { transactionId: tx, robuxAmount: 100, failureReason: 'timeout' });
    await ev('purchase_completed', id, { transactionId: tx, robuxAmount: 100, productName: 'Coins' });
    await ev('purchase_completed', id, { transactionId: tx, robuxAmount: 100, productName: 'Coins' });

    const p = await Purchase.findOne({ guildId: GUILD, transactionId: tx }).lean();
    assert.equal(p.status, 'completed');
    assert.equal(p.failureReason, null);

    const { economy } = await gameData.getStats(GUILD, id);
    assert.equal(economy.robuxSpent, 100);
    assert.equal(economy.purchaseCount, 1);
    assert.equal(economy.failedPurchaseCount, 0);
  });

  test('a late failure never undoes a grant', async () => {
    const id = uid();
    const tx = `late-${id}`;
    await ev('purchase_completed', id, { transactionId: tx, robuxAmount: 40 });
    await ev('purchase_failed', id, { transactionId: tx, failureReason: 'late' });
    const p = await Purchase.findOne({ guildId: GUILD, transactionId: tx }).lean();
    assert.equal(p.status, 'completed');
  });
});

describe('leaderboard', () => {
  test('orders by the requested field', async () => {
    const a = uid();
    const b = uid();
    for (let i = 0; i < 5; i++) await ev('player_kill', a);
    for (let i = 0; i < 9; i++) await ev('player_kill', b);
    const top = await gameData.leaderboard(GUILD, 'kills', 2);
    assert.deepEqual(top.map((r) => r.robloxId), [b, a]);
  });
});

describe('GamePassService', () => {
  function fakeApi(routes) {
    const calls = [];
    return {
      calls,
      cached: (_k, _ttl, fn) => fn(),
      async request(url) {
        calls.push(url);
        for (const [pattern, reply] of routes) {
          if (url.includes(pattern)) {
            if (reply instanceof Error) throw reply;
            return typeof reply === 'function' ? reply(url) : reply;
          }
        }
        throw new Error(`unexpected ${url}`);
      },
    };
  }

  test('not configured without a universe id', async () => {
    const svc = new GamePassService(fakeApi([]), {});
    assert.equal(svc.configured, false);
    assert.deepEqual(await svc.listGamePasses(), []);
  });

  test('follows pagination and reports owned / not owned / unknown', async () => {
    const api = fakeApi([
      ['pageToken=p2', { gamePasses: [{ id: 3, name: 'Radio', price: 50 }] }],
      ['game-passes/v1', { gamePasses: [{ id: 1, displayName: 'VIP', price: 299 }, { id: 2, name: '2x' }], nextPageToken: 'p2' }],
      ['GamePass/1', { data: [{ id: 1 }] }],
      ['GamePass/2', { data: [] }],
      ['GamePass/3', new Error('timeout')],
    ]);
    const svc = new GamePassService(api, { universeId: '42' });
    const result = await svc.ownership('555');

    assert.deepEqual(
      result.map((p) => [p.id, p.name, p.owned]),
      [['1', 'VIP', true], ['2', '2x', false], ['3', 'Radio', null]],
    );
  });

  test('refuses non-numeric ids without a request', async () => {
    const api = fakeApi([]);
    const svc = new GamePassService(api, { universeId: '42' });
    assert.equal(await svc.owns('abc', '1'), null);
    assert.equal(api.calls.length, 0);
  });
});

describe('guild config migration', () => {
  test('v1 ranks gain missing default nodes once; custom and * ranks untouched', async () => {
    const guildId = '100000000000000099';
    const mod = DEFAULT_RANKS.find((r) => r.key === 'moderator');
    await GuildConfig.create({
      guildId,
      schemaVersion: 1,
      staffRanks: [
        { ...mod, roleIds: [], permissions: [Permission.TICKET_CLAIM] },
        { key: 'owner', name: 'Owner', position: 100, roleIds: [], permissions: ['*'] },
        { key: 'custom_helper', name: 'Helper', position: 5, roleIds: [], permissions: [Permission.TICKET_CLAIM] },
      ],
    });

    clearConfigCache();
    const config = await getConfig(guildId);
    const byKey = Object.fromEntries(config.staffRanks.map((r) => [r.key, [...r.permissions]]));

    assert.equal(config.schemaVersion, CONFIG_SCHEMA_VERSION);
    assert.ok(byKey.moderator.includes(Permission.PLAYER_VIEW));
    assert.equal(new Set(byKey.moderator).size, byKey.moderator.length, 'no duplicates');
    assert.deepEqual(byKey.owner, ['*']);
    assert.deepEqual(byKey.custom_helper, [Permission.TICKET_CLAIM]);

    // An admin removes a node afterwards; the migration must not re-add it.
    await GuildConfig.updateOne(
      { guildId, 'staffRanks.key': 'moderator' },
      { $pull: { 'staffRanks.$.permissions': Permission.PLAYER_VIEW } },
    );
    clearConfigCache();
    const again = await getConfig(guildId);
    assert.ok(!again.staffRanks.find((r) => r.key === 'moderator').permissions.includes(Permission.PLAYER_VIEW));
  });
});
