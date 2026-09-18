import { Events } from 'discord.js';
import { User } from '../../database/models/User.js';
import { memberJoinEmbed } from '../../systems/logging/serverEvents.js';

export const name = Events.GuildMemberAdd;

export async function execute(client, member) {
  if (member.user.bot) {
    // A bot joining is worth noticing — it is how most nukes start.
    await client.getSystem('logging').security(
      member.guild.id,
      memberJoinEmbed(member).setAuthor({ name: '🤖 Bot added to the server' }),
    );
    return;
  }

  await User.ensure(member.guild.id, member.id, {
    username: member.user.tag,
    displayName: member.displayName,
  });

  // Anti-raid runs first: if this join is part of a wave, the response should
  // not wait behind a log write.
  await client.getSystem('antiRaid').handleJoin(member);

  await client.getSystem('logging').server(member.guild.id, memberJoinEmbed(member));
}
