import { AuditLogEvent } from 'discord.js';
import { PunishmentType } from '../../config/constants.js';
import { safeAction } from '../../utils/safeAction.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('audit-recorder');

/**
 * Turn Discord audit-log entries into Pizza Bot cases.
 *
 * This is how the moderation history stays complete without Pizza Bot ever
 * issuing a punishment: Dyno bans someone, Discord writes an audit entry, we
 * notice and record it.
 *
 * ## Why this is fiddly
 *
 * Discord's gateway does not tell you *who* banned someone — only that a ban
 * happened. The executor has to be read back from the audit log, which is:
 *
 *   - **eventually consistent.** The entry frequently is not there yet when
 *     the gateway event fires, hence the short retry.
 *   - **ambiguous.** `guildMemberRemove` fires identically for a kick and for
 *     someone leaving on their own. Only a matching audit entry within a few
 *     seconds distinguishes them, and a member who leaves moments after an
 *     unrelated kick can still be misattributed. We keep the window tight and
 *     accept that this is a best-effort record, not a ledger.
 *
 * Nothing here punishes anyone. It only writes history.
 */

/** How long an audit entry may lag the gateway event and still be considered a match. */
const MATCH_WINDOW_MS = 10_000;

/** Audit entries usually appear within a second; retry briefly before giving up. */
const RETRIES = [400, 1200, 2500];

/**
 * Find the audit entry that explains a gateway event.
 * @returns {Promise<import('discord.js').GuildAuditLogsEntry|null>}
 */
async function findEntry(guild, type, targetId) {
  for (const delay of RETRIES) {
    const result = await safeAction('fetch-audit-log', () =>
      guild.fetchAuditLogs({ type, limit: 8 }),
    );

    if (result.ok) {
      const match = result.value.entries.find(
        (entry) =>
          entry.target?.id === targetId && Date.now() - entry.createdTimestamp < MATCH_WINDOW_MS,
      );
      if (match) return match;
    }

    await new Promise((resolve) => setTimeout(resolve, delay));
  }
  return null;
}

/** True when this action was performed by Pizza Bot itself. */
function isSelf(entry, client) {
  return entry?.executor?.id === client.user.id;
}

export class AuditRecorder {
  constructor(client, moderation) {
    this.client = client;
    this.moderation = moderation;
  }

  async onBanAdd(ban) {
    const entry = await findEntry(ban.guild, AuditLogEvent.MemberBanAdd, ban.user.id);
    if (isSelf(entry, this.client)) return null;

    return this.moderation.recordExternal({
      guild: ban.guild,
      type: PunishmentType.BAN,
      target: ban.user,
      moderator: entry?.executor ?? null,
      reason: entry?.reason ?? ban.reason,
    });
  }

  async onBanRemove(ban) {
    const entry = await findEntry(ban.guild, AuditLogEvent.MemberBanRemove, ban.user.id);
    if (isSelf(entry, this.client)) return null;

    // The ban is no longer in force, so the original case stops counting.
    await this.moderation.deactivate(ban.guild.id, ban.user.id, PunishmentType.BAN);

    return this.moderation.recordExternal({
      guild: ban.guild,
      type: PunishmentType.UNBAN,
      target: ban.user,
      moderator: entry?.executor ?? null,
      reason: entry?.reason,
    });
  }

  /**
   * A member left. Only record it when the audit log proves it was a kick —
   * most departures are voluntary and recording those as punishments would
   * make every player profile look terrible.
   */
  async onMemberRemove(member) {
    const entry = await findEntry(member.guild, AuditLogEvent.MemberKick, member.id);
    if (!entry || isSelf(entry, this.client)) return null;

    return this.moderation.recordExternal({
      guild: member.guild,
      type: PunishmentType.KICK,
      target: member.user,
      moderator: entry.executor ?? null,
      reason: entry.reason,
    });
  }

  /**
   * Timeouts arrive as a `guildMemberUpdate` with a changed
   * `communicationDisabledUntil`. Both applying and clearing one show up here.
   */
  async onTimeoutChange(before, after) {
    const had = before.communicationDisabledUntilTimestamp;
    const has = after.communicationDisabledUntilTimestamp;
    if (had === has) return null;

    const entry = await findEntry(after.guild, AuditLogEvent.MemberUpdate, after.id);
    if (isSelf(entry, this.client)) return null;

    // Discord expires timeouts by itself, and that is not a moderator action —
    // only record a removal that someone actually performed.
    if (had && !has) {
      const expiredNaturally = had <= Date.now() + 2000;
      if (expiredNaturally) {
        await this.moderation.deactivate(after.guild.id, after.id, PunishmentType.TIMEOUT);
        return null;
      }

      await this.moderation.deactivate(after.guild.id, after.id, PunishmentType.TIMEOUT);
      return this.moderation.recordExternal({
        guild: after.guild,
        type: PunishmentType.UNTIMEOUT,
        target: after.user,
        moderator: entry?.executor ?? null,
        reason: entry?.reason,
      });
    }

    if (has) {
      return this.moderation.recordExternal({
        guild: after.guild,
        type: PunishmentType.TIMEOUT,
        target: after.user,
        moderator: entry?.executor ?? null,
        reason: entry?.reason,
        duration: has - Date.now(),
      });
    }

    return null;
  }
}
