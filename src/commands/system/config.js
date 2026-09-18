import {
  SlashCommandBuilder,
  PermissionFlagsBits,
  MessageFlags,
  ChannelType,
} from 'discord.js';
import { getConfig, saveConfig } from '../../config/guildConfig.js';
import { Permission, LogChannel, ALL_PERMISSIONS, Emojis } from '../../config/constants.js';
import { TICKET_CATEGORIES } from '../../systems/tickets/categories.js';
import { hasPermission } from '../../systems/staff/permissions.js';
import { embeds, field, truncate } from '../../utils/embeds.js';
import { UserError, PermissionError } from '../../core/errors.js';

/**
 * Runtime configuration.
 *
 * Everything the security and ticket systems read is editable here, live. That
 * is the whole point of keeping config in MongoDB: during an incident you can
 * raise an anti-spam threshold or disable a ticket category in ten seconds,
 * without a redeploy and without editing a file on a server you may not have
 * access to from your phone.
 */
export const data = new SlashCommandBuilder()
  .setName('config')
  .setDescription('View or change the bot configuration')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)

  .addSubcommand((sub) => sub.setName('view').setDescription('Show the current configuration'))

  .addSubcommandGroup((group) =>
    group
      .setName('rank')
      .setDescription('Map staff ranks to Discord roles')
      .addSubcommand((sub) =>
        sub
          .setName('set')
          .setDescription('Attach a Discord role to a staff rank')
          .addStringOption((o) =>
            o.setName('rank').setDescription('Which rank').setRequired(true).setAutocomplete(true),
          )
          .addRoleOption((o) => o.setName('role').setDescription('The role').setRequired(true)),
      )
      .addSubcommand((sub) =>
        sub
          .setName('unset')
          .setDescription('Detach a role from a rank')
          .addStringOption((o) =>
            o.setName('rank').setDescription('Which rank').setRequired(true).setAutocomplete(true),
          )
          .addRoleOption((o) => o.setName('role').setDescription('The role').setRequired(true)),
      )
      .addSubcommand((sub) =>
        sub
          .setName('permission')
          .setDescription('Grant or revoke a permission node for a rank')
          .addStringOption((o) =>
            o.setName('rank').setDescription('Which rank').setRequired(true).setAutocomplete(true),
          )
          .addStringOption((o) =>
            o
              .setName('node')
              .setDescription('Permission node')
              .setRequired(true)
              .setAutocomplete(true),
          )
          .addBooleanOption((o) =>
            o.setName('grant').setDescription('true to grant, false to revoke').setRequired(true),
          ),
      )
      .addSubcommand((sub) => sub.setName('list').setDescription('Show every rank and its roles')),
  )

  .addSubcommandGroup((group) =>
    group
      .setName('channel')
      .setDescription('Set the log channels')
      .addSubcommand((sub) =>
        sub
          .setName('set')
          .setDescription('Point a log feed at a channel')
          .addStringOption((o) =>
            o
              .setName('type')
              .setDescription('Which feed')
              .setRequired(true)
              .addChoices(
                { name: 'Security', value: LogChannel.SECURITY },
                { name: 'Moderation', value: LogChannel.MODERATION },
                { name: 'Tickets', value: LogChannel.TICKETS },
                { name: 'Staff', value: LogChannel.STAFF },
                { name: 'Server events', value: LogChannel.SERVER },
              ),
          )
          .addChannelOption((o) =>
            o
              .setName('channel')
              .setDescription('Target channel (omit to disable this feed)')
              .addChannelTypes(ChannelType.GuildText),
          ),
      ),
  )

  .addSubcommand((sub) =>
    sub
      .setName('tickets')
      .setDescription('Ticket system settings')
      .addChannelOption((o) =>
        o
          .setName('category')
          .setDescription('Category new tickets are created in')
          .addChannelTypes(ChannelType.GuildCategory),
      )
      .addRoleOption((o) =>
        o.setName('support-role').setDescription('Role pinged when a ticket opens'),
      )
      .addIntegerOption((o) =>
        o
          .setName('max-open')
          .setDescription('Max simultaneous tickets per user')
          .setMinValue(1)
          .setMaxValue(10),
      )
      .addBooleanOption((o) =>
        o.setName('transcripts').setDescription('Generate transcripts on close'),
      )
      .addBooleanOption((o) =>
        o
          .setName('web-transcripts')
          .setDescription('Store a web transcript and include its private link'),
      )
      .addIntegerOption((o) =>
        o
          .setName('transcript-expiry-days')
          .setDescription('Days a transcript link stays alive (0 = forever)')
          .setMinValue(0)
          .setMaxValue(3650),
      )
      .addStringOption((o) =>
        o
          .setName('toggle-category')
          .setDescription('Enable or disable one ticket category')
          .addChoices(
            ...TICKET_CATEGORIES.map((c) => ({ name: c.label, value: c.key })),
          ),
      ),
  )

  .addSubcommand((sub) =>
    sub
      .setName('security')
      .setDescription('Security system settings')
      .addRoleOption((o) =>
        o.setName('quarantine-role').setDescription('Role applied to quarantined accounts'),
      )
      .addChannelOption((o) =>
        o
          .setName('alert-channel')
          .setDescription('Where security alerts are posted')
          .addChannelTypes(ChannelType.GuildText),
      )
      .addRoleOption((o) =>
        o.setName('ping-role').setDescription('Role pinged for high-severity alerts'),
      )
      .addBooleanOption((o) => o.setName('anti-raid').setDescription('Enable anti-raid'))
      .addBooleanOption((o) => o.setName('anti-nuke').setDescription('Enable anti-nuke'))
      .addStringOption((o) =>
        o
          .setName('raid-action')
          .setDescription('What anti-raid does to a detected wave')
          .addChoices(
            { name: 'Quarantine (reversible, recommended)', value: 'quarantine' },
            { name: 'Kick', value: 'kick' },
            { name: 'Alert only', value: 'alert_only' },
          ),
      )
      .addStringOption((o) =>
        o
          .setName('nuke-response')
          .setDescription('What anti-nuke does to an ordinary member')
          .addChoices(
            { name: 'Remove dangerous permissions (recommended)', value: 'remove_permissions' },
            { name: 'Alert only — never act automatically', value: 'alert_only' },
          ),
      )
      .addIntegerOption((o) =>
        o
          .setName('raid-join-threshold')
          .setDescription('Joins within the window that trip anti-raid')
          .setMinValue(3)
          .setMaxValue(100),
      ),
  )

  .addSubcommand((sub) =>
    sub
      .setName('qa')
      .setDescription('Bug reporting and QA settings')
      .addBooleanOption((o) => o.setName('enabled').setDescription('Enable bug reporting'))
      .addChannelOption((o) =>
        o
          .setName('board-channel')
          .setDescription('Where bug reports are posted and kept in sync')
          .addChannelTypes(ChannelType.GuildText),
      )
      .addRoleOption((o) => o.setName('tester-role').setDescription('QA tester role'))
      .addStringOption((o) =>
        o.setName('current-version').setDescription('Current game version, e.g. 0.5.0').setMaxLength(32),
      )
      .addBooleanOption((o) =>
        o.setName('ping-critical-only').setDescription('Only ping testers for critical bugs'),
      ),
  )

  .addSubcommand((sub) =>
    sub
      .setName('game')
      .setDescription('Live game data settings')
      .addChannelOption((o) =>
        o
          .setName('event-channel')
          .setDescription('Where notable in-game events are mirrored')
          .addChannelTypes(ChannelType.GuildText),
      )
      .addRoleOption((o) =>
        o.setName('alert-role').setDescription('Pinged on reported errors and failed purchases'),
      )
      .addStringOption((o) =>
        o.setName('current-version').setDescription('Current game version').setMaxLength(32),
      ),
  )

  .addSubcommand((sub) =>
    sub
      .setName('roblox')
      .setDescription('Roblox verification settings')
      .addRoleOption((o) => o.setName('verified-role').setDescription('Role granted on verification'))
      .addRoleOption((o) => o.setName('tester-role').setDescription('Roblox in-game tester role')),
  )

  .addSubcommand((sub) =>
    sub
      .setName('moderation')
      .setDescription('Moderation history settings')
      .addBooleanOption((o) =>
        o
          .setName('record-external')
          .setDescription('Record punishments issued by other bots or moderators'),
      ),
  );

