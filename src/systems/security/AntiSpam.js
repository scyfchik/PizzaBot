import { createHash } from 'node:crypto';
import { getConfig } from '../../config/guildConfig.js';
import { User } from '../../database/models/User.js';
import { SlidingWindow } from './SlidingWindow.js';
import { detectScam, detectBlacklisted } from './contentFilters.js';
import {
  SecurityEvent,
  Severity,
  PunishmentType,
  CaseOrigin,
  Permission,
} from '../../config/constants.js';
import { resolveStaff, hasPermission } from '../staff/permissions.js';
import { safeAction } from '../../utils/safeAction.js';
import { field } from '../../utils/embeds.js';
import { formatDuration } from '../../utils/time.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('anti-spam');

const INVITE_RE = /(discord\.(gg|io|me|li)|discordapp\.com\/invite)\/[a-z0-9-]+/gi;
const LINK_RE = /https?:\/\/\S+/gi;
const EMOJI_RE = /<a?:\w+:\d+>|\p{Extended_Pictographic}/gu;

/**
 * Escalation ladder. Index is the strike count; a user's strikes decay after
 * `decayMinutes` of good behaviour.
 *
 * Deliberately gentle at the start. Most "spam" in a Roblox community is an
 * excited 12-year-old posting four messages in a row, not an attacker — a
 * first offence should cost them a deleted message, not a day of silence.
 */
const LADDER = [
  { action: 'warn' },
  { action: 'timeout', duration: 5 * 60_000 },
  { action: 'timeout', duration: 60 * 60_000 },
  { action: 'timeout', duration: 24 * 60 * 60_000 },
];

export class AntiSpam {
  constructor(client, security, moderation) {
    this.client = client;
    this.security = security;
    this.moderation = moderation;

    /** Recent messages per user, for rate and duplicate detection. */
    this.messages = new SlidingWindow(60_000);
  }

  /** Housekeeping — called on a timer by the ready handler. */
  prune() {
    this.messages.prune();
  }

  /**
   * Inspect one message. Returns `true` if it was acted on.
   * Called from `messageCreate`, so it must be cheap and must never throw.
   */
  async handleMessage(message) {
    if (!message.guild || message.author.bot || message.system) return false;

    const config = await getConfig(message.guild.id);
    const rules = config.security?.antiSpam;
    if (!rules?.enabled) return false;

    if (rules.ignoredChannels?.includes(message.channelId)) return false;
    if (message.member?.roles.cache.hasAny(...(rules.ignoredRoles ?? ['0']))) return false;

    // Staff who can moderate are exempt — otherwise posting five case links in
    // a row during an incident gets the moderator muted.
    const staff = message.member ? await resolveStaff(message.member) : null;
    if (staff?.isStaff && hasPermission(staff, Permission.MOD_WARN)) return false;

    const violation = this.#detect(message, rules, config.security?.autoMod);
    if (!violation) return false;

    await this.#respond(message, violation, config);
    return true;
  }

  /** Returns the first rule the message breaks, or `null`. */
  #detect(message, rules, autoMod) {
    const content = message.content ?? '';

    // Content checks run first. A scam link posted once is more urgent than
    // six harmless messages in five seconds, and checking content before rate
    // means the offending message is named in the log rather than "6 messages".
    if (autoMod?.scamDetection) {
      const scam = detectScam(content);
      if (scam) {
        return {
          event: SecurityEvent.SCAM_PATTERN,
          detail: `Scam pattern: ${scam.name}`,
          severity: Severity.MEDIUM,
          override: autoMod.scamAction,
        };
      }
    }

    if (autoMod?.blacklistEnabled) {
      const hit = detectBlacklisted(content, autoMod.blacklist);
      if (hit) {
        return {
          event: SecurityEvent.BLACKLISTED_WORD,
          detail: `Blacklisted term: "${hit.term}"`,
          severity: Severity.LOW,
          override: autoMod.blacklistAction,
          /** Never echo the term back into the log embed verbatim. */
          redact: true,
        };
      }
    }

