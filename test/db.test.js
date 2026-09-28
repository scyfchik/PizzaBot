import './helpers/env.js';
import { connect, disconnect } from './helpers/db.js';
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

await connect();
const models = await import('../src/database/models/index.js');
const { getConfig, saveConfig, invalidateConfig } = await import('../src/config/guildConfig.js');
const { StaffActivityService } = await import('../src/systems/staff/StaffActivityService.js');
const { BugReportService } = await import('../src/systems/qa/BugReportService.js');

const G = 'guild-db-test';

before(async () => {
  // Build every index up front so uniqueness assertions are meaningful.
  await Promise.all(Object.values(models).filter((m) => m?.syncIndexes).map((m) => m.syncIndexes()));
});
after(disconnect);

describe('Counter', () => {
  test('20 concurrent calls produce 20 unique, gapless numbers', async () => {
    const { Counter, CounterScope } = models;
    const nums = await Promise.all(Array.from({ length: 20 }, () => Counter.next(CounterScope.ticket(G))));
    assert.equal(new Set(nums).size, 20);
    assert.equal(Math.max(...nums), 20);
  });
});

describe('GuildConfig', () => {
  test('defaults include all ten ranks and no removed sections', async () => {
    const cfg = await getConfig(G);
    assert.equal(cfg.staffRanks.length, 10);
    assert.equal(cfg.security.antiNuke.response, 'remove_permissions');
    const plain = cfg.toObject();
    assert.equal(plain.roblox, undefined, 'roblox/verification config removed');
    assert.equal(plain.security.antiSpam, undefined, 'anti-spam removed');
    assert.equal(plain.security.autoMod, undefined, 'automod removed');
  });

  test('cache stays coherent across save', async () => {
    const cfg = await getConfig(G);
    cfg.staffRanks.find((r) => r.key === 'moderator').roleIds.push('999');
    await saveConfig(cfg);
    invalidateConfig(G);
    const again = await getConfig(G);
    assert.ok(again.staffRanks.find((r) => r.key === 'moderator').roleIds.includes('999'));
  });
});

describe('Punishment', () => {
  test('case ids are unique per guild; invalid types rejected; default origin is audit_log', async () => {
    const { Punishment } = models;
    const c = await Punishment.create({ caseId: 1, guildId: G, type: 'ban', userId: 'u1' });
    assert.equal(c.origin, 'audit_log');
    assert.equal(c.appeal.status, 'active');
    await assert.rejects(Punishment.create({ caseId: 1, guildId: G, type: 'warn', userId: 'u2' }));
    await assert.rejects(Punishment.create({ caseId: 2, guildId: G, type: 'nonsense', userId: 'u2' }));
  });
});

describe('Ticket', () => {
  test('stores the Roblox snapshot and accepts CLOSING', async () => {
    const t = await models.Ticket.create({
      ticketId: 1, guildId: G, openerId: 'u1', category: 'ban_appeal',
      robloxUsername: 'kirishinp',
      roblox: { status: 'found', id: '2656101446', name: 'kirishinp', accountAgeDays: 900 },
    });
    t.status = 'closing';
    await t.save();
    const back = await models.Ticket.findOne({ ticketId: 1, guildId: G }).lean();
    assert.equal(back.status, 'closing');
    assert.equal(back.roblox.id, '2656101446');
  });

  test('rejects an invalid Roblox status', async () => {
    await assert.rejects(models.Ticket.create({
      ticketId: 2, guildId: G, openerId: 'u1', category: 'general', roblox: { status: 'verified' },
    }));
  });
});

describe('SecurityLog', () => {
  test('removed spam events are rejected by the enum', async () => {
    await assert.rejects(models.SecurityLog.create({ guildId: G, event: 'spam_rate' }));
    await models.SecurityLog.create({ guildId: G, event: 'join_wave' });
  });
});

describe('StaffActivity', () => {
  const s = new StaffActivityService();
  const m = (id) => ({ id, user: { tag: `${id}#0001` } });

  test('counters, response-time average and leaderboard', async () => {
    await s.ticketClaimed(G, m('a'));
    await s.ticketClosed(G, m('a'), 120_000);
    await s.ticketClosed(G, m('a'), 240_000);
    await s.ticketClosed(G, m('a'), null); // null must not drag the average down
    await s.moderationAction(G, m('a'), 'ban');
    await s.ticketClaimed(G, m('b'));

    const a = await s.get(G, 'a');
    assert.equal(a.tickets.closed, 3);
    assert.equal(a.tickets.responseSamples, 2);
    assert.equal(a.tickets.responseTimeTotalMs / a.tickets.responseSamples, 180_000);
    assert.equal(a.moderation.bans, 1);

    const board = await s.leaderboard(G, 10);
    assert.equal(board[0].userId, 'a');
    assert.equal(await s.rankOf(G, 'b'), 2);
  });
});

describe('BugReport lifecycle', () => {
  const qa = new BugReportService({ channels: { cache: new Map() } }, { tickets: async () => null }, null);
  const guild = { id: G, channels: { cache: new Map() } };

  test('OPEN -> TESTING -> FIXED -> reopened keeps a full history', async () => {
    const bug = await qa.create(guild, { id: 'p1', tag: 'P#1' }, {
      description: 'Oven broken', platform: 'iPhone 13', gameVersion: '0.5.0',
    });
    assert.equal(bug.platform, 'Mobile');
    await qa.assign(G, bug.bugId, { id: 't1', user: { tag: 'T#1' } });
    await qa.setStatus(G, bug.bugId, 'FIXED', { id: 't1', tag: 'T#1' }, 'patched');
    await qa.setStatus(G, bug.bugId, 'OPEN', { id: 't1', tag: 'T#1' }, 'regressed');

    const back = await qa.get(G, bug.bugId);
    assert.equal(back.status, 'OPEN');
    assert.equal(back.resolvedAt, null, 'reopening clears the resolution');
    assert.equal(back.history.length, 3);
    await assert.rejects(qa.setStatus(G, bug.bugId, 'OPEN', { id: 't1' }), /already OPEN/);
  });

  test('pagination never overlaps', async () => {
    for (let i = 0; i < 14; i++) await qa.create(guild, { id: 'p1', tag: 'P#1' }, { description: `b${i}` });
    const p1 = await qa.list(G, { page: 1, perPage: 10 });
    const p2 = await qa.list(G, { page: 2, perPage: 10 });
    assert.equal(p1.items.length, 10);
    assert.equal(p2.items.length, 5);
    assert.ok(!p1.items.some((a) => p2.items.some((b) => b.bugId === a.bugId)));
  });
});
