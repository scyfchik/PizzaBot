import './helpers/env.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const { compare } = await import('../src/core/commandSync.js');
const { CommandRegistry } = await import('../src/core/CommandRegistry.js');

/**
 * The sync must re-register when commands really changed, and must NOT on a
 * normal restart. Getting the second half wrong means a write to Discord on
 * every boot; getting the first half wrong is how the bot "stopped working".
 */

/** Simulate what Discord echoes back: extra fields, omitted defaults. */
function asDiscordReturnsIt(command) {
  const strip = (options) =>
    (options ?? []).map((o) => {
      const copy = { ...o };
      if (copy.required === false) delete copy.required;
      if (copy.autocomplete === false) delete copy.autocomplete;
      if (copy.options) copy.options = strip(copy.options);
      return copy;
    });

  return {
    ...command,
    id: '1234567890',
    application_id: '100000000000000001',
    guild_id: '100000000000000002',
    version: '1',
    nsfw: false,
    contexts: null,
    integration_types: [0],
    options: strip(command.options),
  };
}

const registry = new CommandRegistry();
await registry.load(fileURLToPath(new URL('../src/commands', import.meta.url)));
const local = registry.toJSON();

describe('command sync — compare()', () => {
  test('the real command set, echoed back by Discord, is "in sync"', () => {
    const live = local.map(asDiscordReturnsIt);
    const diff = compare(local, live);
    assert.equal(diff.changed, false, JSON.stringify(diff));
  });

  test('reproduces the actual outage: stale and missing commands are detected', () => {
    // What Discord held vs what the code had, observed live on 2026-09-28.
    const liveNames = ['ban', 'bug', 'case', 'changelog', 'clear', 'config', 'history', 'kick', 'lockdown',
      'panel', 'profile', 'setup', 'staff', 'staffinfo', 'ticket', 'timeout', 'unban', 'verify', 'warn'];
    const live = liveNames.map((name) => ({ name, description: 'x', type: 1, options: [] }));

    const diff = compare(local, live);
    assert.equal(diff.changed, true);
    for (const gone of ['warn', 'ban', 'kick', 'verify', 'profile', 'history', 'staffinfo', 'lockdown', 'changelog']) {
      assert.ok(diff.removed.includes(gone), `should flag /${gone} as stale`);
    }
    for (const missing of ['player', 'game', 'security', 'tickets', 'transcript']) {
      assert.ok(diff.added.includes(missing), `should flag /${missing} as missing`);
    }
  });

  test('a changed option (new subcommand) is detected as "modified"', () => {
    const live = local.map(asDiscordReturnsIt);
    const player = live.find((c) => c.name === 'player');
    player.options = [...player.options, { type: 1, name: 'link', description: 'old', options: [] }];

    const diff = compare(local, live);
    assert.deepEqual(diff.modified, ['player']);
  });

  test('a changed description is detected', () => {
    const live = local.map(asDiscordReturnsIt);
    live[0].description = 'something else';
    assert.equal(compare(local, live).changed, true);
  });

  test('changed default permissions are detected', () => {
    const live = local.map(asDiscordReturnsIt);
    const gated = live.find((c) => c.default_member_permissions);
    gated.default_member_permissions = '8';
    assert.ok(compare(local, live).modified.includes(gated.name));
  });

  test('an empty registry against a populated Discord removes everything', () => {
    const diff = compare([], local);
    assert.equal(diff.removed.length, local.length);
  });
});