export const meta = { permission: Permission.CONFIG_VIEW, cooldown: 3 };

export async function execute(interaction, { staff }) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const group = interaction.options.getSubcommandGroup(false);
  const sub = interaction.options.getSubcommand();
  const config = await getConfig(interaction.guildId);

  // Viewing is separate from editing: a Developer can see how things are set
  // up without being able to change security thresholds.
  const isRead = sub === 'view' || sub === 'list';
  if (!isRead && !hasPermission(staff, Permission.CONFIG_EDIT)) {
    throw new PermissionError('You can view the configuration, but not change it.');
  }

  if (group === 'rank') return rankGroup(interaction, config, sub);
  if (group === 'channel') return setChannel(interaction, config);

  switch (sub) {
    case 'view':
      return view(interaction, config);
    case 'tickets':
      return ticketSettings(interaction, config);
    case 'security':
      return securitySettings(interaction, config);
    case 'qa':
      return qaSettings(interaction, config);
    case 'game':
      return gameSettings(interaction, config);
    case 'roblox':
      return robloxSettings(interaction, config);
    case 'moderation':
      return moderationSettings(interaction, config);
  }
}

// ------------------------------------------------------------------ ranks

async function rankGroup(interaction, config, sub) {
  if (sub === 'list') {
    return interaction.editReply({
      embeds: [
        embeds.brand('Staff ranks').addFields(
          config.staffRanks
            .sort((a, b) => b.position - a.position)
            .map((rank) =>
              field(
                `${rank.protected ? '🔒 ' : ''}${rank.name} · position ${rank.position}`,
                `${rank.roleIds?.length ? rank.roleIds.map((id) => `<@&${id}>`).join(', ') : '*no role mapped*'}\n` +
                  `${rank.permissions?.includes('*') ? '**All permissions**' : `${rank.permissions?.length ?? 0} permission node(s)`}`,
              ),
            ),
        ),
      ],
    });
  }

  const rankKey = interaction.options.getString('rank');
  const rank = config.staffRanks.find((r) => r.key === rankKey);
  if (!rank) throw new UserError(`No rank \`${rankKey}\`. Pick one from the suggestions.`);

  if (sub === 'permission') {
    const node = interaction.options.getString('node');
    const grant = interaction.options.getBoolean('grant');

    if (node !== '*' && !ALL_PERMISSIONS.includes(node)) {
      throw new UserError(`\`${node}\` is not a known permission node.`);
    }

    if (grant) {
      if (!rank.permissions.includes(node)) rank.permissions.push(node);
    } else {
      rank.permissions = rank.permissions.filter((p) => p !== node);
    }
    await saveConfig(config);

    return interaction.editReply({
      embeds: [
        embeds.success(
          `${grant ? 'Granted' : 'Revoked'} \`${node}\` ${grant ? 'to' : 'from'} **${rank.name}**.`,
        ),
      ],
    });
  }

  const role = interaction.options.getRole('role');

  if (sub === 'set') {
    if (role.managed) {
      throw new UserError('That is a bot-managed role — pick a normal role instead.');
    }
    if (!rank.roleIds.includes(role.id)) rank.roleIds.push(role.id);
    await saveConfig(config);

    return interaction.editReply({
      embeds: [
        embeds
          .success(`${role} now grants the **${rank.name}** rank.`)
          .addFields(
            field(
              'Permissions granted',
              rank.permissions.includes('*')
                ? '**Everything** — this rank holds the wildcard.'
                : truncate(rank.permissions.map((p) => `\`${p}\``).join(' ')),
            ),
          ),
      ],
    });
  }

  rank.roleIds = rank.roleIds.filter((id) => id !== role.id);
  await saveConfig(config);
  return interaction.editReply({
    embeds: [embeds.success(`${role} no longer grants **${rank.name}**.`)],
  });
}