    const mentions = message.mentions.users.size + message.mentions.roles.size;
    if (mentions > rules.mentionLimit) {
      return { event: SecurityEvent.SPAM_MENTION, detail: `${mentions} mentions in one message` };
    }

    if (rules.blockInvites && INVITE_RE.test(content)) {
      INVITE_RE.lastIndex = 0;
      return { event: SecurityEvent.SPAM_INVITE, detail: 'Discord invite link' };
    }

    const links = content.match(LINK_RE)?.length ?? 0;
    if (links > rules.linkLimit) {
      return { event: SecurityEvent.SPAM_LINK, detail: `${links} links in one message` };
    }

    const emojis = content.match(EMOJI_RE)?.length ?? 0;
    if (emojis > rules.emojiLimit) {
      return { event: SecurityEvent.SPAM_EMOJI, detail: `${emojis} emoji in one message` };
    }

    // Rate and duplicate share one window keyed by user, so duplicates are
    // caught across channels — the case a per-channel check always misses.
    const key = `${message.guild.id}:${message.author.id}`;
    const hash = createHash('sha1').update(content.toLowerCase().trim()).digest('hex').slice(0, 12);
    const recent = this.messages.hit(key, { hash, channelId: message.channelId, id: message.id });

    const windowMs = rules.windowSeconds * 1000;
    const cutoff = Date.now() - windowMs;
    const inWindow = recent.filter((e) => e.at > cutoff);

    if (inWindow.length >= rules.messageThreshold) {
      return {
        event: SecurityEvent.SPAM_RATE,
        detail: `${inWindow.length} messages in ${rules.windowSeconds}s`,
        messages: inWindow.map((e) => e.data),
      };
    }

    if (content.length > 3) {
      const duplicates = inWindow.filter((e) => e.data?.hash === hash);
      if (duplicates.length >= rules.duplicateThreshold) {
        return {
          event: SecurityEvent.SPAM_DUPLICATE,
          detail: `Same message ${duplicates.length} times across ${
            new Set(duplicates.map((d) => d.data.channelId)).size
          } channel(s)`,
          messages: duplicates.map((e) => e.data),
        };
      }
    }

