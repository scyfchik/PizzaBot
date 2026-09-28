import './helpers/env.js';
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

const { RobloxApi, RobloxApiError } = await import('../src/systems/roblox/RobloxApi.js');
const { PlayerLookupService } = await import('../src/systems/roblox/PlayerLookupService.js');
const { GameStatusService } = await import('../src/systems/roblox/GameStatusService.js');

/**
 * Deterministic tests against a fake `fetch`.
 * The response bodies below are copied from real Roblox API responses.
 */
const realFetch = globalThis.fetch;
let routes;
let calls;

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

beforeEach(() => {
  calls = [];
  routes = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    for (const [match, handler] of routes) {
      if (String(url).includes(match)) return handler(url, init);
    }
    throw new Error(`Unrouted request in test: ${url}`);
  };
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

const route = (match, handler) => routes.push([match, handler]);

// Real shapes, from the live API.
const KIRISHINP = { requestedUsername: 'kirishinp', hasVerifiedBadge: false, id: 2656101446, name: 'kirishinp', displayName: 'Taenny' };
const USER_156 = {
  description: 'Welcome to Roblox!', created: '2006-03-08T17:17:52.9Z', isBanned: false,
  externalAppDisplayName: null, hasVerifiedBadge: true, id: 156, name: 'builderman', displayName: 'builderman',
};

describe('PlayerLookupService.resolveUsername', () => {
  test('resolves a real username to id and display name', async () => {
    route('usernames/users', () => json({ data: [KIRISHINP] }));
    const players = new PlayerLookupService(new RobloxApi());

    const result = await players.resolveUsername('kirishinp');
    assert.deepEqual(result, { id: '2656101446', name: 'kirishinp', displayName: 'Taenny', hasVerifiedBadge: false });
  });

  test('includes banned accounts, because appeals need them', async () => {
    route('usernames/users', (_, init) => {
      assert.equal(JSON.parse(init.body).excludeBannedUsers, false);
      return json({ data: [KIRISHINP] });
    });
    await new PlayerLookupService(new RobloxApi()).resolveUsername('kirishinp');
  });

  test('returns null for an unknown username (absent from data, not an error)', async () => {
    route('usernames/users', () => json({ data: [] }));
    assert.equal(await new PlayerLookupService(new RobloxApi()).resolveUsername('nobody_here_123'), null);
  });

  test('rejects impossible usernames without making a request', async () => {
    const players = new PlayerLookupService(new RobloxApi());
    for (const bad of ['', 'ab', 'a'.repeat(21), 'has space', 'semi;colon', '../etc', '<script>']) {
      assert.equal(await players.resolveUsername(bad), null, bad);
    }
    assert.equal(calls.length, 0);
  });

  test('is case-insensitive and cached', async () => {
    route('usernames/users', () => json({ data: [KIRISHINP] }));
    const players = new PlayerLookupService(new RobloxApi());
    await players.resolveUsername('Kirishinp');
    await players.resolveUsername('KIRISHINP');
    assert.equal(calls.length, 1);
  });

  test('caches misses too, so a typo is not re-queried every time', async () => {
    route('usernames/users', () => json({ data: [] }));
    const players = new PlayerLookupService(new RobloxApi());
    await players.resolveUsername('typo_name');
    await players.resolveUsername('typo_name');
    assert.equal(calls.length, 1);
  });
});

describe('PlayerLookupService.getUser', () => {
  test('parses account details', async () => {
    route('/v1/users/156', () => json(USER_156));
    const user = await new PlayerLookupService(new RobloxApi()).getUser('156');
    assert.equal(user.name, 'builderman');
    assert.equal(user.isBanned, false);
    assert.ok(user.created instanceof Date);
    assert.equal(user.created.getUTCFullYear(), 2006);
  });

  test('returns null for a non-existent id (Roblox answers 404)', async () => {
    route('/v1/users/', () => json({ errors: [{ code: 3, message: 'The user id is invalid.' }] }, 404));
    assert.equal(await new PlayerLookupService(new RobloxApi()).getUser('999999999999'), null);
  });

  test('rejects non-numeric ids without a request', async () => {
    assert.equal(await new PlayerLookupService(new RobloxApi()).getUser('../../admin'), null);
    assert.equal(calls.length, 0);
  });
});

describe('PlayerLookupService.getHeadshot', () => {
  test('returns the URL when the thumbnail is ready', async () => {
    route('avatar-headshot', () => json({ data: [{ targetId: 156, state: 'Completed', imageUrl: 'https://tr.rbxcdn.com/x.png' }] }));
    assert.equal(await new PlayerLookupService(new RobloxApi()).getHeadshot('156'), 'https://tr.rbxcdn.com/x.png');
  });

  test('returns null for a moderated or pending avatar rather than a broken image', async () => {
    route('avatar-headshot', () => json({ data: [{ targetId: 156, state: 'Blocked', imageUrl: '' }] }));
    assert.equal(await new PlayerLookupService(new RobloxApi()).getHeadshot('156'), null);
  });
});

describe('PlayerLookupService.getStudioGroupRole', () => {
  test('finds the role in the configured group only', async () => {
    route('groups/roles', () => json({
      data: [
        { group: { id: 9, name: 'Other' }, role: { id: 11, name: 'Owner', rank: 255 } },
        { group: { id: 3829, name: 'Studio' }, role: { id: 15271, name: 'Tester', rank: 50 } },
      ],
    }));
    const players = new PlayerLookupService(new RobloxApi(), { groupId: '3829' });
    assert.deepEqual(await players.getStudioGroupRole('156'), { rank: 50, name: 'Tester' });
  });

  test('makes no request when no group is configured', async () => {
    assert.equal(await new PlayerLookupService(new RobloxApi()).getStudioGroupRole('156'), null);
    assert.equal(calls.length, 0);
  });
});

describe('PlayerLookupService.getProfile', () => {
  const happyPath = () => {
    route('usernames/users', () => json({ data: [{ ...KIRISHINP }] }));
    route('/v1/users/2656101446/username-history', () => json({ data: [{ name: 'OldName' }] }));
    route('/v1/users/2656101446', () => json({ ...USER_156, id: 2656101446, name: 'kirishinp', displayName: 'Taenny', created: '2021-01-01T00:00:00Z' }));
    route('avatar-headshot', () => json({ data: [{ state: 'Completed', imageUrl: 'https://tr.rbxcdn.com/k.png' }] }));
  };

  test('combines every lookup', async () => {
    happyPath();
    const p = await new PlayerLookupService(new RobloxApi()).getProfile('kirishinp');
    assert.equal(p.id, '2656101446');
    assert.equal(p.displayName, 'Taenny');
    assert.equal(p.headshotUrl, 'https://tr.rbxcdn.com/k.png');
    assert.deepEqual(p.previousNames, ['OldName']);
    assert.ok(p.accountAgeDays > 365);
    assert.equal(p.profileUrl, 'https://www.roblox.com/users/2656101446/profile');
    assert.equal(p.partial, false);
  });

  test('accepts a numeric id directly', async () => {
    happyPath();
    const p = await new PlayerLookupService(new RobloxApi()).getProfile('2656101446');
    assert.equal(p.name, 'kirishinp');
    assert.ok(!calls.some((c) => c.url.includes('usernames/users')), 'should not resolve a username');
  });

  test('returns null when the account does not exist', async () => {
    route('usernames/users', () => json({ data: [] }));
    assert.equal(await new PlayerLookupService(new RobloxApi()).getProfile('ghost_player'), null);
  });

  test('a failing thumbnail service yields a partial profile, not a failure', async () => {
    route('usernames/users', () => json({ data: [KIRISHINP] }));
    route('username-history', () => json({ data: [] }));
    route('/v1/users/2656101446', () => json({ ...USER_156, id: 2656101446, name: 'kirishinp' }));
    route('avatar-headshot', () => json({}, 503));

    const p = await new PlayerLookupService(new RobloxApi()).getProfile('kirishinp');
    assert.equal(p.name, 'kirishinp');
    assert.equal(p.headshotUrl, null);
    assert.equal(p.partial, true);
  });
});

describe('PlayerLookupService.tryGetProfile — must never throw', () => {
  test('network failure becomes { unavailable: true }', async () => {
    globalThis.fetch = async () => { throw new TypeError('fetch failed'); };
    const result = await new PlayerLookupService(new RobloxApi()).tryGetProfile('kirishinp');
    assert.deepEqual(result, { profile: null, unavailable: true });
  });

  test('a Roblox outage (5xx after retry) becomes { unavailable: true }', async () => {
    route('usernames/users', () => json({}, 503));
    const result = await new PlayerLookupService(new RobloxApi()).tryGetProfile('kirishinp');
    assert.equal(result.unavailable, true);
  });

  test('even an unexpected bug does not escape', async () => {
    route('usernames/users', () => new Response('not json at all', { status: 200 }));
    const result = await new PlayerLookupService(new RobloxApi()).tryGetProfile('kirishinp');
    assert.equal(result.unavailable, true);
  });

  test('a missing account is not "unavailable"', async () => {
    route('usernames/users', () => json({ data: [] }));
    assert.deepEqual(await new PlayerLookupService(new RobloxApi()).tryGetProfile('ghost_player'), {
      profile: null,
      unavailable: false,
    });
  });
});

describe('RobloxApi transport', () => {
  test('retries once on 429 and then succeeds', async () => {
    let n = 0;
    route('usernames/users', () => (++n === 1 ? json({}, 429, { 'retry-after': '0' }) : json({ data: [KIRISHINP] })));
    const result = await new PlayerLookupService(new RobloxApi()).resolveUsername('kirishinp');
    assert.equal(result.id, '2656101446');
    assert.equal(n, 2);
  });

  test('gives up after one retry and throws RobloxApiError', async () => {
    route('usernames/users', () => json({}, 500));
    await assert.rejects(
      new PlayerLookupService(new RobloxApi()).resolveUsername('kirishinp'),
      RobloxApiError,
    );
  });

  test('cache is bounded', async () => {
    const api = new RobloxApi();
    for (let i = 0; i < 5010; i++) await api.cached(`k${i}`, 60_000, async () => i);
    assert.ok(api.cache.size <= 5000, `cache grew to ${api.cache.size}`);
    assert.ok(!api.cache.has('k0'), 'oldest entry should be evicted first');
  });
});

describe('GameStatusService', () => {
  const GAME = { id: 383310974, rootPlaceId: 920587237, name: 'Pizza Guy\'s Time', creator: { name: 'Studio' },
    playing: 145413, visits: 44871340250, maxPlayers: 35, favoritedCount: 29668549,
    created: '2017-07-14T19:26:21.347Z', updated: '2026-09-28T16:59:45.4838142Z' };

  test('is unconfigured and silent without a universe id', async () => {
    const game = new GameStatusService(new RobloxApi());
    assert.equal(game.configured, false);
    assert.equal(await game.getStats(), null);
    assert.equal(calls.length, 0);
  });

  test('combines game stats with votes', async () => {
    route('games/votes', () => json({ data: [{ id: 383310974, upVotes: 90, downVotes: 10 }] }));
    route('v1/games?universeIds', () => json({ data: [GAME] }));
    const s = await new GameStatusService(new RobloxApi(), { universeId: '383310974' }).getStats();
    assert.equal(s.playing, 145413);
    assert.equal(s.visits, 44871340250);
    assert.equal(s.likeRatio, 0.9);
    assert.equal(s.url, 'https://www.roblox.com/games/920587237');
  });

  test('a votes outage does not lose the player count', async () => {
    route('games/votes', () => json({}, 503));
    route('v1/games?universeIds', () => json({ data: [GAME] }));
    const s = await new GameStatusService(new RobloxApi(), { universeId: '383310974' }).getStats();
    assert.equal(s.playing, 145413);
    assert.equal(s.likeRatio, null);
  });

  test('an unknown universe returns null (usually a Place ID pasted by mistake)', async () => {
    route('games/votes', () => json({ data: [] }));
    route('v1/games?universeIds', () => json({ data: [] }));
    assert.equal(await new GameStatusService(new RobloxApi(), { universeId: '920587237' }).getStats(), null);
  });
});
