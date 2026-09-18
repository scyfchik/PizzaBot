/**
 * Pre-flight check.
 *
 *   npm run doctor              full check, including a brief Discord login
 *   npm run doctor -- --offline skip Discord (no token needed beyond format)
 *
 * Verifies, in order: environment, code, database, configuration, Discord.
 * Each stage is useful on its own, so a failure in one still reports the rest
 * where possible. Exit code is 1 if anything FAILED; warnings do not fail.
 *
 * The operational logger is silenced before anything else is imported — this
 * command's output is a report for a human, not a log stream.
 */

process.env.LOG_LEVEL = 'silent';

const OFFLINE = process.argv.includes('--offline');

// Everything is imported dynamically so the LOG_LEVEL above is already set by
// the time utils/logger.js initialises pino.
const { join, dirname } = await import('node:path');
const { fileURLToPath } = await import('node:url');

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');

const OK = 'ok';
const WARN = 'warn';
const FAIL = 'fail';

const sections = [];
let current = null;

function section(title) {
  current = { title, checks: [] };
  sections.push(current);
}

function add(status, label, detail = '') {
  current.checks.push({ status, label, detail });
  return status;
}

const ok = (label, detail) => add(OK, label, detail);
const warn = (label, detail) => add(WARN, label, detail);
const fail = (label, detail) => add(FAIL, label, detail);

// --------------------------------------------------------------- 1. env

section('Environment');

let env;
try {
  const envModule = await import('../config/env.js');
  envModule.assertEnvValid();
  env = envModule.env;
  ok('Required variables', `all present · mode: ${env.nodeEnv}`);
} catch (err) {
  // Without env nothing else can run. Print and stop here.
  section('Result');
  fail('Environment', err.message.split('\n').slice(1, -2).join(' · ').trim());
  report();
  process.exit(1);
}

if (env.owners.length === 0) {
  fail('OWNER_IDS', 'empty — nobody can run /setup on a fresh server');
} else {
  ok('OWNER_IDS', `${env.owners.length} owner(s)`);
}

if (env.nodeEnv === 'production' && env.logLevel === 'debug') {
  warn('LOG_LEVEL', 'debug logging in production is noisy and leaks detail');
}

const nodeMajor = Number(process.versions.node.split('.')[0]);
if (nodeMajor < 20) {
  fail('Node version', `${process.versions.node} — this project needs 20.10 or newer`);
} else {
  ok('Node version', process.versions.node);
}

// --------------------------------------------------------------- 2. code

section('Code');

const { PizzaClient } = await import('../core/PizzaClient.js');
let client = null;

try {
  client = new PizzaClient();
  await client.loadAll();

  const commandCount = client.commands.commands.size;
  const handlerCount = client.interactions.handlers.size;
  // eventNames() includes discord.js internals; count only what we bound.
  const eventCount = client.eventNames().length;

  if (commandCount === 0) fail('Commands', 'none loaded');
  else ok('Commands', `${commandCount} loaded`);

  if (handlerCount === 0) fail('Interaction handlers', 'none loaded');
  else ok('Interaction handlers', `${handlerCount} loaded`);

  if (eventCount === 0) fail('Event handlers', 'none bound');
  else ok('Event handlers', `${eventCount} events bound`);

  // A command that cannot serialise will be silently dropped at deploy time.
  const broken = [];
  for (const [commandName, command] of client.commands.commands) {
    try {
      JSON.stringify(command.data.toJSON());
    } catch (err) {
      broken.push(`/${commandName}: ${err.message}`);
    }
  }
  if (broken.length) fail('Command definitions', broken.join(' · '));
  else ok('Command definitions', 'all serialise to valid Discord payloads');

  // Every command must *declare* its gate. An explicit `permission: null` is a
  // deliberate public command; a missing key is an oversight, and the two must
  // not look the same.
  const undeclared = [...client.commands.commands.entries()]
    .filter(([, command]) => command.meta?.permission === undefined)
    .map(([commandName]) => `/${commandName}`);
  const publicCommands = [...client.commands.commands.entries()]
    .filter(([, command]) => command.meta?.permission === null)
    .map(([commandName]) => `/${commandName}`);

  if (undeclared.length) warn('Permission gates', `no node declared: ${undeclared.join(', ')}`);
  else {
    ok(
      'Permission gates',
      publicCommands.length
        ? `all declared · public by design: ${publicCommands.join(', ')}`
        : 'every command declares a permission node',
    );
  }
} catch (err) {
  fail('Module loading', err.message);
}

// --------------------------------------------------------------- 3. database

section('Database');

let models = null;
let dbUp = false;

try {
  const { connectDatabase } = await import('../database/connection.js');
  models = await import('../database/models/index.js');
  await connectDatabase();
  dbUp = true;
  ok('MongoDB connection', 'connected');
} catch (err) {
  fail('MongoDB connection', shorten(err.message));
}