// ------------------------------------------------------------------ channels

async function setChannel(interaction, config) {
  const type = interaction.options.getString('type');
  const channel = interaction.options.getChannel('channel');

  config.logChannels[type] = channel?.id ?? null;
  await saveConfig(config);

  return interaction.editReply({
    embeds: [
      embeds.success(
        channel
          ? `**${type}** logs will go to ${channel}.`
          : `**${type}** logging disabled.`,
      ),
    ],
  });
}

// ------------------------------------------------------------------ sections

async function ticketSettings(interaction, config) {
  const changes = [];
  const opt = (name) => interaction.options.get(name)?.value ?? null;

  const category = interaction.options.getChannel('category');
  if (category) {
    config.tickets.categoryId = category.id;
    changes.push(`Ticket category → ${category}`);
  }

  const supportRole = interaction.options.getRole('support-role');
  if (supportRole) {
    config.tickets.supportRoleId = supportRole.id;
    changes.push(`Support role → ${supportRole}`);
  }

  if (opt('max-open') !== null) {
    config.tickets.maxOpenPerUser = interaction.options.getInteger('max-open');
    changes.push(`Max open per user → **${config.tickets.maxOpenPerUser}**`);
  }

  if (opt('transcripts') !== null) {
    config.tickets.transcriptsEnabled = interaction.options.getBoolean('transcripts');
    changes.push(`Transcripts → **${config.tickets.transcriptsEnabled ? 'on' : 'off'}**`);
  }

  if (opt('web-transcripts') !== null) {
    config.tickets.webTranscriptsEnabled = interaction.options.getBoolean('web-transcripts');
    changes.push(`Web transcripts → **${config.tickets.webTranscriptsEnabled ? 'on' : 'off'}**`);
  }

  if (opt('transcript-expiry-days') !== null) {
    config.tickets.transcriptExpiryDays = interaction.options.getInteger('transcript-expiry-days');
    changes.push(
      `Transcript links expire → **${
        config.tickets.transcriptExpiryDays === 0
          ? 'never'
          : `after ${config.tickets.transcriptExpiryDays} days`
      }**` +
        (config.tickets.transcriptExpiryDays === 0
          ? '\n_Links that never expire accumulate personal data indefinitely._'
          : ''),
    );
  }

  const toggle = interaction.options.getString('toggle-category');
  if (toggle) {
    const disabled = config.tickets.disabledCategories ?? [];
    if (disabled.includes(toggle)) {
      config.tickets.disabledCategories = disabled.filter((c) => c !== toggle);
      changes.push(`Category \`${toggle}\` → **enabled**`);
    } else {
      config.tickets.disabledCategories = [...disabled, toggle];
      changes.push(`Category \`${toggle}\` → **disabled**`);
    }
    changes.push('_Run `/panel refresh` to update the panel._');
  }

  return applyChanges(interaction, config, changes);
}

