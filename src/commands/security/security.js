import { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } from 'discord.js';
import { SecurityLog } from '../../database/models/SecurityLog.js';
import { getConfig } from '../../config/guildConfig.js';
import { Permission, SecurityEvent, Severity, Emojis } from '../../config/constants.js';
import { hasPermission } from '../../systems/staff/permissions.js';
import { embeds, field, truncate } from '../../utils/embeds.js';
import { fullTimestamp, timestamp } from '../../utils/time.js';
import { UserError, PermissionError } from '../../core/errors.js';

/**
 * Security audit and lockdown.
 *
 * Replaces the standalone `/lockdown`: locking the server down is a security
 * action, and keeping it in the same namespace as the audit log means the
 * person reacting to an alert does not have to remember two command names.
 */
export const data = new SlashCommandBuilder()
  .setName('security')
  .setDescription('Security audit and server lockdown')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addSubcommand((sub) =>
    sub
      .setName('logs')
      .setDescription('Recent security events')
      .addStringOption((o) =>
        o
          .setName('severity')
          .setDescription('Minimum severity')
          .addChoices(
            { name: 'All', value: 'all' },
            { name: 'Medium and above', value: Severity.MEDIUM },
            { name: 'High and above', value: Severity.HIGH },
            { name: 'Critical only', value: Severity.CRITICAL },
          ),
      )
      .addStringOption((o) =>
        o
          .setName('event')
          .setDescription('Filter by event type')
          .addChoices(
            ...Object.values(SecurityEvent)
              .filter((v) => v.startsWith('nuke') || v.startsWith('raid') || v.includes('lockdown'))
              .slice(0, 25)
              .map((v) => ({ name: v, value: v })),
          ),
      )
      .addUserOption((o) => o.setName('user').setDescription('Filter by user'))
      .addIntegerOption((o) =>
        o.setName('limit').setDescription('How many (default 15)').setMinValue(1).setMaxValue(25),
      ),
  )
  .addSubcommand((sub) => sub.setName('summary').setDescription('Security activity at a glance'))
  .addSubcommand((sub) =>
    sub
      .setName('lockdown')
      .setDescription('Stop @everyone sending messages server-wide')
      .addStringOption((o) =>
        o.setName('reason').setDescription('Why').setRequired(true).setMaxLength(300),
      )
      .addIntegerOption((o) =>
        o
          .setName('minutes')
          .setDescription('Auto-lift after this many minutes (default 15, 0 = manual)')
          .setMinValue(0)
          .setMaxValue(1440),
      ),
  )
  .addSubcommand((sub) => sub.setName('unlock').setDescription('Lift the lockdown'))
  .addSubcommand((sub) => sub.setName('status').setDescription('Is a lockdown active?'));

export const meta = {
  permission: Permission.SECURITY_ALERTS,
  cooldown: 4,
};