// --------------------------------------------------------------- 4. config

section('Guild configuration');

let config = null;

if (!dbUp) {
  warn('Configuration', 'skipped — no database connection');
} else {
  config = await models.GuildConfig.findOne({ guildId: env.discord.guildId }).lean();

  if (!config) {
    warn('Setup', 'not run yet — start the bot and use /setup in Discord');
  } else {
    const mappedRanks = (config.staffRanks ?? []).filter((r) => r.roleIds?.length);
    if (!mappedRanks.length) {
      fail('Staff ranks', 'no rank has a Discord role mapped — no one is staff');
    } else {
      ok(
        'Staff ranks',
        `${mappedRanks.length}/${config.staffRanks.length} mapped: ${mappedRanks
          .map((r) => r.name)
          .join(', ')}`,
      );
    }

    const feeds = Object.entries(config.logChannels ?? {});
    const unset = feeds.filter(([, id]) => !id).map(([key]) => key);
    if (unset.length === feeds.length) {
      fail('Log channels', 'none configured — nothing will be logged anywhere');
    } else if (unset.length) {
      warn('Log channels', `${feeds.length - unset.length}/${feeds.length} set · missing: ${unset.join(', ')}`);
    } else {
      ok('Log channels', 'all five configured');
    }

    if (!config.tickets?.categoryId) {
      fail('Ticket category', 'not set — tickets cannot be opened');
    } else {
      ok('Ticket category', 'set');
    }

    if (!config.tickets?.panelMessageId) {
      warn('Ticket panel', 'not posted yet — run /panel post');
    } else {
      ok('Ticket panel', 'posted');
    }

    if (!config.security?.quarantineRoleId) {
      warn('Quarantine role', 'not set — anti-raid cannot quarantine, only alert');
    } else {
      ok('Quarantine role', 'set');
    }

    if (!config.security?.alertChannelId) {
      warn('Security alerts', 'no dedicated channel — alerts fall back to the security log');
    } else {
      ok('Security alerts', 'channel set');
    }

    if (config.security?.lockdown?.active) {
      warn('Lockdown', 'A LOCKDOWN IS CURRENTLY ACTIVE');
    }
  }
}

// --------------------------------------------------------------- 5. discord

section('Discord');

if (OFFLINE) {
  warn('Discord checks', 'skipped (--offline)');
} else if (!client) {
  warn('Discord checks', 'skipped — code failed to load');
} else {
  await checkDiscord();
}

