import { Ticket } from '../../database/models/Ticket.js';
import { TicketStatus, Permission } from '../../config/constants.js';
import { hasPermission } from '../../systems/staff/permissions.js';
import { embeds, padNumber } from '../../utils/embeds.js';
import { UserError, PermissionError } from '../../core/errors.js';

export const domain = 'ticket';
export const actions = ['confirmclose'];

/**
 * Close confirmation submitted.
 *
 * The real validation lives here rather than on the button: opening the modal
 * has to happen within Discord's three-second window and `showModal` cannot
 * follow a defer, so the button does only in-memory checks and this handler —
 * which can defer — does the database work.
 *
 * Replies in the channel *before* the manager deletes it, because five seconds
 * later there is nothing left to reply to.
 */
export async function execute(interaction, { client, staff, args }) {
  const ticketId = Number(args[0]);
  const reason = interaction.fields.getTextInputValue('reason').trim();

  await interaction.deferReply();

  const ticket = await Ticket.findOne({ guildId: interaction.guildId, ticketId });
  if (!ticket) throw new UserError('That ticket no longer exists.');
  if (ticket.status === TicketStatus.CLOSED) throw new UserError('This ticket is already closed.');

  // Staff with the node may close anything; the opener may close their own.
  const allowed =
    hasPermission(staff, Permission.TICKET_CLOSE) || ticket.openerId === interaction.user.id;
  if (!allowed) throw new PermissionError('Only staff or the ticket opener can close this.');

  await interaction.editReply({
    embeds: [
      embeds
        .warning(`Closing ticket **#${padNumber(ticketId)}** — saving the transcript…`)
        .setFooter({ text: `Closed by ${interaction.user.tag}` }),
    ],
  });

  const tickets = client.getSystem('tickets');
  await tickets.close(ticketId, interaction.guildId, interaction.user, reason);
}
