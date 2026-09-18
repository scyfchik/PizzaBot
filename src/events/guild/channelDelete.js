import { Events } from 'discord.js';
import { channelEmbed } from '../../systems/logging/serverEvents.js';

export const name = Events.ChannelDelete;

export async function execute(client, channel) {
  if (!channel.guild) return; // DM channel

  await client.getSystem('antiNuke').onChannelDelete(channel);
  await client.getSystem('logging').server(channel.guild.id, channelEmbed('deleted', channel));
}
