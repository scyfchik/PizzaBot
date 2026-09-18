import { Events } from 'discord.js';
import { memberLeaveEmbed } from '../../systems/logging/serverEvents.js';

export const name = Events.GuildMemberRemove;

/**
 * A member left — voluntarily, or by being kicked. Discord fires the same
 * event for both, so anti-nuke checks the audit log to tell them apart.
 */
export async function execute(client, member) {
  if (member.partial) {
    const fetched = await member.fetch().catch(() => null);
    if (!fetched) return;
    member = fetched;
  }

  await client.getSystem('antiNuke').onKick(member);
  await client.getSystem('logging').server(member.guild.id, memberLeaveEmbed(member));
}