    return null;
  }

  async #respond(message, violation, config) {
    const rules = config.security.antiSpam;
    const guildId = message.guild.id;

    const entry = await this.security.record({
      guildId,
      event: violation.event,
      severity: violation.severity ?? Severity.LOW,
      user: message.author,
      channelId: message.channelId,
      details: {
        detail: violation.detail,
        // A blacklist hit's content is the thing we are suppressing; copying it
        // into the security log just relocates it somewhere staff scroll past.
        content: violation.redact ? '[redacted]' : message.content?.slice(0, 200),
      },
    });

    // Always delete the offending message, plus the burst that triggered it.
    await safeAction('delete-spam', () => message.delete());
    if (violation.messages?.length) {
      for (const ref of violation.messages) {
        if (ref.id === message.id) continue;
        await safeAction('delete-burst', async () => {
          const channel = await this.client.channels.fetch(ref.channelId);
          const target = await channel.messages.fetch(ref.id);
          await target.delete();
        });
      }
      this.messages.reset(`${guildId}:${message.author.id}`);
    }

    const strikes = await this.#addStrike(guildId, message.author.id, rules.decayMinutes);
    let step = LADDER[Math.min(strikes - 1, LADDER.length - 1)];

    // Content rules carry their own configured action, which overrides the
    // strike ladder. A scam link should not get a free pass just because it is
    // the poster's first message — that is exactly how a compromised account
    // gets one shot at the whole server.
    if (violation.override) {
      step = {
        delete: { action: 'delete' },
        delete_warn: { action: 'warn' },
        delete_timeout: { action: 'timeout', duration: 60 * 60_000 },
      }[violation.override] ?? step;
    }

    // The message is already gone; tell the user why, briefly, and clean up
    // after ourselves so the channel does not fill with bot notices.
    const notify = async (text) => {
      await safeAction('automod-notice', async () => {
        const notice = await message.channel.send({ content: `${message.author}, ${text}` });
        setTimeout(() => notice.delete().catch(() => {}), 8000);
      });
    };

    if (step.action === 'delete') {
      await this.security.markAction(entry, { action: 'delete' });
      await notify(this.#noticeFor(violation));
      return;
    }

    if (step.action === 'warn') {
      const punishment = await this.moderation.createCase({
        guild: message.guild,
        type: PunishmentType.WARN,
        target: message.author,
        reason: `Automatic: ${violation.detail}`,
        origin: violation.override ? CaseOrigin.AUTOMOD : CaseOrigin.ANTI_SPAM,
        context: { channelId: message.channelId, triggerRule: violation.event },
      });

      await this.security.markAction(entry, { action: 'warn', caseId: punishment.caseId });
      await notify(`${this.#noticeFor(violation)} You have been warned.`);
      return;
    }

    // Timeouts get a case, so spam history shows up in /history like anything else.
    const member = message.member ?? (await message.guild.members.fetch(message.author.id).catch(() => null));
    if (!member) return;

    const punishment = await this.moderation.createCase({
      guild: message.guild,
      type: PunishmentType.TIMEOUT,
      target: message.author,
      reason: `Automatic anti-spam: ${violation.detail} (strike ${strikes})`,
      origin: CaseOrigin.ANTI_SPAM,
      duration: step.duration,
      context: { channelId: message.channelId, triggerRule: violation.event },
    });

    const applied = await safeAction('spam-timeout', () =>
      member.timeout(step.duration, `Anti-spam strike ${strikes} — case #${punishment.caseId}`),
    );

    await this.security.markAction(entry, {
      action: `timeout:${formatDuration(step.duration)}`,
      succeeded: applied.ok,
      error: applied.error,
      caseId: punishment.caseId,
    });

    // Repeat offenders are worth a human look — one-off deletions are not.
    if (strikes >= 3) {
      await this.security.alert(guildId, {
        title: 'Repeat spam offender',
        description: `${message.author} has hit **${strikes}** spam strikes.`,
        severity: Severity.MEDIUM,
        fields: [
          field('Latest trigger', violation.detail, true),
          field('Action', `Timed out ${formatDuration(step.duration)}`, true),
          field('Case', `#${punishment.caseId}`, true),
        ],
      });
    }

    log.info(
      { user: message.author.id, strikes, rule: violation.event },
      'Anti-spam action taken',
    );
  }

  /**
   * What to tell the user.
   *
   * Never repeats the blacklisted term or the scam text back into the channel —
   * that would re-post the thing we just deleted.
   */
  #noticeFor(violation) {
    switch (violation.event) {
      case SecurityEvent.SCAM_PATTERN:
        return 'that message looked like a scam and was removed. Never enter your password or Roblox login anywhere outside roblox.com.';
      case SecurityEvent.BLACKLISTED_WORD:
        return 'your message contained a word that is not allowed here and was removed.';
      case SecurityEvent.SPAM_INVITE:
        return 'server invites are not allowed here.';
      default:
        return `please slow down — ${violation.detail}.`;
    }
  }

  /**
   * Increment the user's strike count, resetting it first if enough quiet time
   * has passed. Strikes live on the User document so they survive a restart —
   * unlike the message window, a punishment ladder that forgets everything on
   * deploy is trivially farmable.
   */
  async #addStrike(guildId, userId, decayMinutes) {
    const profile = await User.ensure(guildId, userId);
    const decayMs = (decayMinutes ?? 30) * 60_000;
    const last = profile.stats?.lastStrikeAt?.getTime() ?? 0;

    const strikes = Date.now() - last > decayMs ? 1 : (profile.stats?.spamStrikes ?? 0) + 1;

    await User.updateOne(
      { guildId, discordId: userId },
      { $set: { 'stats.spamStrikes': strikes, 'stats.lastStrikeAt': new Date() } },
    );

    return strikes;
  }
}
