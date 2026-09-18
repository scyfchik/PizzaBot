import { getConfig } from '../../config/guildConfig.js';
import { SlidingWindow } from './SlidingWindow.js';
import {
  SecurityEvent,
  Severity,
  PunishmentType,
  CaseOrigin,
} from '../../config/constants.js';
import { SecurityService } from './SecurityService.js';
import { safeAction } from '../../utils/safeAction.js';
import { field } from '../../utils/embeds.js';
import { accountAgeDays } from '../../utils/time.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('anti-raid');

/**
 * Join-wave detection.
 *
 * Three signals, in increasing order of confidence:
 *   1. raw join rate      — noisy; a YouTuber shout-out looks identical
 *   2. new-account rate   — much stronger; organic spikes are mostly old accounts
 *   3. username similarity — catches botnets that stagger joins to stay under (1)
 *
 * The response only fires on signal 2 or 3, or on 1 *combined with* a majority
 * of new accounts. Acting on raw join rate alone means punishing a successful
 * game launch, which is the worst possible day to lock your server.
 */
export class AntiRaid {
  constructor(client, security, moderation, lockdown) {
    this.client = client;
    this.security = security;
    this.moderation = moderation;
    this.lockdown = lockdown;

    this.joins = new SlidingWindow(120_000);
    /** Guilds currently in an active raid response, to avoid duplicate alerts. */
    this.active = new Map();
  }

  prune() {
    this.joins.prune();
  }

  async handleJoin(member) {
    const config = await getConfig(member.guild.id);
    const rules = config.security?.antiRaid;
    if (!rules?.enabled) return false;

    const ageDays = accountAgeDays(member.user.createdAt);
    const recent = this.joins.hit(member.guild.id, {
      id: member.id,
      username: member.user.username.toLowerCase(),
      ageDays,
    });

    const windowMs = rules.windowSeconds * 1000;
    const inWindow = recent.filter((e) => e.at > Date.now() - windowMs);

    const newAccounts = inWindow.filter((e) => e.data.ageDays < rules.newAccountDays);
    const similar = findSimilarCluster(inWindow.map((e) => e.data.username));

    const signals = [];
    if (inWindow.length >= rules.joinThreshold) {
      signals.push(`${inWindow.length} joins in ${rules.windowSeconds}s`);
    }
    if (newAccounts.length >= rules.newAccountThreshold) {
      signals.push(`${newAccounts.length} accounts younger than ${rules.newAccountDays} days`);
    }
    if (similar.length >= 4) {
      signals.push(`${similar.length} near-identical usernames`);
    }

    if (!signals.length) return false;

    // A join spike of aged accounts is a good day, not an attack.
    const confident =
      newAccounts.length >= rules.newAccountThreshold ||
      similar.length >= 4 ||
      newAccounts.length > inWindow.length / 2;

    if (!confident) {
      await this.security.record({
        guildId: member.guild.id,
        event: SecurityEvent.JOIN_WAVE,
        severity: Severity.LOW,
        details: { signals, joins: inWindow.length, newAccounts: newAccounts.length },
      });
      return false;
    }

    // One response per wave, not one per member of the wave.
    if (this.active.has(member.guild.id)) {
      const incidentId = this.active.get(member.guild.id);
      await this.#handleRaider(member, config, incidentId);
      return true;
    }

    const incidentId = SecurityService.newIncidentId();
    this.active.set(member.guild.id, incidentId);
    setTimeout(() => this.active.delete(member.guild.id), windowMs * 3).unref?.();

    await this.#respond(member, config, inWindow, signals, incidentId, newAccounts.length);
    return true;
  }

  async #respond(member, config, wave, signals, incidentId, newAccountCount) {
    const rules = config.security.antiRaid;
    const guild = member.guild;

    await this.security.record({
      guildId: guild.id,
      event: newAccountCount >= rules.newAccountThreshold
        ? SecurityEvent.NEW_ACCOUNT_WAVE
        : SecurityEvent.JOIN_WAVE,
      severity: Severity.HIGH,
      action: rules.action,
      incidentId,
      details: { signals, waveSize: wave.length, newAccounts: newAccountCount },
    });

    await this.security.alert(guild.id, {
      title: 'Possible raid detected',
      description:
        `**${wave.length}** accounts joined in the last ${rules.windowSeconds} seconds.\n` +
        `Response: \`${rules.action}\`.`,
      severity: Severity.HIGH,
      fields: [
        field('Signals', signals.map((s) => `• ${s}`).join('\n')),
        field('Incident', `\`${incidentId}\``, true),
        field(
          'Sample',
          wave
            .slice(-6)
            .map((e) => `<@${e.data.id}> — ${e.data.ageDays}d old`)
            .join('\n'),
        ),
      ],
    });

    // Act on everyone already in the wave, then on stragglers as they arrive.
    for (const entry of wave) {
      const target = await guild.members.fetch(entry.data.id).catch(() => null);
      if (target) await this.#handleRaider(target, config, incidentId);
    }

    if (rules.autoLockdown) {
      await this.lockdown.enable(guild, {
        reason: `Automatic: raid detected (incident ${incidentId})`,
        minutes: rules.lockdownMinutes,
        by: null,
      });
    }

    log.warn({ guild: guild.id, incidentId, wave: wave.length }, 'Raid response executed');
  }

  /**
   * Apply the configured response to one account.
   *
   * Quarantine is the default rather than kick or ban: it is fully reversible.
   * If the detector was wrong, a wrongly quarantined player gets their roles
   * back and an apology — a wrongly banned one is just gone.
   */
  async #handleRaider(member, config, incidentId) {
    const rules = config.security.antiRaid;
    if (rules.action === 'alert_only') return;

    if (rules.action === 'kick') {
      const punishment = await this.moderation.createCase({
        guild: member.guild,
        type: PunishmentType.KICK,
        target: member.user,
        reason: `Automatic anti-raid response (incident ${incidentId})`,
        origin: CaseOrigin.ANTI_RAID,
        context: { triggerRule: 'anti_raid' },
      });
      await safeAction('raid-kick', () => member.kick(`Anti-raid — case #${punishment.caseId}`));
      return;
    }

    const roleId = config.security?.quarantineRoleId;
    if (!roleId) {
      log.warn({ guild: member.guild.id }, 'Quarantine requested but no quarantine role is set');
      return;
    }

    const punishment = await this.moderation.createCase({
      guild: member.guild,
      type: PunishmentType.QUARANTINE,
      target: member.user,
      reason: `Automatic anti-raid response (incident ${incidentId})`,
      origin: CaseOrigin.ANTI_RAID,
      duration: (rules.lockdownMinutes ?? 15) * 60_000,
      context: { triggerRule: 'anti_raid' },
    });

    await safeAction('quarantine', () =>
      member.roles.add(roleId, `Anti-raid — case #${punishment.caseId}`),
    );
  }
}

/**
 * Find the largest cluster of names sharing a prefix or differing by a couple
 * of characters. Cheap stand-in for edit distance: raid bots overwhelmingly use
 * `name1`, `name2`, `name3` or a shared prefix, and a full Levenshtein matrix
 * over every pair on every join is not worth the CPU.
 */
function findSimilarCluster(usernames) {
  if (usernames.length < 4) return [];

  const buckets = new Map();
  for (const name of usernames) {
    const key = name.replace(/\d+$/, '').slice(0, 6);
    if (key.length < 3) continue;
    buckets.set(key, [...(buckets.get(key) ?? []), name]);
  }

  let largest = [];
  for (const group of buckets.values()) if (group.length > largest.length) largest = group;
  return largest;
}