export async function execute(interaction, { client, staff }) {
  const sub = interaction.options.getSubcommand();
  const lockdown = client.getSystem('lockdown');

  if (sub === 'lockdown' || sub === 'unlock') {
    if (!hasPermission(staff, Permission.SECURITY_LOCKDOWN)) {
      throw new PermissionError('Lockdown is restricted to staff leads.');
    }
    await interaction.deferReply();
    return sub === 'lockdown' ? enable(interaction, lockdown) : disable(interaction, lockdown);
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  if (sub === 'status') return status(interaction);
  if (sub === 'summary') return summary(interaction);
  return logs(interaction);
}

// ------------------------------------------------------------------ audit

const SEVERITY_RANK = { low: 0, medium: 1, high: 2, critical: 3 };

async function logs(interaction) {
  const minimum = interaction.options.getString('severity') ?? 'all';
  const query = { guildId: interaction.guildId };

  if (minimum !== 'all') {
    query.severity = {
      $in: Object.keys(SEVERITY_RANK).filter((s) => SEVERITY_RANK[s] >= SEVERITY_RANK[minimum]),
    };
  }

  const eventType = interaction.options.getString('event');
  if (eventType) query.event = eventType;

  const user = interaction.options.getUser('user');
  if (user) query.userId = user.id;

  const rows = await SecurityLog.find(query)
    .sort({ createdAt: -1 })
    .limit(interaction.options.getInteger('limit') ?? 15)
    .lean();

  if (!rows.length) throw new UserError('No security events match that filter.');

  const icon = { low: '🔵', medium: '🟡', high: '🔴', critical: '🚨' };

  await interaction.editReply({
    embeds: [
      embeds
        .brand(`${Emojis.SHIELD} Security log`)
        .setDescription(
          rows
            .map(
              (r) =>
                `${icon[r.severity] ?? '•'} \`${r.event}\` ${r.userTag ? `· ${r.userTag}` : ''} · ${timestamp(r.createdAt, 'R')}\n` +
                `└ action: \`${r.action}\`${r.actionSucceeded === false ? ' **(failed)**' : ''}` +
                (r.acknowledgedBy ? ` · ack by <@${r.acknowledgedBy}>` : '') +
                (r.incidentId ? ` · incident \`${r.incidentId}\`` : ''),
            )
            .join('\n'),
        )
        .setFooter({
          text: 'Low-severity events expire after 14 days; high and critical are kept.',
        }),
    ],
  });
}

async function summary(interaction) {
  const guildId = interaction.guildId;
  const dayAgo = new Date(Date.now() - 86_400_000);
  const weekAgo = new Date(Date.now() - 7 * 86_400_000);

  const [bySeverity, last24h, lastWeek, unacknowledged] = await Promise.all([
    SecurityLog.aggregate([
      { $match: { guildId, createdAt: { $gte: weekAgo } } },
      { $group: { _id: '$severity', count: { $sum: 1 } } },
    ]),
    SecurityLog.countDocuments({ guildId, createdAt: { $gte: dayAgo } }),
    SecurityLog.countDocuments({ guildId, createdAt: { $gte: weekAgo } }),
    SecurityLog.countDocuments({
      guildId,
      severity: { $in: [Severity.HIGH, Severity.CRITICAL] },
      acknowledgedBy: null,
      createdAt: { $gte: weekAgo },
    }),
  ]);

  const counts = Object.fromEntries(bySeverity.map((r) => [r._id, r.count]));
  const config = await getConfig(guildId);

  await interaction.editReply({
    embeds: [
      embeds
        .brand(`${Emojis.SHIELD} Security summary`)
        .addFields(
          field('Last 24 hours', String(last24h), true),
          field('Last 7 days', String(lastWeek), true),
          field(
            '⚠️ Unacknowledged',
            unacknowledged ? `**${unacknowledged}** high/critical` : 'none',
            true,
          ),
          field(
            'By severity (7d)',
            `🚨 Critical **${counts.critical ?? 0}**\n🔴 High **${counts.high ?? 0}**\n` +
              `🟡 Medium **${counts.medium ?? 0}**\n🔵 Low **${counts.low ?? 0}**`,
            true,
          ),
          field(
            'Protections',
            `Anti-nuke ${config.security.antiNuke.enabled ? '🟢' : '⚪'} ` +
              `(→ \`${config.security.antiNuke.response}\`)\n` +
              `Anti-raid ${config.security.antiRaid.enabled ? '🟢' : '⚪'}\n` +
              '_Chat moderation is handled by your automod bot, not this one._',
            true,
          ),
          field(
            'Lockdown',
            config.security.lockdown.active ? '🔒 **ACTIVE**' : 'inactive',
            true,
          ),
        ),
    ],
  });
}

// ------------------------------------------------------------------ lockdown

async function status(interaction) {
  const config = await getConfig(interaction.guildId);
  const state = config.security.lockdown;

  if (!state.active) {
    return interaction.editReply({ embeds: [embeds.success('No lockdown is active.')] });
  }

  await interaction.editReply({
    embeds: [
      embeds
        .warning('**Lockdown is active.**')
        .addFields(
          field('Reason', truncate(state.reason ?? '—', 500)),
          field('Started', fullTimestamp(state.startedAt), true),
          field('By', state.startedBy ? `<@${state.startedBy}>` : 'Automatic', true),
          field(
            'Auto-lifts',
            state.expiresAt ? fullTimestamp(state.expiresAt) : 'Never — lift manually',
            true,
          ),
          field('Channels locked', String(state.snapshot?.length ?? 0), true),
        ),
    ],
  });
}

async function enable(interaction, lockdown) {
  const reason = interaction.options.getString('reason');
  const minutes = interaction.options.getInteger('minutes') ?? 15;

  const count = await lockdown.enable(interaction.guild, {
    reason,
    minutes,
    by: interaction.user,
  });

  await interaction.editReply({
    embeds: [
      embeds
        .warning(`${Emojis.LOCK} Lockdown enabled — **${count}** channels locked.`)
        .addFields(
          field('Reason', reason),
          field(
            'Auto-lift',
            minutes ? `in ${minutes} minutes` : 'never — remember `/security unlock`',
            true,
          ),
        ),
    ],
  });
}

async function disable(interaction, lockdown) {
  const restored = await lockdown.disable(interaction.guild, interaction.user);
  await interaction.editReply({
    embeds: [
      embeds.success(
        `${Emojis.UNLOCK} Lockdown lifted — **${restored}** channels restored to their previous permissions.`,
      ),
    ],
  });
}
