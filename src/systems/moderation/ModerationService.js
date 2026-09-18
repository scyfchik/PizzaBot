import { Punishment } from '../../database/models/Punishment.js';
import { User } from '../../database/models/User.js';
import { Counter, CounterScope } from '../../database/models/Counter.js';
import { getConfig } from '../../config/guildConfig.js';
import { PunishmentType, CaseOrigin, Limits } from '../../config/constants.js';
import { caseLogEmbed, userNoticeEmbed } from './caseEmbeds.js';
import { UserError } from '../../core/errors.js';
import { safeAction, trySendDM } from '../../utils/safeAction.js';
import { padNumber } from '../../utils/embeds.js';
import { MAX_TIMEOUT_MS, formatDuration } from '../../utils/time.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('moderation');

/**
 * All moderation actions.
 *
 * Every method follows the same shape, and the order matters:
 *
 *   1. record the case   — so it exists even if Discord fails
 *   2. DM the user       — while they can still receive it (before a ban/kick)
 *   3. perform the action
 *   4. log the embed
 *
 * DMing before banning is the non-obvious one: once someone is banned the bot
 * shares no server with them and Discord refuses the DM, so a user banned
 * without notice has no idea what to appeal.
 */
export class ModerationService {
  constructor(client, logService, staffActivity) {
    this.client = client;
    this.logs = logService;
    this.activity = staffActivity;
  }

  // ------------------------------------------------------------- cases

  /** Create the case record. Everything else is a side effect of this. */
  async createCase({
    guild,
    type,
    target,
    moderator = null,
    reason = 'No reason provided',
    evidence = [],
    duration = null,
    origin = CaseOrigin.COMMAND,
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
      reason: reason.slice(0, Limits.REASON_MAX),
      evidence,
      duration,
      expiresAt: duration ? new Date(Date.now() + duration) : null,
      context,
    });

    await this.#bumpCounters(guild.id, type, target.id, moderator);
    return punishment;
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

