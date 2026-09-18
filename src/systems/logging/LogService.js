import { getConfig } from '../../config/guildConfig.js';
import { safeAction } from '../../utils/safeAction.js';
import { createLogger } from '../../utils/logger.js';
import { LogChannel, Colors, SeverityColor, Severity } from '../../config/constants.js';

const log = createLogger('log-service');

/**
 * The embed audit log — the feed staff actually read.
 *
 * Distinct from `utils/logger`, which is the operational log for whoever runs
 * the server. This one answers "what happened in the community", in Discord,
 * split across five channels so reviewing staff conduct does not mean scrolling
 * past ten thousand routine join events.
 *
 * Logging must never break the action it is describing: a missing channel or a
 * revoked permission degrades to a warning in the operational log. A ban still
 * bans even if nobody can see the record.
 */
export class LogService {
  constructor(client) {
    this.client = client;
  }

  /**
   * Send an embed to one of the configured log channels.
   * Returns the sent message (so callers can store its id) or `null`.
   */
  async send(guildId, channelKey, embed, { content = null, components, files } = {}) {
    const config = await getConfig(guildId);
    const channelId = config.logChannels?.[channelKey];
    if (!channelId) return null; // feed intentionally disabled

    const channel = await this.#resolveChannel(channelId);
    if (!channel) {
      log.warn({ guildId, channelKey, channelId }, 'Log channel missing or unreachable');
      return null;
    }

    const payload = { embeds: [embed] };
    if (content) payload.content = content;
    if (components) payload.components = components;
    if (files) payload.files = files;

    const result = await safeAction(`log:${channelKey}`, () => channel.send(payload));
    return result.ok ? result.value : null;
  }

  security(guildId, embed, options) {
    return this.send(guildId, LogChannel.SECURITY, embed, options);
  }

  moderation(guildId, embed, options) {
    return this.send(guildId, LogChannel.MODERATION, embed, options);
  }

  tickets(guildId, embed, options) {
    return this.send(guildId, LogChannel.TICKETS, embed, options);
  }

  staff(guildId, embed, options) {
    return this.send(guildId, LogChannel.STAFF, embed, options);
  }

  server(guildId, embed, options) {
    return this.send(guildId, LogChannel.SERVER, embed, options);
  }

  /**
   * High-visibility security alert: goes to the dedicated alert channel when
   * one is set, pings the security role for high/critical, and always mirrors
   * into the security log so the record survives even if the alert is missed.
   */
  async alert(guildId, embed, { severity = Severity.HIGH, components } = {}) {
    const config = await getConfig(guildId);
    embed.setColor(SeverityColor[severity] ?? Colors.DANGER);

    const shouldPing =
      (severity === Severity.HIGH || severity === Severity.CRITICAL) && config.security?.pingRoleId;
    const content = shouldPing ? `<@&${config.security.pingRoleId}>` : null;

    const alertChannelId = config.security?.alertChannelId;
    if (alertChannelId) {
      const channel = await this.#resolveChannel(alertChannelId);
      if (channel) {
        const payload = { embeds: [embed] };
        if (content) payload.content = content;
        if (components) payload.components = components;
        const result = await safeAction('alert', () => channel.send(payload));
        if (result.ok) return result.value;
      }
      log.warn({ guildId, alertChannelId }, 'Alert channel missing — falling back to security log');
    }

    return this.send(guildId, LogChannel.SECURITY, embed, { content, components });
  }

  /** Edit a previously sent log embed in place (used when a case is voided). */
  async edit(guildId, channelKey, messageId, embed) {
    const config = await getConfig(guildId);
    const channelId = config.logChannels?.[channelKey];
    if (!channelId || !messageId) return false;

    const channel = await this.#resolveChannel(channelId);
    if (!channel) return false;

    const result = await safeAction('log:edit', async () => {
      const message = await channel.messages.fetch(messageId);
      return message.edit({ embeds: [embed] });
    });
    return result.ok;
  }

  async #resolveChannel(channelId) {
    const cached = this.client.channels.cache.get(channelId);
    if (cached) return cached;
    const result = await safeAction(`fetch-channel:${channelId}`, () =>
      this.client.channels.fetch(channelId),
    );
    return result.ok ? result.value : null;
  }
}
