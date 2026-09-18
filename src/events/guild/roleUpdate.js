import { Events } from 'discord.js';

export const name = Events.GuildRoleUpdate;

/**
 * Only permission changes matter here. Colour and name edits are noise, and
 * logging them buries the one change that actually matters.
 */
export async function execute(client, before, after) {
  if (before.permissions.bitfield === after.permissions.bitfield) return;
  await client.getSystem('antiNuke').onRoleUpdate(before, after);
}
