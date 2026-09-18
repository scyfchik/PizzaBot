import { Events } from 'discord.js';

export const name = Events.WebhooksUpdate;

/**
 * Webhook floods are the classic nuke delivery method: create dozens of
 * webhooks, then spam every channel at once without needing the bot's own
 * rate limits. Discord does not say whether a webhook was created or deleted,
 * so anti-nuke resolves that from the audit log.
 */
export async function execute(client, channel) {
  if (!channel.guild) return;
  await client.getSystem('antiNuke').onWebhookCreate(channel);
}
