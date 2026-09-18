import { EmbedBuilder } from 'discord.js';
import { Colors, PunishmentType, AppealStatus } from '../../config/constants.js';
import { field, padNumber, truncate } from '../../utils/embeds.js';
import { fullTimestamp, formatDuration } from '../../utils/time.js';

/** Colour and verb per punishment type — one table instead of scattered ifs. */
const TYPE_META = {
  [PunishmentType.WARN]: { color: Colors.WARNING, verb: 'Warned', past: 'warned' },
  [PunishmentType.TIMEOUT]: { color: Colors.WARNING, verb: 'Timed out', past: 'timed out' },
  [PunishmentType.UNTIMEOUT]: { color: Colors.SUCCESS, verb: 'Timeout removed', past: 'un-timed out' },
  [PunishmentType.KICK]: { color: Colors.DANGER, verb: 'Kicked', past: 'kicked' },
  [PunishmentType.BAN]: { color: Colors.DANGER, verb: 'Banned', past: 'banned' },
  [PunishmentType.UNBAN]: { color: Colors.SUCCESS, verb: 'Unbanned', past: 'unbanned' },
  [PunishmentType.QUARANTINE]: { color: Colors.CRITICAL, verb: 'Quarantined', past: 'quarantined' },
  [PunishmentType.UNQUARANTINE]: { color: Colors.SUCCESS, verb: 'Released', past: 'released' },
};

export function typeMeta(type) {
  return TYPE_META[type] ?? { color: Colors.NEUTRAL, verb: type, past: type };
}

const APPEAL_LABEL = {
  [AppealStatus.ACTIVE]: '—',
  [AppealStatus.APPEALED]: '📨 Appealed',
  [AppealStatus.REVIEWED]: '👀 Under review',
  [AppealStatus.ACCEPTED]: '✅ Appeal accepted',
  [AppealStatus.REJECTED]: '❌ Appeal rejected',
};

export function appealLabel(status) {
  return APPEAL_LABEL[status] ?? status;
}

/** The embed posted to the moderation log for every case. */
export function caseLogEmbed(punishment) {
  const meta = typeMeta(punishment.type);

  const embed = new EmbedBuilder()
    .setColor(punishment.active ? meta.color : Colors.NEUTRAL)
    .setAuthor({ name: `${meta.verb} · Case #${padNumber(punishment.caseId)}` })
    .addFields(
      field('User', `<@${punishment.userId}>\n\`${punishment.userId}\``, true),
      field(
        'Moderator',
        punishment.moderatorId ? `<@${punishment.moderatorId}>` : `Automatic (${punishment.origin})`,
        true,
      ),
      field('Reason', truncate(punishment.reason, 900)),
    )
    .setTimestamp(punishment.createdAt ?? new Date());

  if (punishment.duration) {
    embed.addFields(
      field('Duration', formatDuration(punishment.duration), true),
      field('Expires', punishment.expiresAt ? fullTimestamp(punishment.expiresAt) : '—', true),
    );
  }

  if (punishment.evidence?.length) {
    embed.addFields(field('Evidence', punishment.evidence.join('\n')));
  }

  if (punishment.appeal?.status && punishment.appeal.status !== AppealStatus.ACTIVE) {
    embed.addFields(field('Appeal', appealLabel(punishment.appeal.status), true));
  }

  if (!punishment.active) {
    embed.addFields(
      field(
        'Voided',
        `By <@${punishment.voidedBy}>${punishment.voidReason ? ` — ${punishment.voidReason}` : ''}`,
      ),
    );
    embed.setFooter({ text: 'This case has been voided' });
  }

  if (punishment.context?.triggerRule) {
    embed.setFooter({ text: `Triggered by ${punishment.context.triggerRule}` });
  }

  return embed;
}

// There is no "you were punished" DM here any more. Pizza Bot does not issue
// punishments, so notifying the user is the job of whichever bot did — sending
// our own notice would mean the player gets two.

/** One line per case, for `/player history`. */
export function caseLine(punishment) {
  const meta = typeMeta(punishment.type);
  const strike = punishment.active ? '' : '~~';
  const duration = punishment.duration ? ` (${formatDuration(punishment.duration)})` : '';
  const appeal =
    punishment.appeal?.status && punishment.appeal.status !== AppealStatus.ACTIVE
      ? ` · ${appealLabel(punishment.appeal.status)}`
      : '';

  return (
    `${strike}\`#${padNumber(punishment.caseId)}\` **${meta.verb}**${duration}${strike} · ` +
    `${fullTimestamp(punishment.createdAt).split(' (')[1]?.replace(')', '') ?? ''}\n` +
    `└ ${truncate(punishment.reason, 120)}${appeal}`
  );
}