async function checkDiscord() {
  const { PermissionFlagsBits } = await import('discord.js');

  const REQUIRED = [
    ['View Channels', PermissionFlagsBits.ViewChannel],
    ['Send Messages', PermissionFlagsBits.SendMessages],
    ['Embed Links', PermissionFlagsBits.EmbedLinks],
    ['Attach Files', PermissionFlagsBits.AttachFiles],
    ['Read Message History', PermissionFlagsBits.ReadMessageHistory],
    ['Manage Roles', PermissionFlagsBits.ManageRoles],
    ['Manage Channels', PermissionFlagsBits.ManageChannels],
    ['Manage Messages', PermissionFlagsBits.ManageMessages],
    ['Kick Members', PermissionFlagsBits.KickMembers],
    ['Ban Members', PermissionFlagsBits.BanMembers],
    ['Moderate Members', PermissionFlagsBits.ModerateMembers],
    ['View Audit Log', PermissionFlagsBits.ViewAuditLog],
  ];

  try {
    await Promise.race([
      client.login(env.discord.token),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('login timed out after 20s')), 20_000).unref(),
      ),
    ]);
    ok('Login', `connected as ${client.user.tag}`);
  } catch (err) {
    fail('Login', shorten(err.message));
    return;
  }

  // Privileged intents must be enabled in the Developer Portal, or the bot
  // connects fine and then silently never sees members or message content.
  const guild = await client.guilds.fetch(env.discord.guildId).catch(() => null);
  if (!guild) {
    fail('Guild', `${env.discord.guildId} not found — is the bot invited to it?`);
    return;
  }
  ok('Guild', `${guild.name} · ${guild.memberCount} members`);

  const me = await guild.members.fetchMe();

  const missing = REQUIRED.filter(([, bit]) => !me.permissions.has(bit)).map(([label]) => label);
  if (missing.length) fail('Bot permissions', `missing: ${missing.join(', ')}`);
  else ok('Bot permissions', 'all required permissions granted');

  // The single most common cause of "moderation randomly fails".
  const highestOther = guild.roles.cache
    .filter((r) => r.id !== guild.id && !r.managed && r.id !== me.roles.highest.id)
    .sort((a, b) => b.position - a.position)
    .first();

  if (highestOther && me.roles.highest.position < highestOther.position) {
    fail(
      'Role position',
      `my role "${me.roles.highest.name}" is below "${highestOther.name}" — ` +
        'Discord will refuse actions against anyone holding it',
    );
  } else {
    ok('Role position', `"${me.roles.highest.name}" is above all other roles`);
  }

  if (!config) {
    warn('Configured channels', 'skipped — /setup has not been run');
    return;
  }

  // Verify every configured ID still points at something that exists.
  for (const [feed, channelId] of Object.entries(config.logChannels ?? {})) {
    if (!channelId) continue;
    const channel = guild.channels.cache.get(channelId) ?? null;
    if (!channel) {
      fail(`Log channel: ${feed}`, `${channelId} no longer exists`);
      continue;
    }
    const perms = channel.permissionsFor(me);
    const needed = ['ViewChannel', 'SendMessages', 'EmbedLinks'].filter((p) => !perms?.has(p));
    if (needed.length) fail(`Log channel: ${feed}`, `#${channel.name} — missing ${needed.join(', ')}`);
    else ok(`Log channel: ${feed}`, `#${channel.name}`);
  }

  if (config.tickets?.categoryId) {
    const category = guild.channels.cache.get(config.tickets.categoryId);
    if (!category) fail('Ticket category', 'configured ID no longer exists');
    else ok('Ticket category', category.name);
  }

  if (config.security?.quarantineRoleId) {
    const role = guild.roles.cache.get(config.security.quarantineRoleId);
    if (!role) {
      fail('Quarantine role', 'configured ID no longer exists');
    } else if (role.position >= me.roles.highest.position) {
      fail('Quarantine role', `"${role.name}" sits above my role — I cannot assign it`);
    } else {
      ok('Quarantine role', role.name);
    }
  }

  // Staff rank roles: a deleted role silently removes people's permissions.
  const danglingRanks = [];
  for (const rank of config.staffRanks ?? []) {
    for (const roleId of rank.roleIds ?? []) {
      if (!guild.roles.cache.has(roleId)) danglingRanks.push(`${rank.name} → ${roleId}`);
    }
  }
  if (danglingRanks.length) {
    fail('Staff rank roles', `deleted roles still mapped: ${danglingRanks.join(', ')}`);
  } else if ((config.staffRanks ?? []).some((r) => r.roleIds?.length)) {
    ok('Staff rank roles', 'all mapped roles exist');
  }

  // Registered commands should match what is on disk.
  const registered = await guild.commands.fetch().catch(() => null);
  if (!registered) {
    warn('Deployed commands', 'could not read — is the applications.commands scope granted?');
  } else {
    const onDisk = new Set(client.commands.commands.keys());
    const live = new Set(registered.map((c) => c.name));
    const notDeployed = [...onDisk].filter((n) => !live.has(n));
    const stale = [...live].filter((n) => !onDisk.has(n));

    if (notDeployed.length) warn('Deployed commands', `not deployed: ${notDeployed.map((n) => `/${n}`).join(', ')} — run npm run deploy`);
    else if (stale.length) warn('Deployed commands', `stale on Discord: ${stale.map((n) => `/${n}`).join(', ')} — run npm run deploy`);
    else ok('Deployed commands', `${live.size} in sync`);
  }
}

// --------------------------------------------------------------- report

report();

async function cleanup() {
  if (client) await client.destroy().catch(() => {});
  if (dbUp) {
    const { disconnectDatabase } = await import('../database/connection.js');
    await disconnectDatabase().catch(() => {});
  }
}

function shorten(message) {
  return String(message).split('\n')[0].slice(0, 160);
}

function report() {
  const ICON = { ok: '  OK  ', warn: ' WARN ', fail: ' FAIL ' };

  console.log("\n  Pizza Guy's Time — pre-flight check\n");

  for (const { title, checks } of sections) {
    if (!checks.length) continue;
    console.log(`  ${title}`);
    console.log(`  ${'-'.repeat(title.length)}`);
    const pad = Math.max(...checks.map((c) => c.label.length));
    for (const { status, label, detail } of checks) {
      console.log(`   [${ICON[status]}] ${label.padEnd(pad)}  ${detail}`);
    }
    console.log('');
  }

  const all = sections.flatMap((s) => s.checks);
  const failures = all.filter((c) => c.status === FAIL);
  const warnings = all.filter((c) => c.status === WARN);

  if (failures.length) {
    console.log(`  ${failures.length} failure(s), ${warnings.length} warning(s). Fix the failures before running the bot.\n`);
  } else if (warnings.length) {
    console.log(`  No failures, ${warnings.length} warning(s). The bot will run, but read the warnings.\n`);
  } else {
    console.log('  All checks passed.\n');
  }

  cleanup().finally(async () => {
    const { exitSoon } = await import('../utils/exit.js');
    exitSoon(failures.length ? 1 : 0);
  });
}
