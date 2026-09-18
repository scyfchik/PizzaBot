import { Events } from 'discord.js';
import { roleChangeEmbed, nicknameChangeEmbed } from '../../systems/logging/serverEvents.js';

export const name = Events.GuildMemberUpdate;

export async function execute(client, before, after) {
  const logs = client.getSystem('logging');

  // Timeouts applied or lifted by another bot or a moderator are recorded as
  // cases, so the history stays complete without Pizza Bot issuing them.
  await client.getSystem('auditRecorder').onTimeoutChange(before, after);

  const added = [...after.roles.cache.values()].filter((r) => !before.roles.cache.has(r.id));
  const removed = [...before.roles.cache.values()].filter((r) => !after.roles.cache.has(r.id));

  if (added.length || removed.length) {
    await logs.server(after.guild.id, roleChangeEmbed(after, added, removed));
  }

  if (before.nickname !== after.nickname) {
    await logs.server(after.guild.id, nicknameChangeEmbed(after, before.nickname, after.nickname));
  }
}
