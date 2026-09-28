/**
 * Live check against the real Roblox API.
 *
 *   npm run test:roblox-live
 *
 * Not part of `npm test`: it needs network access and depends on Roblox being
 * up, which a unit test must not. Run it after changing the Roblox client, or
 * when Roblox changes an API, to confirm the parsing still matches reality.
 *
 * Uses long-lived, well-known accounts so the assertions stay stable.
 */
import '../helpers/env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { RobloxService } = await import('../../src/systems/roblox/index.js');

// builderman (156) is Roblox's founder account and has existed since 2006.
// Adopt Me! is a long-running experience used only as a stable known universe.
const roblox = new RobloxService({ universeId: '383310974', groupId: '3829' });

test('resolves a real username', async () => {
  const user = await roblox.players.resolveUsername('builderman');
  assert.equal(user.id, '156');
});

test('a valid-looking but non-existent username resolves to null', async () => {
  // Must pass the 3-20 character format check, or no request is made and the
  // "not found" path is never exercised against the real API.
  const name = 'pzbNoSuchUser8k2q';
  assert.ok(name.length <= 20);

  const before = Date.now();
  assert.equal(await roblox.players.resolveUsername(name), null);
  assert.ok(Date.now() - before > 20, 'a real request should have been made');
});

test('full profile: age, avatar, group role', async () => {
  const p = await roblox.players.getProfile('builderman');
  assert.equal(p.id, '156');
  assert.equal(p.created.getUTCFullYear(), 2006);
  assert.ok(p.accountAgeDays > 7000, `age ${p.accountAgeDays}`);
  assert.match(p.headshotUrl ?? '', /^https:\/\/tr\.rbxcdn\.com\//);
  assert.ok(p.groupRole, 'builderman is in the Roblox staff group');
  assert.equal(p.isBanned, false);
});

test('a non-existent id returns null rather than throwing', async () => {
  assert.equal(await roblox.players.getUser('999999999999'), null);
});

test('live universe stats', async () => {
  const s = await roblox.game.getStats();
  assert.ok(s.visits > 1_000_000_000, `visits ${s.visits}`);
  assert.ok(s.playing >= 0);
  assert.ok(s.likeRatio > 0 && s.likeRatio <= 1, `ratio ${s.likeRatio}`);
  assert.match(s.url, /^https:\/\/www\.roblox\.com\/games\/\d+$/);
});
