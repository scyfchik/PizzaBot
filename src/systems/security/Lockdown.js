import { ChannelType, PermissionFlagsBits } from 'discord.js';
import { getConfig, saveConfig } from '../../config/guildConfig.js';
import { SecurityEvent, Severity } from '../../config/constants.js';
import { safeAction } from '../../utils/safeAction.js';
import { field } from '../../utils/embeds.js';
import { UserError } from '../../core/errors.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('lockdown');

/**
 * Server lockdown: deny @everyone from sending in text channels.
 *
 * The important part is the snapshot. Before changing anything we record each
 * channel's *existing* @everyone SendMessages value — allow, deny, or unset.
 * Lifting the lockdown restores exactly that, instead of blanket-allowing and
 * quietly opening channels that were locked on purpose beforehand.
 *
 * A lockdown also carries an expiry, because the most common failure mode is
 * not a bad lockdown — it is a lockdown nobody remembers to lift.
 */
export class Lockdown {
  constructor(client, security) {
    this.client = client;
    this.security = security;
  }

  async enable(guild, { reason, minutes = 15, by = null }) {
    const config = await getConfig(guild.id);
    if (config.security.lockdown.active) {
      throw new UserError('The server is already locked down.');
    }

    const everyone = guild.roles.everyone;
    const channels = guild.channels.cache.filter(
      (c) => c.type === ChannelType.GuildText || c.type === ChannelType.GuildAnnouncement,
    );

    const snapshot = [];
    for (const channel of channels.values()) {
      const existing = channel.permissionOverwrites.cache.get(everyone.id);
      const current = existing
        ? existing.allow.has(PermissionFlagsBits.SendMessages)
          ? true
          : existing.deny.has(PermissionFlagsBits.SendMessages)
            ? false
            : null
        : null;

      // Already locked — leave it alone, and do not record it for restoration.
      if (current === false) continue;

      const result = await safeAction(`lock:${channel.id}`, () =>
        channel.permissionOverwrites.edit(everyone, { SendMessages: false }, { reason }),
      );
      if (result.ok) snapshot.push({ channelId: channel.id, previous: current });
    }

    config.security.lockdown = {
      active: true,
      startedAt: new Date(),
      startedBy: by?.id ?? null,
      reason,
      expiresAt: minutes ? new Date(Date.now() + minutes * 60_000) : null,
      snapshot,
    };
    await saveConfig(config);

    await this.security.record({
      guildId: guild.id,
      event: SecurityEvent.LOCKDOWN_ENABLED,
      severity: Severity.HIGH,
      user: by,
      action: 'lockdown',
      details: { reason, channels: snapshot.length, minutes },
    });

    await this.security.alert(guild.id, {
      title: 'Server lockdown enabled',
      description: `**${snapshot.length}** channels locked.\n${reason}`,
      severity: Severity.HIGH,
      fields: [
        field('By', by ? `<@${by.id}>` : 'Automatic (anti-raid)', true),
        field('Auto-lifts', minutes ? `in ${minutes} minutes` : 'never — lift manually', true),
      ],
    });

    log.warn({ guild: guild.id, channels: snapshot.length, reason }, 'Lockdown enabled');
    return snapshot.length;
  }

  async disable(guild, by = null) {
    const config = await getConfig(guild.id);
    const state = config.security.lockdown;
    if (!state.active) throw new UserError('The server is not locked down.');

    const everyone = guild.roles.everyone;
    let restored = 0;

    for (const { channelId, previous } of state.snapshot ?? []) {
      const channel = guild.channels.cache.get(channelId);
      if (!channel) continue;

      const result = await safeAction(`unlock:${channelId}`, () =>
        channel.permissionOverwrites.edit(
          everyone,
          { SendMessages: previous }, // null clears the overwrite entirely
          { reason: 'Lockdown lifted' },
        ),
      );
      if (result.ok) restored += 1;
    }

    config.security.lockdown = {
      active: false,
      startedAt: null,
      startedBy: null,
      reason: null,
      expiresAt: null,
      snapshot: [],
    };
    await saveConfig(config);

    await this.security.record({
      guildId: guild.id,
      event: SecurityEvent.LOCKDOWN_DISABLED,
      severity: Severity.MEDIUM,
      user: by,
      action: 'unlock',
      details: { restored },
    });

    await this.security.alert(guild.id, {
      title: 'Server lockdown lifted',
      description: `**${restored}** channels restored to their previous state.`,
      severity: Severity.MEDIUM,
      fields: [field('By', by ? `<@${by.id}>` : 'Automatic (expired)', true)],
    });

    log.info({ guild: guild.id, restored }, 'Lockdown lifted');
    return restored;
  }

  /** Called on a timer — lifts lockdowns whose expiry has passed. */
  async sweepExpired() {
    for (const guild of this.client.guilds.cache.values()) {
      const config = await getConfig(guild.id);
      const state = config.security?.lockdown;
      if (!state?.active || !state.expiresAt) continue;
      if (new Date(state.expiresAt) > new Date()) continue;

      await this.disable(guild, null).catch((err) =>
        log.error({ err, guild: guild.id }, 'Auto-unlock failed'),
      );
    }
  }
}