    // Automatic actions have no moderator, and must not credit anyone.
    if (moderator?.id) {
      await this.activity?.moderationAction(guildId, moderator, type);
    }
  }

  /** DM the user, record whether it landed, and post the moderation log. */
  async #finalise(punishment, guild, { dm = true } = {}) {
    const config = await getConfig(guild.id);

    if (dm && config.moderation?.dmOnPunishment) {
      const user = await this.client.users.fetch(punishment.userId).catch(() => null);
      if (user) {
        punishment.notified = await trySendDM(user, {
          embeds: [userNoticeEmbed(punishment, guild.name)],
        });
      }
    }

    const message = await this.logs.moderation(guild.id, caseLogEmbed(punishment));
    if (message) punishment.logMessageId = message.id;
    await punishment.save();

    return punishment;
  }

  // ------------------------------------------------------------- actions

  async warn(guild, target, moderator, reason, evidence = []) {
    const punishment = await this.createCase({
      guild,
      type: PunishmentType.WARN,
      target: target.user ?? target,
      moderator,
      reason,
      evidence,
    });

    await this.#finalise(punishment, guild);
    const escalated = await this.#maybeEscalate(guild, target, punishment);

    log.info({ caseId: punishment.caseId, user: target.id }, 'User warned');
    return { punishment, escalated };
  }

  async timeout(guild, member, moderator, duration, reason, evidence = []) {
    if (duration > MAX_TIMEOUT_MS) {
      throw new UserError('Discord caps timeouts at 28 days. Use a ban for anything longer.');
    }
    if (duration <= 0) throw new UserError('Timeout duration must be positive.');

    const punishment = await this.createCase({
      guild,
      type: PunishmentType.TIMEOUT,
      target: member.user,
      moderator,
      reason,
      evidence,
      duration,
    });

    await this.#finalise(punishment, guild);

    const result = await safeAction('timeout', () =>
      member.timeout(duration, this.#auditReason(punishment, moderator)),
    );
    if (!result.ok) {
      throw new UserError(
        `Case #${padNumber(punishment.caseId)} was recorded, but I could not apply the timeout — ` +
          'check my role position and Moderate Members permission.',
      );
    }

    log.info({ caseId: punishment.caseId, user: member.id, duration }, 'User timed out');
    return { punishment };
  }

  async removeTimeout(guild, member, moderator, reason) {
    if (!member.isCommunicationDisabled()) throw new UserError('That member is not timed out.');

    const punishment = await this.createCase({
      guild,
      type: PunishmentType.UNTIMEOUT,
      target: member.user,
      moderator,
      reason,
    });

    await safeAction('remove-timeout', () =>
      member.timeout(null, this.#auditReason(punishment, moderator)),
    );

    // Mark the original timeout inactive so /history reads correctly.
    await Punishment.updateMany(
      { guildId: guild.id, userId: member.id, type: PunishmentType.TIMEOUT, active: true },
      { $set: { active: false } },
    );

    await this.#finalise(punishment, guild, { dm: false });
    return { punishment };
  }

  async kick(guild, member, moderator, reason, evidence = []) {
    const punishment = await this.createCase({
      guild,
      type: PunishmentType.KICK,
      target: member.user,
      moderator,
      reason,
      evidence,
    });

    // DM first — after the kick they may not share a server with the bot.
    await this.#finalise(punishment, guild);

    const result = await safeAction('kick', () =>
      member.kick(this.#auditReason(punishment, moderator)),
    );
    if (!result.ok) {
      throw new UserError(
        `Case #${padNumber(punishment.caseId)} was recorded, but the kick failed — ` +
          'check my role position and Kick Members permission.',
      );
    }

    log.info({ caseId: punishment.caseId, user: member.id }, 'User kicked');
    return { punishment };
  }

  /**
   * @param {number} deleteMessageSeconds 0–604800, Discord's own parameter.
   * @param {number|null} duration temp-ban length; null for permanent.
   */
  async ban(guild, target, moderator, reason, { evidence = [], deleteMessageSeconds = 0, duration = null } = {}) {
    const existing = await guild.bans.fetch(target.id).catch(() => null);
    if (existing) throw new UserError('That user is already banned.');

    const punishment = await this.createCase({
      guild,
      type: PunishmentType.BAN,
      target,
      moderator,
      reason,
      evidence,
      duration,
    });

    await this.#finalise(punishment, guild);

    const result = await safeAction('ban', () =>
      guild.bans.create(target.id, {
        reason: this.#auditReason(punishment, moderator),
        deleteMessageSeconds,
      }),
    );
    if (!result.ok) {
      throw new UserError(
        `Case #${padNumber(punishment.caseId)} was recorded, but the ban failed — ` +
          'check my role position and Ban Members permission.',
      );
    }

    log.info({ caseId: punishment.caseId, user: target.id, duration }, 'User banned');
    return { punishment };
  }

  async unban(guild, userId, moderator, reason) {
    const existing = await guild.bans.fetch(userId).catch(() => null);
    if (!existing) throw new UserError('That user is not banned.');

    const punishment = await this.createCase({
      guild,
      type: PunishmentType.UNBAN,
      target: existing.user,
      moderator,
      reason,
    });

    await safeAction('unban', () =>
      guild.bans.remove(userId, this.#auditReason(punishment, moderator)),
    );

    await Punishment.updateMany(
      { guildId: guild.id, userId, type: PunishmentType.BAN, active: true },
      { $set: { active: false } },
    );

    await this.#finalise(punishment, guild, { dm: false });
    log.info({ caseId: punishment.caseId, user: userId }, 'User unbanned');
    return { punishment };
  }

  // ------------------------------------------------------------- escalation

  /**
   * Auto-escalate repeat warnings.
   *
   * Only counts *active* warns inside the decay window, so a case voided on
   * appeal genuinely stops counting against someone — otherwise "your appeal
   * was accepted" would be a lie the next time they slipped up.
   */
  async #maybeEscalate(guild, member, triggeringCase) {
    const config = await getConfig(guild.id);
    const rules = config.moderation?.escalation;
    if (!rules?.enabled) return null;

    const since = new Date(Date.now() - (rules.warnDecayDays ?? 90) * 86_400_000);
    const warnCount = await Punishment.countDocuments({
      guildId: guild.id,
      userId: member.id,
      type: PunishmentType.WARN,
      active: true,
      createdAt: { $gte: since },
    });

    const context = {
      triggerRule: `escalation:${warnCount}_warns`,
      autoEscalated: true,
    };

    try {
      if (rules.warnsBeforeKick && warnCount >= rules.warnsBeforeKick) {
        const target = await guild.members.fetch(member.id).catch(() => null);
        if (!target) return null;
        const punishment = await this.createCase({
          guild,
          type: PunishmentType.KICK,
          target: target.user,
          reason: `Automatic escalation: ${warnCount} active warnings`,
          origin: CaseOrigin.AUTO_ESCALATION,
          context,
        });
        await this.#finalise(punishment, guild);
        await safeAction('escalate-kick', () => target.kick('Automatic escalation'));
        return { action: 'kick', caseId: punishment.caseId, warnCount };
      }

      if (rules.warnsBeforeTimeout && warnCount >= rules.warnsBeforeTimeout) {
        const target = await guild.members.fetch(member.id).catch(() => null);
        if (!target) return null;
        const duration = (rules.timeoutMinutes ?? 60) * 60_000;
        const punishment = await this.createCase({
          guild,
          type: PunishmentType.TIMEOUT,
          target: target.user,
          reason: `Automatic escalation: ${warnCount} active warnings`,
          origin: CaseOrigin.AUTO_ESCALATION,
          duration,
          context,
        });
        await this.#finalise(punishment, guild);
        await safeAction('escalate-timeout', () => target.timeout(duration, 'Automatic escalation'));
        return { action: 'timeout', caseId: punishment.caseId, warnCount, duration };
      }
    } catch (err) {
      // Escalation failing must not fail the warn that triggered it.
      log.error({ err, user: member.id }, 'Escalation failed');
    }

    return null;
  }

  // ------------------------------------------------------------- expiry

  /**
   * Lift punishments whose time is up.
   *
   * Discord expires timeouts by itself, so this only needs to handle temp-bans
   * and quarantines — plus marking the corresponding cases inactive so
   * `/history` does not show a long-expired ban as still in force.
   */
  async sweepExpired() {
    const due = await Punishment.find({
      active: true,
      expiresAt: { $ne: null, $lte: new Date() },
    }).limit(50);

    for (const punishment of due) {
      const guild = await this.client.guilds.fetch(punishment.guildId).catch(() => null);
      if (!guild) continue;

      if (punishment.type === PunishmentType.BAN) {
        await safeAction('auto-unban', () =>
          guild.bans.remove(punishment.userId, `Temporary ban expired (case #${punishment.caseId})`),
        );
        await this.logs.moderation(
          guild.id,
          caseLogEmbed({ ...punishment.toObject(), active: false }).setFooter({
            text: `Temporary ban expired after ${formatDuration(punishment.duration)}`,
          }),
        );
      }

      if (punishment.type === PunishmentType.QUARANTINE) {
        const config = await getConfig(guild.id);
        const member = await guild.members.fetch(punishment.userId).catch(() => null);
        if (member && config.security?.quarantineRoleId) {
          await safeAction('auto-release', () =>
            member.roles.remove(config.security.quarantineRoleId, 'Quarantine expired'),
          );
        }
      }

      punishment.active = false;
      await punishment.save();
      log.info({ caseId: punishment.caseId, type: punishment.type }, 'Punishment expired');
    }

    return due.length;
  }

  #auditReason(punishment, moderator) {
    const who = moderator?.tag ?? moderator?.user?.tag ?? 'automatic';
    return `[#${padNumber(punishment.caseId)} by ${who}] ${punishment.reason}`.slice(0, 512);
  }
}
