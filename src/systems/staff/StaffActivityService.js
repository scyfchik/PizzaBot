import { StaffActivity } from '../../database/models/StaffActivity.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('staff-activity');

/**
 * Staff activity counters.
 *
 * One `$inc` per action, at the moment the action happens. Nothing here reads
 * the logs, and nothing else in the codebase should count actions by scanning
 * Punishment or Ticket — that is what made this collection necessary.
 *
 * Every method is fire-and-forget by design: a failed counter update must never
 * fail the ban, the claim or the close that triggered it. Failures are logged
 * and dropped, and the numbers are allowed to drift, because Punishment and
 * Ticket remain the source of truth for anything that matters.
 */
export class StaffActivityService {
  /**
   * Apply an increment.
   * @param {string} guildId
   * @param {object} member  the acting staff member (GuildMember or User)
   * @param {object} fields  dotted paths to increment, e.g. { 'tickets.claimed': 1 }
   * @param {string} label   short description for `lastAction`
   */
  async record(guildId, member, fields, label) {
    if (!guildId || !member?.id) return null;

    const userId = member.id;
    const username = member.user?.tag ?? member.tag ?? null;

    // Every recorded action also bumps the leaderboard total, so sorting never
    // needs to add the individual counters together at read time.
    const inc = { ...fields, 'totals.actions': 1 };

    try {
      return await StaffActivity.findOneAndUpdate(
        { guildId, userId },
        {
          $inc: inc,
          $set: { lastActivityAt: new Date(), lastAction: label, username },
        },
        { new: true, upsert: true, setDefaultsOnInsert: true },
      );
    } catch (err) {
      log.warn({ err, guildId, userId, label }, 'Failed to record staff activity');
      return null;
    }
  }

  // ------------------------------------------------------------- tickets

  ticketClaimed(guildId, member) {
    return this.record(guildId, member, { 'tickets.claimed': 1 }, 'Claimed a ticket');
  }

  ticketUnclaimed(guildId, member) {
    // Counted but not rewarded: releasing a ticket is a legitimate action, and
    // the number is there so a pattern of claim-then-drop is visible.
    return this.record(guildId, member, { 'tickets.unclaimed': 1 }, 'Released a ticket');
  }

  /**
   * @param {number|null} firstResponseMs how long the opener waited for a reply
   */
  ticketClosed(guildId, member, firstResponseMs = null) {
    const fields = { 'tickets.closed': 1 };

    // Only sampled when this staff member actually answered. Averaging in a
    // null would quietly pull everyone's response time toward zero.
    if (typeof firstResponseMs === 'number' && firstResponseMs >= 0) {
      fields['tickets.responseTimeTotalMs'] = firstResponseMs;
      fields['tickets.responseSamples'] = 1;
    }

    return this.record(guildId, member, fields, 'Closed a ticket');
  }

  // ------------------------------------------------------------- moderation

  /** Maps a PunishmentType to its counter. Unknown types count as an action only. */
  moderationAction(guildId, member, type) {
    const fieldByType = {
      warn: 'moderation.warns',
      timeout: 'moderation.timeouts',
      kick: 'moderation.kicks',
      ban: 'moderation.bans',
      unban: 'moderation.unbans',
    };

    const field = fieldByType[type];
    return this.record(guildId, member, field ? { [field]: 1 } : {}, `Issued a ${type}`);
  }

  messagesCleared(guildId, member, count) {
    return this.record(
      guildId,
      member,
      { 'moderation.clears': 1 },
      `Cleared ${count} message(s)`,
    );
  }

  // ------------------------------------------------------------- qa

  bugAssigned(guildId, member) {
    return this.record(guildId, member, { 'qa.reportsHandled': 1 }, 'Took a bug report');
  }

  bugResolved(guildId, member, status) {
    const fields = { 'qa.reportsClosed': 1 };
    if (status === 'FIXED') fields['qa.reportsFixed'] = 1;
    return this.record(guildId, member, fields, `Marked a bug ${status}`);
  }

  // ------------------------------------------------------------- reads

  get(guildId, userId) {
    return StaffActivity.findOne({ guildId, userId }).lean();
  }

  /**
   * Top staff by total actions.
   *
   * One indexed read against `(guildId, totals.actions: -1)` — already sorted,
   * so Mongo returns the first N without touching the rest.
   */
  leaderboard(guildId, limit = 10) {
    return StaffActivity.find({ guildId, 'totals.actions': { $gt: 0 } })
      .sort({ 'totals.actions': -1 })
      .limit(limit)
      .lean();
  }

  /** Rank of one member, for showing "you are #7" without loading the table. */
  async rankOf(guildId, userId) {
    const own = await StaffActivity.findOne({ guildId, userId }).lean();
    if (!own?.totals?.actions) return null;

    const ahead = await StaffActivity.countDocuments({
      guildId,
      'totals.actions': { $gt: own.totals.actions },
    });
    return ahead + 1;
  }
}
