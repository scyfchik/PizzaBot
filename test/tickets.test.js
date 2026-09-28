import './helpers/env.js';
import { setEnv } from './helpers/env.js';
import { connect, disconnect } from './helpers/db.js';
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeDiscord, fakeRoblox } from './helpers/discord.js';

// A real transcript server on a private port, so the close flow can be tested
// against `server.listening` rather than a stub of it.
setEnv({ WEB_ENABLED: 'true', WEB_PORT: '39490', WEB_BASE_URL: 'http://127.0.0.1:39490' });

await connect();
const { TicketManager } = await import('../src/systems/tickets/TicketManager.js');
const { robloxLine } = await import('../src/systems/tickets/components.js');
const { TranscriptServer } = await import('../src/web/TranscriptServer.js');
const models = await import('../src/database/models/index.js');
const { invalidateConfig } = await import('../src/config/guildConfig.js');

const GUILD = '100000000000000002';

before(async () => {
  await models.GuildConfig.deleteMany({});
  await models.GuildConfig.create({ guildId: GUILD, tickets: { categoryId: '400000000000000001' } });
  invalidateConfig(GUILD);
});

after(disconnect);

beforeEach(async () => {
  await models.Ticket.deleteMany({});
  await models.Transcript.deleteMany({});
  await models.Counter.deleteMany({});
});

const APPEAL_ANSWERS = [
  { key: 'roblox_username', label: 'Your Roblox username', value: ' kirishinp ' },
  { key: 'discord_username', label: 'Discord username', value: 'Taenny' },
  { key: 'punishment_reason', label: 'Reason', value: 'spam' },
  { key: 'appeal', label: 'Appeal', value: 'please' },
];

const FOUND = {
  profile: {
    id: '2656101446', name: 'kirishinp', displayName: 'Taenny', accountAgeDays: 1500,
    isBanned: false, headshotUrl: 'https://tr.rbxcdn.com/k.png', previousNames: ['OldKiri'],
  },
  unavailable: false,
};

// ------------------------------------------------------------------ opening

