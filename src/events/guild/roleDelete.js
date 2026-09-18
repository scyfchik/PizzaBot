import { Events } from 'discord.js';
import { roleEmbed } from '../../systems/logging/serverEvents.js';

export const name = Events.GuildRoleDelete;

export async function execute(client, role) {
  await client.getSystem('antiNuke').onRoleDelete(role);
  await client.getSystem('logging').server(role.guild.id, roleEmbed('deleted', role));
}