async function securitySettings(interaction, config) {
  const changes = [];
  const sec = config.security;
  const opt = (name) => interaction.options.get(name)?.value ?? null;

  const quarantine = interaction.options.getRole('quarantine-role');
  if (quarantine) {
    sec.quarantineRoleId = quarantine.id;
    changes.push(`Quarantine role → ${quarantine}`);
  }

  const alertChannel = interaction.options.getChannel('alert-channel');
  if (alertChannel) {
    sec.alertChannelId = alertChannel.id;
    changes.push(`Alert channel → ${alertChannel}`);
  }

  const pingRole = interaction.options.getRole('ping-role');
  if (pingRole) {
    sec.pingRoleId = pingRole.id;
    changes.push(`Alert ping role → ${pingRole}`);
  }

  for (const [option, path, label] of [
    ['anti-raid', 'antiRaid', 'Anti-raid'],
    ['anti-nuke', 'antiNuke', 'Anti-nuke'],
  ]) {
    if (opt(option) !== null) {
      sec[path].enabled = interaction.options.getBoolean(option);
      changes.push(`${label} → **${sec[path].enabled ? 'enabled' : 'disabled'}**`);
    }
  }

  const raidAction = interaction.options.getString('raid-action');
  if (raidAction) {
    sec.antiRaid.action = raidAction;
    changes.push(`Anti-raid response → \`${raidAction}\``);
  }

  const nukeResponse = interaction.options.getString('nuke-response');
  if (nukeResponse) {
    sec.antiNuke.response = nukeResponse;
    changes.push(
      `Anti-nuke response → \`${nukeResponse}\`` +
        '\n_Protected ranks are never actioned automatically regardless of this setting._',
    );
  }

  if (opt('raid-join-threshold') !== null) {
    sec.antiRaid.joinThreshold = interaction.options.getInteger('raid-join-threshold');
    changes.push(`Raid join threshold → **${sec.antiRaid.joinThreshold}**`);
  }

  return applyChanges(interaction, config, changes);
}

