import { Events } from 'discord.js';
import { Ticket } from '../../database/models/Ticket.js';
import { TicketStatus, Permission } from '../../config/constants.js';
import { hasPermission, resolveStaff } from '../../systems/staff/permissions.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('message');

export const name = Events.MessageCreate;

/**
 * Ticket response-time tracking, and nothing else.
 *
 * Pizza Bot does not read messages for moderation — no anti-spam, no content
 * filtering, no automod. Dyno/Carl-bot own that, and two bots deleting the same
 * message produces double punishments and arguments about which one acted.
 *
 * So the only work here is inside ticket channels, and even that is skipped in
 * one indexed query for every other message in the server.
 */
export async function execute(client, message) {
  if (!message.guild || message.author.bot) return;

  await trackTicketActivity(message).catch((err) => {
    log.error({ err, channel: message.channelId }, 'Ticket activity tracking failed');
  });
}

/**
 * Record response times on ticket channels.
 *
 * `firstResponseMs` — how long a player waited before a human said anything —
 * is the number that tells you whether support is working, and it can only be
 * captured here, at the moment the first staff message arrives.
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
