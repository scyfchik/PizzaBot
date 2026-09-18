import { EmbedBuilder } from 'discord.js';
import { Colors } from '../../config/constants.js';
import { field, userLabel, truncate } from '../../utils/embeds.js';
import { fullTimestamp, accountAgeDays } from '../../utils/time.js';

/**
 * Embed builders for passive server events.
 *
 * Kept apart from the event handlers so the handlers stay three lines long and
 * the visual language of the log is defined in one file.
 */

export function memberJoinEmbed(member) {
  const age = accountAgeDays(member.user.createdAt);
  const embed = new EmbedBuilder()
    .setColor(age < 7 ? Colors.WARNING : Colors.SUCCESS)
    .setAuthor({ name: 'Member joined', iconURL: member.user.displayAvatarURL() })
    .setDescription(`${member} ${userLabel(member.user)}`)
    .addFields(
      field('Account created', `${fullTimestamp(member.user.createdAt)}\n**${age} days old**`, true),
      field('Member count', String(member.guild.memberCount), true),
    )
    .setTimestamp();

  // Only footer when it says something — Discord rejects an empty footer.
  if (age < 7) embed.setFooter({ text: 'New account — worth a glance' });
  return embed;
}

export function memberLeaveEmbed(member) {
  const roles = member.roles?.cache
    ?.filter((r) => r.id !== member.guild.id)
    .map((r) => r.toString())
    .join(', ');

  return new EmbedBuilder()
    .setColor(Colors.NEUTRAL)
    .setAuthor({ name: 'Member left', iconURL: member.user.displayAvatarURL() })
    .setDescription(userLabel(member.user))
    .addFields(
      field('Joined', member.joinedAt ? fullTimestamp(member.joinedAt) : 'Unknown', true),
      field('Roles', roles || 'None'),
    )
    .setTimestamp();
}

export function roleChangeEmbed(member, added, removed) {
  const embed = new EmbedBuilder()
    .setColor(Colors.INFO)
    .setAuthor({ name: 'Roles updated', iconURL: member.user.displayAvatarURL() })
    .setDescription(userLabel(member.user))
    .setTimestamp();

  if (added.length) embed.addFields(field('Added', added.map((r) => `${r}`).join(', ')));
  if (removed.length) embed.addFields(field('Removed', removed.map((r) => `${r}`).join(', ')));
  return embed;
}

export function nicknameChangeEmbed(member, before, after) {
  return new EmbedBuilder()
    .setColor(Colors.INFO)
    .setAuthor({ name: 'Nickname changed', iconURL: member.user.displayAvatarURL() })
    .setDescription(userLabel(member.user))
    .addFields(field('Before', before || 'None', true), field('After', after || 'None', true))
    .setTimestamp();
}

export function channelEmbed(action, channel, executor = null) {
  const colors = { created: Colors.SUCCESS, deleted: Colors.DANGER, updated: Colors.INFO };
  const embed = new EmbedBuilder()
    .setColor(colors[action] ?? Colors.NEUTRAL)
    .setAuthor({ name: `Channel ${action}` })
    .addFields(
      field('Channel', action === 'deleted' ? `#${channel.name}` : `${channel}`, true),
      field('Type', String(channel.type), true),
    )
    .setTimestamp();

  if (executor) embed.addFields(field('By', userLabel(executor)));
  return embed;
}

export function roleEmbed(action, role, executor = null) {
  const colors = { created: Colors.SUCCESS, deleted: Colors.DANGER, updated: Colors.INFO };
  const embed = new EmbedBuilder()
    .setColor(colors[action] ?? Colors.NEUTRAL)
    .setAuthor({ name: `Role ${action}` })
    .addFields(field('Role', action === 'deleted' ? `@${role.name}` : `${role}`, true))
    .setTimestamp();

  if (executor) embed.addFields(field('By', userLabel(executor)));
  return embed;
}

/**
 * Bans and kicks that did NOT come from this bot — someone used Discord's own
 * UI or another bot. Surfacing these is the point: the case log only knows
 * about actions taken through us.
 */
export function externalActionEmbed(action, user, executor, reason) {
  return new EmbedBuilder()
    .setColor(Colors.WARNING)
    .setAuthor({ name: `${action} (outside the bot)` })
    .setDescription(userLabel(user))
    .addFields(
      field('By', executor ? userLabel(executor) : 'Unknown', true),
      field('Reason', truncate(reason) || 'None given', true),
    )
    .setFooter({ text: 'No case was recorded — action taken outside the bot' })
    .setTimestamp();
}