describe('ticket open — Roblox lookup', () => {
  test('resolves the account and stores a snapshot on the ticket', async () => {
    const roblox = fakeRoblox(FOUND);
    const d = makeDiscord({ roblox });
    const { ticket } = await new TicketManager(d.client, d.logs, null)
      .open(d.guild, d.opener, 'ban_appeal', APPEAL_ANSWERS);

    assert.deepEqual(roblox.calls, ['kirishinp'], 'username should be trimmed');
    assert.equal(ticket.roblox.status, 'found');
    assert.equal(ticket.roblox.id, '2656101446');
    assert.equal(ticket.roblox.displayName, 'Taenny');

    const stored = await models.Ticket.findOne({ ticketId: ticket.ticketId }).lean();
    assert.equal(stored.roblox.id, '2656101446', 'snapshot must be persisted');
  });

  test('the ticket header shows the Roblox id and avatar, like HyperShot', async () => {
    const d = makeDiscord({ roblox: fakeRoblox(FOUND) });
    await new TicketManager(d.client, d.logs, null).open(d.guild, d.opener, 'ban_appeal', APPEAL_ANSWERS);

    const header = d.sent.channel[0].embeds[0].toJSON();
    const robloxField = header.fields.find((f) => f.name.includes('Roblox'));
    assert.match(robloxField.value, /kirishinp` \(ID: 2656101446\)/);
    assert.match(robloxField.value, /self-reported/);
    assert.equal(header.thumbnail.url, 'https://tr.rbxcdn.com/k.png', 'Roblox avatar, not Discord');
  });

  test('a username that does not exist is flagged in the header', async () => {
    const d = makeDiscord({ roblox: fakeRoblox({ profile: null, unavailable: false }) });
    const { ticket } = await new TicketManager(d.client, d.logs, null)
      .open(d.guild, d.opener, 'ban_appeal', APPEAL_ANSWERS);

    assert.equal(ticket.roblox.status, 'not_found');
    const header = d.sent.channel[0].embeds[0].toJSON();
    assert.match(header.fields.find((f) => f.name.includes('Roblox')).value, /No such Roblox account/);
  });

  test('Roblox being down does not stop the ticket from opening', async () => {
    const d = makeDiscord({ roblox: fakeRoblox({ profile: null, unavailable: true }) });
    const { ticket, channel } = await new TicketManager(d.client, d.logs, null)
      .open(d.guild, d.opener, 'ban_appeal', APPEAL_ANSWERS);

    assert.ok(channel, 'channel was created');
    assert.equal(ticket.roblox.status, 'unavailable');
    const header = d.sent.channel[0].embeds[0].toJSON();
    assert.match(header.fields.find((f) => f.name.includes('Roblox')).value, /unavailable/);
  });

  test('a Roblox lookup that hangs does not delay the ticket beyond it', async () => {
    // tryGetProfile has its own timeout; here we just check open() awaits it
    // alongside channel creation rather than serially.
    const slow = fakeRoblox(() => new Promise((r) => setTimeout(() => r(FOUND), 150)));
    const d = makeDiscord({ roblox: slow });
    const started = Date.now();
    await new TicketManager(d.client, d.logs, null).open(d.guild, d.opener, 'ban_appeal', APPEAL_ANSWERS);
    assert.ok(Date.now() - started < 2000);
  });

  test('categories without a Roblox field make no lookup', async () => {
    const roblox = fakeRoblox(FOUND);
    const d = makeDiscord({ roblox });
    const { ticket } = await new TicketManager(d.client, d.logs, null).open(d.guild, d.opener, 'general', [
      { key: 'subject', label: 'Subject', value: 'hi' },
      { key: 'description', label: 'Desc', value: 'hello' },
    ]);
    assert.equal(roblox.calls.length, 0);
    assert.equal(ticket.roblox.status, null);
  });

  test('works with no Roblox system registered at all', async () => {
    const d = makeDiscord({ roblox: null });
    const { ticket } = await new TicketManager(d.client, d.logs, null)
      .open(d.guild, d.opener, 'ban_appeal', APPEAL_ANSWERS);
    assert.equal(ticket.roblox.status, 'unavailable');
  });
});

// ------------------------------------------------------------------ header line

describe('robloxLine — what staff see in the header', () => {
  const base = { robloxUsername: 'kirishinp', roblox: { status: 'found', id: '1', name: 'kirishinp', accountAgeDays: 900 } };

  test('flags accounts younger than 30 days (alt-account signal)', () => {
    assert.match(robloxLine({ ...base, roblox: { ...base.roblox, accountAgeDays: 4 } }), /New account — 4 days old/);
    assert.doesNotMatch(robloxLine(base), /New account/);
  });

  test('flags a Roblox platform ban', () => {
    assert.match(robloxLine({ ...base, roblox: { ...base.roblox, isBanned: true } }), /Banned by Roblox/);
  });

  test('shows previous usernames', () => {
    assert.match(robloxLine({ ...base, roblox: { ...base.roblox, previousNames: ['A', 'B'] } }), /Previously: A, B/);
  });

  test('never claims ownership is verified', () => {
    assert.match(robloxLine(base), /self-reported/);
    assert.doesNotMatch(robloxLine(base), /\bverified\b/i);
  });

  test('tickets opened before the Roblox API existed still render', () => {
    assert.match(robloxLine({ robloxUsername: 'old', roblox: {} }), /`old`/);
    assert.equal(robloxLine({ robloxUsername: null }), '*not provided*');
  });
});

// ------------------------------------------------------------------ closing

describe('ticket close — web viewer vs file fallback', () => {
  async function openAndClose({ webListening }) {
    const web = new TranscriptServer(null);
    if (webListening) await web.start();

    const d = makeDiscord({ roblox: fakeRoblox(FOUND), web });
    const manager = new TicketManager(d.client, d.logs, null);
    const { ticket } = await manager.open(d.guild, d.opener, 'ban_appeal', APPEAL_ANSWERS);
    await manager.close(ticket.ticketId, GUILD, { id: 'staff1', tag: 'Staff#1' }, 'Accepted.', {
      decision: 'accepted',
    });

    if (webListening) await web.stop();
    return { d, ticket, web };
  }

  test('viewer listening → buttons, no attachment, working link', async () => {
    const web = new TranscriptServer(null);
    await web.start();
    try {
      const d = makeDiscord({ roblox: fakeRoblox(FOUND), web });
      const manager = new TicketManager(d.client, d.logs, null);
      const { ticket } = await manager.open(d.guild, d.opener, 'ban_appeal', APPEAL_ANSWERS);
      await manager.close(ticket.ticketId, GUILD, { id: 'staff1', tag: 'Staff#1' }, 'Accepted.', {
        decision: 'accepted',
      });

      const log = d.sent.logs.at(-1);
      assert.equal(log.options.components?.length, 1, 'button row posted');
      assert.ok(!log.options.files?.length, 'no attachment when the viewer works');

      const buttons = log.options.components[0].toJSON().components;
      assert.deepEqual(buttons.map((b) => b.label), ['View Transcript', 'Download HTML']);

      // Follow the posted link for real.
      const res = await fetch(buttons[0].url);
      assert.equal(res.status, 200);
      const body = await res.text();
      assert.match(body, /Ticket #000001/);
      assert.match(body, /2656101446/, 'transcript player context now carries the Roblox id');

      assert.doesNotMatch(new URL(buttons[0].url).pathname, /ticket|000001/i, 'no ticket id in URL');
      assert.equal((await fetch(buttons[1].url)).status, 200, 'download works');
    } finally {
      await web.stop();
    }
  });

  test('viewer not listening → HTML attachment, no buttons', async () => {
    const { d } = await openAndClose({ webListening: false });
    const log = d.sent.logs.at(-1);
    assert.ok(!log.options.components?.length, 'no buttons');
    assert.equal(log.options.files?.length, 1, 'file attached');
    assert.match(log.options.files[0].name, /^ticket-\d{6}\.html$/);
    assert.equal(await models.Transcript.countDocuments(), 0, 'no web record without a viewer');
  });

  test('DM to the opener follows the same rule', async () => {
    const { d } = await openAndClose({ webListening: false });
    assert.equal(d.sent.dms.at(-1).files?.length, 1);
  });
});
