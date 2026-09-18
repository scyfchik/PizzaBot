import { Events } from 'discord.js';
import { Ticket } from '../../database/models/Ticket.js';
import { TicketStatus, Permission } from '../../config/constants.js';
import { hasPermission, resolveStaff } from '../../systems/staff/permissions.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('message');

export const name = Events.MessageCreate;

/**
 * The hot path.
 *
 * This runs on every message in the server, so it must stay cheap. Anti-spam
 * reads cached config and in-memory windows; the ticket bookkeeping only does
 * a database write inside an actual ticket channel.
 */
export async function execute(client, message) {
  if (!message.guild || message.author.bot) return;

  await client.getSystem('antiSpam').handleMessage(message).catch((err) => {
    log.error({ err, message: message.id }, 'Anti-spam check failed');
  });

  await trackTicketActivity(message).catch((err) => {
    log.error({ err, channel: message.channelId }, 'Ticket activity tracking failed');
  });
}

/**
 * Record response times on ticket channels.
 *
 * `firstResponseMs` is the number that tells you whether support is actually
 * working — how long a player waited before a human said anything. It can only
 * be captured here, at the moment the first staff message arrives.
 */
async function trackTicketActivity(message) {
  const ticket = await Ticket.findOne({
    channelId: message.channelId,
    status: { $ne: TicketStatus.CLOSED },
  });
  if (!ticket) return;

  if (message.author.id === ticket.openerId) {
    ticket.lastUserMessageAt = new Date();
    await ticket.save();
    return;
  }

  if (!message.member) return; // uncached member — treat as non-staff
  const staff = await resolveStaff(message.member);
  if (!staff.isStaff || !hasPermission(staff, Permission.TICKET_CLAIM)) return;

  ticket.lastStaffMessageAt = new Date();
  if (ticket.firstResponseMs == null) {
    ticket.firstResponseMs = Date.now() - new Date(ticket.createdAt).getTime();
  }
  await ticket.save();
}
