import { Events } from 'discord.js';

export const name = Events.GuildBanAdd;

/**
 * Someone was banned — by Dyno, by a moderator through Discord's own UI, or by
 * this bot's anti-raid. The audit recorder works out which and writes the case.
 */
export async function execute(client, ban) {
  await client.getSystem('antiNuke').onBanAdd(ban);
  await client.getSystem('auditRecorder').onBanAdd(ban);
}
