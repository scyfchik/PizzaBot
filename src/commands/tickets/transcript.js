import { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } from 'discord.js';
import { Transcript, generateToken, hashToken } from '../../database/models/Transcript.js';
import { Permission, Emojis } from '../../config/constants.js';
import { hasPermission } from '../../systems/staff/permissions.js';
import { transcriptButtons } from '../../systems/tickets/components.js';
import { embeds, field, padNumber } from '../../utils/embeds.js';
import { fullTimestamp } from '../../utils/time.js';
import { UserError, PermissionError } from '../../core/errors.js';

/**
 * Transcript link management.
 *
 * The plaintext token exists only in the link posted at close time. It is not
 * stored, so there is nothing to "look up" — `link` therefore **rotates** the
 * token rather than revealing the old one. That is a deliberate consequence of
 * storing only the hash: a lost link is regenerated, never recovered, and the
 * old URL stops working the moment a new one is issued.
 */
export const data = new SlashCommandBuilder()
  .setName('transcript')
  .setDescription('Manage ticket transcript links')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
  .addSubcommand((sub) =>
    sub
      .setName('link')
      .setDescription('Issue a fresh private link for a ticket (invalidates the old one)')
      .addIntegerOption((o) =>
        o.setName('ticket').setDescription('Ticket number').setRequired(true).setMinValue(1),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('revoke')
      .setDescription('Kill a transcript link immediately')
      .addIntegerOption((o) =>
        o.setName('ticket').setDescription('Ticket number').setRequired(true).setMinValue(1),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('info')
      .setDescription('Show a transcript’s status without issuing a link')
      .addIntegerOption((o) =>
        o.setName('ticket').setDescription('Ticket number').setRequired(true).setMinValue(1),
      ),
  );

export const meta = {
  permission: Permission.TICKET_CLAIM,
  cooldown: 5,
};

export async function execute(interaction, { client, staff }) {
  // Always ephemeral. A transcript link posted into a channel is a transcript
  // link everyone in that channel now has.
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const sub = interaction.options.getSubcommand();
  const ticketId = interaction.options.getInteger('ticket');

  const transcript = await Transcript.findOne({ guildId: interaction.guildId, ticketId });
  if (!transcript) {
    throw new UserError(
      `No web transcript stored for ticket #${padNumber(ticketId)}. ` +
        'It may predate the web viewer, or web transcripts may be disabled — ' +
        'the HTML file is still attached to the ticket log entry.',
    );
  }

  if (sub === 'info') return info(interaction, transcript);
  if (sub === 'revoke') return revoke(interaction, transcript, staff);
  return link(interaction, client, transcript, staff);
}

async function link(interaction, client, transcript, staff) {
  if (!hasPermission(staff, Permission.TICKET_MANAGE)) {
    throw new PermissionError('Issuing a new transcript link needs `ticket.manage`.');
  }

  const web = client.getSystem('web');
  if (!web?.enabled) {
    throw new UserError('The transcript web viewer is not enabled on this deployment.');
  }

  const token = generateToken();
  transcript.tokenHash = hashToken(token);
  transcript.revoked = false;
  await transcript.save();

  await interaction.editReply({
    embeds: [
      embeds
        .success(`New private link for ticket **#${padNumber(transcript.ticketId)}**.`)
        .addFields(
          field(
            `${Emojis.ALERT} Handle with care`,
            'Anyone with this URL can read the whole ticket. Send it directly to the person who needs it — never into a public channel.\n' +
              'The previous link for this ticket has stopped working.',
          ),
        ),
    ],
    components: transcriptButtons(web.buildUrl(token), web.buildDownloadUrl(token)),
  });
}

async function revoke(interaction, transcript, staff) {
  if (!hasPermission(staff, Permission.TICKET_MANAGE)) {
    throw new PermissionError('Revoking a transcript link needs `ticket.manage`.');
  }
  if (transcript.revoked) throw new UserError('That link is already revoked.');

  transcript.revoked = true;
  await transcript.save();

  await interaction.editReply({
    embeds: [
      embeds.success(
        `Transcript link for ticket **#${padNumber(transcript.ticketId)}** revoked. ` +
          'The record is kept; only the link stops working.',
      ),
    ],
  });
}

async function info(interaction, transcript) {
  await interaction.editReply({
    embeds: [
      embeds
        .brand(`${Emojis.TRANSCRIPT} Transcript #${padNumber(transcript.ticketId)}`)
        .addFields(
          field(
            'Status',
            transcript.revoked
              ? '⛔ Revoked'
              : transcript.expiresAt && transcript.expiresAt <= new Date()
                ? '⌛ Expired'
                : '🟢 Active',
            true,
          ),
          field('Messages', `${transcript.messageCount}${transcript.truncated ? ' (truncated)' : ''}`, true),
          field('Views', String(transcript.viewCount), true),
          field('Stored', fullTimestamp(transcript.createdAt), true),
          field(
            'Expires',
            transcript.expiresAt ? fullTimestamp(transcript.expiresAt) : 'Never',
            true,
          ),
          field(
            'Last viewed',
            transcript.lastViewedAt ? fullTimestamp(transcript.lastViewedAt) : 'Never',
            true,
          ),
        )
        .setFooter({
          text: 'Links are stored hashed — use /transcript link to issue a new one.',
        }),
    ],
  });
}
