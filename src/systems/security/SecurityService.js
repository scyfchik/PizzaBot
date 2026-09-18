import { randomUUID } from 'node:crypto';
import { EmbedBuilder } from 'discord.js';
import { SecurityLog } from '../../database/models/SecurityLog.js';
import { Severity, SeverityColor } from '../../config/constants.js';
import { field, userLabel, truncate } from '../../utils/embeds.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('security');

/** Low-severity noise is not worth keeping forever. */
const RETENTION_DAYS = { low: 14, medium: 60, high: null, critical: null };

/**
 * Shared plumbing for the three detectors.
 *
 * Every detection follows the same path: write the forensic record *first*,
 * then respond, then alert. Recording before responding means an incident is
 * still reconstructable when the response itself fails — which is exactly the
 * situation you most want a record of.
 */
export class SecurityService {
  constructor(client, logService) {
    this.client = client;
    this.logs = logService;
  }

  /** Write a SecurityLog row. Returns the document. */
  async record({
    guildId,
    event,
    severity = Severity.LOW,
    user = null,
    channelId = null,
    action = 'none',
    details = {},
    incidentId = null,
  }) {
    const retention = RETENTION_DAYS[severity];

    return SecurityLog.create({
      guildId,
      event,
      severity,
      userId: user?.id ?? null,
      userTag: user?.tag ?? user?.user?.tag ?? null,
      channelId,
      action,
      details,
      incidentId,
      expiresAt: retention ? new Date(Date.now() + retention * 86_400_000) : null,
    });
  }

  /** Update a record once the response has actually run. */
  async markAction(entry, { action, succeeded = true, error = null, caseId = null }) {
    entry.action = action;
    entry.actionSucceeded = succeeded;
    entry.actionError = error ? truncate(String(error.message ?? error), 300) : null;
    if (caseId) entry.caseId = caseId;
    await entry.save();
    return entry;
  }

  /** Post a security alert embed. High and critical ping the security role. */
  async alert(guildId, { title, description, severity = Severity.HIGH, fields = [], components }) {
    const embed = new EmbedBuilder()
      .setColor(SeverityColor[severity])
      .setAuthor({ name: `🛡️ ${title}` })
      .setDescription(description)
      .setFooter({ text: `Severity: ${severity.toUpperCase()}` })
      .setTimestamp();

    if (fields.length) embed.addFields(fields);

    return this.logs.alert(guildId, embed, { severity, components });
  }

  /** Detection + alert in one call, for the common case. */
  async report({
    guild,
    event,
    severity,
    user,
    channelId = null,
    action = 'none',
    details = {},
    title,
    description,
    fields = [],
    components,
    incidentId = null,
  }) {
    const entry = await this.record({
      guildId: guild.id,
      event,
      severity,
      user,
      channelId,
      action,
      details,
      incidentId,
    });

    await this.alert(guild.id, {
      title,
      description,
      severity,
      components,
      fields: [
        ...(user ? [field('User', userLabel(user.user ?? user), true)] : []),
        ...(channelId ? [field('Channel', `<#${channelId}>`, true)] : []),
        ...fields,
      ],
    });

    log.warn({ guild: guild.id, event, severity, user: user?.id }, 'Security event');
    return entry;
  }

  /** Group every log line produced by one raid or nuke attempt. */
  static newIncidentId() {
    return randomUUID().slice(0, 8);
  }
}
