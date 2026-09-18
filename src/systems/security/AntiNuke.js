import {
  AuditLogEvent,
  PermissionFlagsBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from 'discord.js';
import { getConfig } from '../../config/guildConfig.js';
import { SlidingWindow } from './SlidingWindow.js';
import { SecurityEvent, Severity } from '../../config/constants.js';
import { SecurityService } from './SecurityService.js';
import { isProtectedMember, resolveStaff } from '../staff/permissions.js';
import { buildId } from '../../utils/ids.js';
import { safeAction } from '../../utils/safeAction.js';
import { field, userLabel } from '../../utils/embeds.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('anti-nuke');

/**
 * Anti-nuke — defensive by design.
 *
 * Threat model: an administrator account, trusted by the normal permission
 * system, deleting channels or mass-banning. The response is deliberately
 * conservative, in this order:
 *
 *   1. log the event
 *   2. alert the security team
 *   3. remove *dangerous permissions* from the offender — never a ban
 *   4. for protected ranks, do nothing automatically: hold the action and ask
 *
 * The reasoning is simple. A false positive that strips a role is an
 * inconvenience; a false positive that bans the Game Director during a launch
 * is a catastrophe, and a buggy detector with ban rights is itself the nuke.
 * Anything that would remove power from senior staff waits for a human.
 *
 * Two limits we do not paper over:
 *   - the guild owner cannot be stopped by any bot; we alert instead.
 *   - deleted messages are gone. Channels can be recreated, history cannot.
 */
export class AntiNuke {
  constructor(client, security) {
    this.client = client;
    this.security = security;
    /** executor actions per guild, keyed `${guildId}:${userId}:${kind}`. */
    this.actions = new SlidingWindow(120_000);
  }

  prune() {
    this.actions.prune();
  }

  // ------------------------------------------------------------- entry points

  async onChannelDelete(channel) {
    return this.#track(channel.guild, {
      kind: 'channelDelete',
      auditType: AuditLogEvent.ChannelDelete,
      targetId: channel.id,
      event: SecurityEvent.NUKE_CHANNEL_DELETE,
      limitKey: 'channelDeleteLimit',
      label: 'channel deletions',
      details: { name: channel.name, type: channel.type, parentId: channel.parentId },
    });
  }

  async onRoleDelete(role) {
    return this.#track(role.guild, {
      kind: 'roleDelete',
      auditType: AuditLogEvent.RoleDelete,
      targetId: role.id,
      event: SecurityEvent.NUKE_ROLE_DELETE,
      limitKey: 'roleDeleteLimit',
      label: 'role deletions',
      details: { name: role.name, color: role.color, permissions: role.permissions.bitfield.toString() },
    });
  }

  async onBanAdd(ban) {
    return this.#track(ban.guild, {
      kind: 'ban',
      auditType: AuditLogEvent.MemberBanAdd,
      targetId: ban.user.id,
      event: SecurityEvent.NUKE_MASS_BAN,
      limitKey: 'banLimit',
      label: 'bans',
      details: { target: ban.user.tag },
    });
  }

  async onKick(member) {
    return this.#track(member.guild, {
      kind: 'kick',
      auditType: AuditLogEvent.MemberKick,
      targetId: member.id,
      event: SecurityEvent.NUKE_MASS_KICK,
      limitKey: 'kickLimit',
      label: 'kicks',
      details: { target: member.user.tag },
      /** Members leave voluntarily all the time — only count real kicks. */
      requireAuditMatch: true,
    });
  }

  async onWebhookCreate(channel) {
    return this.#track(channel.guild, {
      kind: 'webhook',
      auditType: AuditLogEvent.WebhookCreate,
      targetId: null,
      event: SecurityEvent.NUKE_WEBHOOK_CREATE,
      limitKey: 'webhookCreateLimit',
      label: 'webhook creations',
      details: { channel: channel.name },
    });
  }

  /**
   * Permission escalation: a role gaining Administrator, Manage Guild, Manage
   * Roles or Ban Members. Alert only — this is legitimate often enough that
   * automatic reversal would break normal server administration.
   */
  async onRoleUpdate(before, after) {
    const config = await getConfig(after.guild.id);
    if (!config.security?.antiNuke?.enabled) return;
    if (!config.security.antiNuke.watchPermissionEscalation) return;

    const DANGEROUS = [
      ['Administrator', PermissionFlagsBits.Administrator],
      ['Manage Server', PermissionFlagsBits.ManageGuild],
      ['Manage Roles', PermissionFlagsBits.ManageRoles],
      ['Manage Channels', PermissionFlagsBits.ManageChannels],
      ['Ban Members', PermissionFlagsBits.BanMembers],
      ['Manage Webhooks', PermissionFlagsBits.ManageWebhooks],
    ];

    const gained = DANGEROUS.filter(
      ([, bit]) => !before.permissions.has(bit) && after.permissions.has(bit),
    ).map(([name]) => name);

    if (!gained.length) return;

    const executor = await this.#findExecutor(after.guild, AuditLogEvent.RoleUpdate, after.id);
    if (executor && (await this.#isWhitelisted(after.guild, executor.id, config))) return;

    await this.security.report({
      guild: after.guild,
      event: SecurityEvent.NUKE_PERMISSION_CHANGE,
      severity: gained.includes('Administrator') ? Severity.CRITICAL : Severity.HIGH,
      user: executor,
      action: 'alert_only',
      details: { role: after.name, gained },
      title: 'Dangerous permissions granted',
      description:
        `The role **${after.name}** just gained: ${gained.map((g) => `\`${g}\``).join(', ')}.\n` +
        'No automatic action was taken — verify this was intentional.',
      fields: [
        field('Role', `${after} (\`${after.id}\`)`, true),
        field('Members with it', String(after.members.size), true),
      ],
    });
  }

  // ------------------------------------------------------------- core

  async #track(guild, spec) {
    const config = await getConfig(guild.id);
    const rules = config.security?.antiNuke;
    if (!rules?.enabled) return;

    const executor = await this.#findExecutor(guild, spec.auditType, spec.targetId);
    if (!executor) {
      if (spec.requireAuditMatch) return; // member left on their own
      return;
    }
    if (executor.id === this.client.user.id) return; // our own moderation actions
    if (await this.#isWhitelisted(guild, executor.id, config)) return;

    const key = `${guild.id}:${executor.id}:${spec.kind}`;
    const hits = this.actions.hit(key, spec.details);
    const windowMs = (rules.windowSeconds ?? 30) * 1000;
    const inWindow = hits.filter((h) => h.at > Date.now() - windowMs);

    const limit = rules[spec.limitKey] ?? 3;
    if (inWindow.length < limit) return;

    this.actions.reset(key);
    await this.#respond(guild, executor, spec, inWindow, rules, config);
  }

  async #respond(guild, executor, spec, hits, rules, config) {
    const incidentId = SecurityService.newIncidentId();
    const member = await guild.members.fetch(executor.id).catch(() => null);
    const isOwner = executor.id === guild.ownerId;
    const isProtected = member ? await isProtectedMember(member) : false;

    const entry = await this.security.record({
      guildId: guild.id,
      event: spec.event,
      severity: Severity.CRITICAL,
      user: executor,
      incidentId,
      details: {
        count: hits.length,
        limit: rules[spec.limitKey],
        windowSeconds: rules.windowSeconds,
        targets: hits.map((h) => h.data).slice(0, 10),
      },
    });

    const staff = member ? await resolveStaff(member) : null;
    const summary =
      `**${hits.length}** ${spec.label} by ${executor.tag} in ` +
      `${rules.windowSeconds} seconds (limit: ${rules[spec.limitKey]}).`;

    // --- Case 1: the guild owner. Nothing can stop them; say so plainly.
    if (isOwner) {
      await this.security.markAction(entry, { action: 'alert_only:owner' });
      await this.security.alert(guild.id, {
        title: 'Mass destructive action by the server owner',
        description:
          `${summary}\n\n**No bot can restrict the server owner.** ` +
          'If this account is compromised, the owner must secure it themselves — ' +
          'change the password, reset 2FA, and revoke authorised apps.',
        severity: Severity.CRITICAL,
        fields: [field('Incident', `\`${incidentId}\``, true), field('User', userLabel(executor), true)],
      });
      return;
    }

    // --- Case 2: protected rank. Hold the action and ask a human.
    if (isProtected || rules.response === 'alert_only') {
      await this.security.markAction(entry, { action: 'held_for_confirmation' });
      await this.security.alert(guild.id, {
        title: 'Mass destructive action — confirmation required',
        description:
          `${summary}\n\n` +
          (isProtected
            ? `${executor} holds a **protected rank** (${staff?.rankNames.join(', ')}), so no ` +
              'automatic action was taken. A human decides this one.'
            : 'Anti-nuke is set to alert-only, so no automatic action was taken.'),
        severity: Severity.CRITICAL,
        fields: [
          field('User', userLabel(executor), true),
          field('Incident', `\`${incidentId}\``, true),
          field(
            'Affected',
            hits
              .map((h) => `• ${h.data?.name ?? h.data?.target ?? 'unknown'}`)
              .slice(0, 8)
              .join('\n'),
          ),
          field(
            'Options',
            '**Remove permissions** strips every role granting dangerous permissions. ' +
              'It is reversible — the removed roles are listed in this alert.',
          ),
        ],
        components: confirmationButtons(executor.id, incidentId),
      });
      return;
    }

    // --- Case 3: ordinary member with dangerous power. Act, then report.
    if (!member) {
      await this.security.markAction(entry, { action: 'alert_only:left_guild' });
      return;
    }

    const removed = await this.#stripDangerousRoles(member, `Anti-nuke: ${spec.label} (${incidentId})`);

    await this.security.markAction(entry, {
      action: removed.length ? `removed_roles:${removed.length}` : 'no_roles_to_remove',
    });

    await this.security.alert(guild.id, {
      title: 'Mass destructive action blocked',
      description: `${summary}\n\nDangerous permissions were removed from ${executor}.`,
      severity: Severity.CRITICAL,
      fields: [
        field('User', userLabel(executor), true),
        field('Incident', `\`${incidentId}\``, true),
        field(
          'Roles removed',
          removed.length ? removed.map((r) => `<@&${r.id}>`).join(', ') : 'None (no dangerous roles)',
        ),
        field(
          'Restore',
          removed.length
            ? `If this was a false positive: \`/security restore user:${executor.id}\``
            : '—',
        ),
      ],
      components: restoreButton(executor.id, removed.map((r) => r.id)),
    });

    log.error(
      { guild: guild.id, executor: executor.id, kind: spec.kind, incidentId, removed: removed.length },
      'Anti-nuke response executed',
    );
  }

  /**
   * Remove every role that grants a dangerous permission.
   *
   * Roles, not a ban: this revokes the ability to do more damage while leaving
   * the person in the server to explain themselves, and it is trivially undone
   * if we were wrong. Roles the bot cannot reach are skipped and reported.
   */
  async #stripDangerousRoles(member, reason) {
    const DANGEROUS =
      PermissionFlagsBits.Administrator |
      PermissionFlagsBits.ManageGuild |
      PermissionFlagsBits.ManageRoles |
      PermissionFlagsBits.ManageChannels |
      PermissionFlagsBits.BanMembers |
      PermissionFlagsBits.KickMembers |
      PermissionFlagsBits.ManageWebhooks;

    const botMember = await member.guild.members.fetchMe();

    const targets = member.roles.cache.filter(
      (role) =>
        role.id !== member.guild.id &&
        (role.permissions.bitfield & DANGEROUS) !== 0n &&
        role.position < botMember.roles.highest.position &&
        !role.managed,
    );

    if (!targets.size) return [];

    const result = await safeAction('strip-roles', () =>
      member.roles.remove([...targets.keys()], reason),
    );

    return result.ok ? [...targets.values()] : [];
  }

  /** Resolve who performed an action from the audit log. */
  async #findExecutor(guild, auditType, targetId) {
    const result = await safeAction('fetch-audit-log', () =>
      guild.fetchAuditLogs({ type: auditType, limit: 5 }),
    );
    if (!result.ok) return null;

    const now = Date.now();
    const match = result.value.entries.find((entry) => {
      if (now - entry.createdTimestamp > 10_000) return false; // stale entry
      if (targetId && entry.target?.id && entry.target.id !== targetId) return false;
      return true;
    });

    return match?.executor ?? null;
  }

  async #isWhitelisted(guild, userId, config) {
    if (config.security.antiNuke.whitelist?.includes(userId)) return true;
    if (userId === this.client.user.id) return true;
    return false;
  }
}

function confirmationButtons(userId, incidentId) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(buildId('sec', 'strip', userId, incidentId))
        .setLabel('Remove permissions')
        .setEmoji('🛑')
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId(buildId('sec', 'dismiss', userId, incidentId))
        .setLabel('This was authorised')
        .setEmoji('✅')
        .setStyle(ButtonStyle.Secondary),
    ),
  ];
}

function restoreButton(userId, roleIds) {
  if (!roleIds.length) return undefined;
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(buildId('sec', 'restore', userId, roleIds.slice(0, 4).join('.')))
        .setLabel('Restore roles (false positive)')
        .setEmoji('↩️')
        .setStyle(ButtonStyle.Secondary),
    ),
  ];
}
