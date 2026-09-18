import { Punishment } from '../../database/models/Punishment.js';
import { User } from '../../database/models/User.js';
import { Counter, CounterScope } from '../../database/models/Counter.js';
import { PunishmentType, CaseOrigin, Limits } from '../../config/constants.js';
import { caseLogEmbed } from './caseEmbeds.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('moderation');

/**
 * The case log — a **recorder**, not an executor.
 *
 * Pizza Bot deliberately does not ban, kick, warn or mute. Dyno/Carl-bot do
 * that, and two bots issuing punishments over the same rules produces double
 * penalties and arguments about which one acted. What Pizza Bot needs is the
 * *history*: ban appeals are unanswerable without it, and a player profile
 * showing "0 warnings" because another bot issued them is worse than useless.
 *
 * So cases arrive two ways:
 *
 *   1. **From Discord's audit log**, when any moderator or bot acts. This is
 *      the normal path — see `events/guild/*` and `systems/moderation/auditRecorder`.
 *   2. **From the bot's own security systems**, when anti-raid quarantines a
 *      wave. Those are security responses, not general moderation.
 *
 * The one thing this class will never grow is a method that punishes someone
 * because a human ran a slash command. That is another bot's job.
 */
export class ModerationService {
  constructor(client, logService, staffActivity) {
    this.client = client;
    this.logs = logService;
    this.activity = staffActivity;
  }

  /**
   * Write a case.
   *
   * Everything that ends up in `/player history` and `/case` goes through here,
   * whatever produced it.
   */
  async createCase({
    guild,
    type,
    target,
    moderator = null,
    reason = 'No reason provided',
    evidence = [],
    duration = null,
    origin = CaseOrigin.AUDIT_LOG,
    context = {},
  }) {
    const caseId = await Counter.next(CounterScope.case(guild.id));

    const punishment = await Punishment.create({
      caseId,
      guildId: guild.id,
      type,
      origin,
      userId: target.id,
      userTag: target.tag ?? target.user?.tag ?? null,
      moderatorId: moderator?.id ?? null,
      moderatorTag: moderator?.tag ?? moderator?.user?.tag ?? null,
      reason: String(reason).slice(0, Limits.REASON_MAX),
      evidence,
      duration,
      expiresAt: duration ? new Date(Date.now() + duration) : null,
      context,
    });

    await this.#bumpCounters(guild.id, type, target.id, moderator);
    return punishment;
  }

  /**
   * Record an action someone else performed, then post it to the moderation
   * feed. The bot did not do this — it noticed it.
   */
  async recordExternal({ guild, type, target, moderator, reason, duration = null, context = {} }) {
    const punishment = await this.createCase({
      guild,
      type,
      target,
      moderator,
      reason: reason || 'No reason recorded',
      duration,
      origin: CaseOrigin.AUDIT_LOG,
      context,
    });

    const embed = caseLogEmbed(punishment).setFooter({
      text: 'Recorded from the Discord audit log — action taken outside Pizza Bot',
    });

    const message = await this.logs.moderation(guild.id, embed);
    if (message) {
      punishment.logMessageId = message.id;
      await punishment.save();
    }

    log.info(
      { caseId: punishment.caseId, type, user: target.id, by: moderator?.id },
      'Recorded external moderation action',
    );
    return punishment;
  }

  /**
   * Mark the active case of a given type as no longer in force.
   * Used when a ban is lifted or a timeout is removed elsewhere.
   */
  async deactivate(guildId, userId, type) {
    const result = await Punishment.updateMany(
      { guildId, userId, type, active: true },
      { $set: { active: false } },
    );
    return result.modifiedCount;
  }

  async #bumpCounters(guildId, type, targetId, moderator) {
    const statField = {
      [PunishmentType.WARN]: 'stats.warns',
      [PunishmentType.TIMEOUT]: 'stats.timeouts',
      [PunishmentType.KICK]: 'stats.kicks',
      [PunishmentType.BAN]: 'stats.bans',
    }[type];

    if (statField) {
      await User.ensure(guildId, targetId);
      await User.updateOne({ guildId, discordId: targetId }, { $inc: { [statField]: 1 } });
    }

    // Credit the human who acted, even though they acted through another bot —
    // staff activity should reflect the work, not which tool did it. Actions by
    // bots and by the system credit nobody.
    if (moderator?.id && !(moderator.bot ?? moderator.user?.bot)) {
      await this.activity?.moderationAction(guildId, moderator, type);
    }
  }
}
