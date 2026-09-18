import { EmbedBuilder } from 'discord.js';
import { Colors, Emojis, Limits } from '../config/constants.js';

/**
 * Embed factories.
 *
 * Every user-visible message the bot sends comes from here, so the bot looks
 * like one product rather than forty developers' opinions.
 */

const FOOTER = "Pizza Guy's Time";

function base(color) {
  return new EmbedBuilder().setColor(color).setTimestamp();
}

export const embeds = {
  success: (description, title = null) =>
    base(Colors.SUCCESS)
      .setDescription(`${Emojis.CHECK} ${description}`)
      .setTitle(title),

  error: (description, title = null) =>
    base(Colors.DANGER)
      .setDescription(`${Emojis.CROSS} ${description}`)
      .setTitle(title),

  warning: (description, title = null) =>
    base(Colors.WARNING)
      .setDescription(`${Emojis.ALERT} ${description}`)
      .setTitle(title),

  info: (description, title = null) => base(Colors.INFO).setDescription(description).setTitle(title),

  brand: (title = null, description = null) =>
    base(Colors.BRAND).setTitle(title).setDescription(description).setFooter({ text: FOOTER }),

  neutral: (title = null, description = null) =>
    base(Colors.NEUTRAL).setTitle(title).setDescription(description),
};

/** Truncate to a limit with an ellipsis, so a long reason never 400s a send. */
export function truncate(text, max = Limits.EMBED_FIELD_VALUE) {
  if (!text) return '';
  const str = String(text);
  return str.length <= max ? str : `${str.slice(0, max - 1)}…`;
}

/** A field value that is never empty — Discord rejects empty field values. */
export function field(name, value, inline = false) {
  return { name, value: truncate(value) || '—', inline };
}

/** `Player (1234567890)` — the form staff can actually copy an ID out of. */
export function userLabel(user) {
  if (!user) return 'Unknown user';
  const tag = user.tag ?? user.username ?? user.userTag ?? 'Unknown';
  const id = user.id ?? user.userId ?? '?';
  return `${tag} (\`${id}\`)`;
}

/** `#000152` — case and ticket numbers are always zero-padded to six. */
export function padNumber(n) {
  return String(n).padStart(6, '0');
}