async function qaSettings(interaction, config) {
  const changes = [];
  const opt = (name) => interaction.options.get(name)?.value ?? null;

  if (opt('enabled') !== null) {
    config.qa.enabled = interaction.options.getBoolean('enabled');
    changes.push(`Bug reporting → **${config.qa.enabled ? 'enabled' : 'disabled'}**`);
  }

  const board = interaction.options.getChannel('board-channel');
  if (board) {
    config.qa.boardChannelId = board.id;
    changes.push(`Bug board → ${board}`);
  }

  const testerRole = interaction.options.getRole('tester-role');
  if (testerRole) {
    config.qa.testerRoleId = testerRole.id;
    changes.push(`Tester role → ${testerRole}`);
  }

  const version = interaction.options.getString('current-version');
  if (version) {
    config.qa.currentVersion = version.trim();
    changes.push(`Current version → **${config.qa.currentVersion}**`);
  }

  if (opt('ping-critical-only') !== null) {
    config.qa.pingOnCriticalOnly = interaction.options.getBoolean('ping-critical-only');
    changes.push(
      `Tester pings → **${config.qa.pingOnCriticalOnly ? 'critical bugs only' : 'every bug'}**`,
    );
  }

  return applyChanges(interaction, config, changes);
}

async function gameSettings(interaction, config) {
  const changes = [];

  const channel = interaction.options.getChannel('event-channel');
  if (channel) {
    config.game.eventChannelId = channel.id;
    changes.push(`Game event channel → ${channel}`);
  }

  const alertRole = interaction.options.getRole('alert-role');
  if (alertRole) {
    config.game.alertRoleId = alertRole.id;
    changes.push(`Game alert role → ${alertRole}`);
  }

  const version = interaction.options.getString('current-version');
  if (version) {
    config.game.currentVersion = version.trim();
    changes.push(`Current game version → **${config.game.currentVersion}**`);
  }

  if (changes.length) {
    changes.push(
      '_Game data only arrives if your experience POSTs to the ingest endpoint — `/game connection`._',
    );
  }

  return applyChanges(interaction, config, changes);
}

async function robloxSettings(interaction, config) {
  const changes = [];

  const verifiedRole = interaction.options.getRole('verified-role');
  if (verifiedRole) {
    config.roblox.verifiedRoleId = verifiedRole.id;
    changes.push(`Verified role → ${verifiedRole}`);
  }

  const testerRole = interaction.options.getRole('tester-role');
  if (testerRole) {
    config.roblox.testerRoleId = testerRole.id;
    changes.push(`Roblox tester role → ${testerRole}`);
  }

  if (changes.length) {
    changes.push(
      '_The Roblox API is not implemented — `/verify approve` is a manual staff vouch._',
    );
  }

  return applyChanges(interaction, config, changes);
}

async function moderationSettings(interaction, config) {
  const changes = [];
  const mod = config.moderation;
  const opt = (name) => interaction.options.get(name)?.value ?? null;

  if (opt('record-external') !== null) {
    mod.recordExternalActions = interaction.options.getBoolean('record-external');
    changes.push(
      `Record external actions → **${mod.recordExternalActions ? 'on' : 'off'}**` +
        (mod.recordExternalActions
          ? ''
          : '\n_With this off, punishments issued by other bots leave no history — ban appeals become unanswerable._'),
    );
  }

  return applyChanges(interaction, config, changes);
}

async function applyChanges(interaction, config, changes) {
  if (!changes.length) {
    throw new UserError('Nothing to change — provide at least one option.');
  }
  await saveConfig(config);
  return interaction.editReply({
    embeds: [embeds.success('Configuration updated.').addFields(field('Changes', changes.join('\n')))],
  });
}

// ------------------------------------------------------------------ view

