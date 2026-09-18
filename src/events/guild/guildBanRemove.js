import { Events } from 'discord.js';

export const name = Events.GuildBanRemove;

/**
 * A ban was lifted. Recorded as its own case and the original marked inactive,
 * so `/player history` stops showing a long-lifted ban as still in force.
 */
export async function execute(client, ban) {
  await client.getSystem('auditRecorder').onBanRemove(ban);
}
