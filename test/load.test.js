import './helpers/env.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'src');

const { PizzaClient } = await import('../src/core/PizzaClient.js');
const client = new PizzaClient();
await client.loadAll();

/** Every command the bot is expected to register — the contract with Discord. */
const EXPECTED_COMMANDS = [
  'bug', 'case', 'config', 'game', 'panel', 'player', 'security', 'setup', 'staff', 'ticket', 'tickets', 'transcript',
];

describe('code loads', () => {
  test('exactly the expected commands', () => {
    assert.deepEqual([...client.commands.commands.keys()].sort(), EXPECTED_COMMANDS);
  });

  test('every command serialises to a valid Discord payload', () => {
    for (const [name, cmd] of client.commands.commands) {
      const json = cmd.data.toJSON();
      assert.equal(json.name, name);
      assert.ok(json.description.length >= 1 && json.description.length <= 100, `/${name} description`);
    }
  });

  test('Discord limits: ≤25 options per level, names ≤32 chars', () => {
    const walk = (options, path) => {
      const list = options ?? [];
      assert.ok(list.length <= 25, `${path} has ${list.length} options`);
      for (const o of list) {
        assert.ok(o.name.length <= 32, `${path}.${o.name} name too long`);
        assert.ok(o.description.length <= 100, `${path}.${o.name} description too long`);
        walk(o.options, `${path}.${o.name}`);
      }
    };
    for (const [name, cmd] of client.commands.commands) walk(cmd.data.toJSON().options, `/${name}`);
  });

  test('every command declares its permission gate', () => {
    for (const [name, cmd] of client.commands.commands) {
      assert.notEqual(cmd.meta?.permission, undefined, `/${name} has no meta.permission`);
    }
  });

  test('interaction handlers and events are bound', () => {
    assert.ok(client.interactions.handlers.size >= 10);
    for (const event of ['interactionCreate', 'messageCreate', 'guildMemberAdd', 'guildBanAdd', 'channelDelete']) {
      assert.ok(client.eventNames().includes(event), `${event} not bound`);
    }
  });
});

describe('scope — things Pizza Bot deliberately does not do', () => {
  test('no verification: no /verify, no link subcommand, no RobloxProfile model', () => {
    assert.ok(!client.commands.commands.has('verify'));
    const player = client.commands.get('player').data.toJSON();
    const subs = player.options.map((o) => o.name);
    assert.ok(!subs.includes('link') && !subs.includes('unlink'), `player subcommands: ${subs}`);
    assert.ok(!existsSync(join(SRC, 'database/models/RobloxProfile.js')));
  });

  test('no chat moderation execution', () => {
    for (const gone of ['warn', 'kick', 'ban', 'unban', 'timeout', 'clear']) {
      assert.ok(!client.commands.commands.has(gone), `/${gone} should not exist`);
    }
    assert.ok(!existsSync(join(SRC, 'systems/security/AntiSpam.js')));
  });

  test('MessageContent intent is not requested', () => {
    assert.doesNotMatch(readFileSync(join(SRC, 'core/PizzaClient.js'), 'utf8'), /GatewayIntentBits\.MessageContent/);
  });
});

describe('source hygiene', () => {
  const files = (function walk(dir) {
    return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(join(dir, e.name)) : e.name.endsWith('.js') ? [join(dir, e.name)] : [],
    );
  })(SRC);

  test('no import points at a file that does not exist', () => {
    for (const file of files) {
      const src = readFileSync(file, 'utf8');
      for (const m of src.matchAll(/from\s*['"](\.[^'"]+)['"]/g)) {
        assert.ok(existsSync(join(dirname(file), m[1])), `${file} imports missing ${m[1]}`);
      }
    }
  });

  test('no unused named imports', () => {
    const unused = [];
    for (const file of files) {
      const src = readFileSync(file, 'utf8');
      for (const m of src.matchAll(/import\s*\{([^}]+)\}\s*from/g)) {
        for (let name of m[1].split(',')) {
          name = name.trim().split(/\s+as\s+/).pop().trim();
          if (!name) continue;
          const uses = src.match(new RegExp(`\\b${name.replace(/[$]/g, '\\$')}\\b`, 'g'))?.length ?? 0;
          if (uses <= 1) unused.push(`${name} in ${file.replace(ROOT, '')}`);
        }
      }
    }
    assert.deepEqual(unused, []);
  });

  test('no mojibake from a bad re-encode (a real past incident)', () => {
    for (const file of files) {
      assert.doesNotMatch(readFileSync(file, 'utf8'), /в†|вЂ/, file);
    }
  });
});