async function view(interaction, config) {
  const channel = (id) => (id ? `<#${id}>` : '*not set*');
  const role = (id) => (id ? `<@&${id}>` : '*not set*');
  const flag = (on) => (on ? Emojis.CHECK : Emojis.CROSS);

  const embed = embeds
    .brand('Configuration')
    .addFields(
      field(
        'Log channels',
        `Security ${channel(config.logChannels.security)}\n` +
          `Moderation ${channel(config.logChannels.moderation)}\n` +
          `Tickets ${channel(config.logChannels.tickets)}\n` +
          `Staff ${channel(config.logChannels.staff)}\n` +
          `Server ${channel(config.logChannels.server)}`,
      ),
      field(
        'Tickets',
        `${flag(config.tickets.enabled)} enabled · category ${channel(config.tickets.categoryId)}\n` +
          `Support role ${role(config.tickets.supportRoleId)}\n` +
          `Max open **${config.tickets.maxOpenPerUser}** · transcripts ${flag(config.tickets.transcriptsEnabled)}\n` +
          `Web transcripts ${flag(config.tickets.webTranscriptsEnabled)} · links expire ${
            config.tickets.transcriptExpiryDays === 0
              ? '**never**'
              : `after **${config.tickets.transcriptExpiryDays}d**`
          }\n` +
          'On close: channel deleted after 5s\n' +
          `Disabled categories: ${
            config.tickets.disabledCategories?.length
              ? config.tickets.disabledCategories.join(', ')
              : 'none'
          }`,
      ),
      field(
        'Security',
        `Anti-raid ${flag(config.security.antiRaid.enabled)} (${config.security.antiRaid.joinThreshold} joins / ${config.security.antiRaid.windowSeconds}s → \`${config.security.antiRaid.action}\`)\n` +
          `Anti-nuke ${flag(config.security.antiNuke.enabled)} (→ \`${config.security.antiNuke.response}\`)\n` +
          `Quarantine ${role(config.security.quarantineRoleId)} · alerts ${channel(config.security.alertChannelId)}\n` +
          `Lockdown: ${config.security.lockdown.active ? '🔒 **ACTIVE**' : 'inactive'}`,
      ),
      field(
        'Moderation history',
        `Record external actions ${flag(config.moderation.recordExternalActions)}\n` +
          '_Pizza Bot records punishments from the audit log; it does not issue them._',
      ),
      field(
        'QA',
        `${flag(config.qa.enabled)} enabled · board ${channel(config.qa.boardChannelId)}\n` +
          `Tester role ${role(config.qa.testerRoleId)} · version **${config.qa.currentVersion ?? 'unset'}**`,
      ),
      field(
        'Game data',
        `Events → ${channel(config.game.eventChannelId)} · alerts ${role(config.game.alertRoleId)}\n` +
          `Version **${config.game.currentVersion ?? 'unset'}** · ` +
          `Verified role ${role(config.roblox.verifiedRoleId)}`,
      ),
      field(
        'Staff ranks',
        config.staffRanks
          .sort((a, b) => b.position - a.position)
          .map((r) => `${r.roleIds?.length ? Emojis.CHECK : '▫️'} ${r.name}`)
          .join(' · '),
      ),
    )
    .setFooter({ text: 'Use /config rank list for the full rank breakdown' });

  await interaction.editReply({ embeds: [embed] });
}

// ------------------------------------------------------------------ autocomplete

export async function autocomplete(interaction) {
  const focused = interaction.options.getFocused(true);
  const query = focused.value.toLowerCase();

  if (focused.name === 'rank') {
    const config = await getConfig(interaction.guildId);
    const matches = config.staffRanks
      .filter((r) => r.name.toLowerCase().includes(query) || r.key.includes(query))
      .sort((a, b) => b.position - a.position)
      .slice(0, 25)
      .map((r) => ({ name: `${r.name} (position ${r.position})`, value: r.key }));
    return interaction.respond(matches);
  }

  if (focused.name === 'node') {
    const matches = ['*', ...ALL_PERMISSIONS]
      .filter((node) => node.includes(query))
      .slice(0, 25)
      .map((node) => ({ name: node === '*' ? '* (all permissions)' : node, value: node }));
    return interaction.respond(matches);
  }

  return interaction.respond([]);
}
