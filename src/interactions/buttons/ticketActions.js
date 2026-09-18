import { MessageFlags } from 'discord.js';
import { Ticket } from '../../database/models/Ticket.js';
import {
  closeConfirmModal,
  claimAnnouncement,
  unclaimAnnouncement,
} from '../../systems/tickets/components.js';
import { generateTranscript } from '../../systems/tickets/transcript.js';
import { Permission } from '../../config/constants.js';
import { hasPermission } from '../../systems/staff/permissions.js';
import { embeds, padNumber } from '../../utils/embeds.js';
import { UserError, PermissionError } from '../../core/errors.js';

export const domain = 'ticket';
export const actions = ['claim', 'unclaim', 'close', 'transcript'];

/**
 * The buttons in every ticket channel.
 *
 * Discord gives an interaction **three seconds** to receive its first response.
 * Everything here therefore defers (or opens a modal) before touching the
 * database — a `findOne` on a cold connection is easily enough to blow that
 * budget, and the user sees "This application did not respond" even though the
 * action eventually succeeds.
 *
 * The rule: no `await` on anything slower than memory before the first
 * response. Validation happens after.
 *
 * The ticket number is baked into each custom ID, so these keep working across
 * restarts with no in-memory state.
 */
export async function execute(interaction, { client, staff, args }) {
  const ticketId = Number(args[0]);
  const action = interaction.customId.split(':')[2];

  switch (action) {
    case 'claim':
      return claim(interaction, client, staff, ticketId);
    case 'unclaim':
      return unclaim(interaction, client, staff, ticketId);
    case 'close':
      return close(interaction, ticketId);
    case 'transcript':
      return transcript(interaction, staff, ticketId);
  }
}

async function claim(interaction, client, staff, ticketId) {
  if (!hasPermission(staff, Permission.TICKET_CLAIM)) {
    throw new PermissionError('Only staff can claim tickets.');
  }

  // Deferred first, before any database work.
  await interaction.deferUpdate();

  const tickets = client.getSystem('tickets');
  const ticket = await tickets.claim(ticketId, interaction.guildId, interaction.member);

  // Rewrite the header so the embed status and the buttons match the database:
  // 🟢 Claimed by @staff, and Claim swapped for Unclaim.
  await tickets.refreshHeader(interaction.channel, ticket);

  await interaction.followUp({
    embeds: [claimAnnouncement(interaction.user)],
  });
}

async function unclaim(interaction, client, staff, ticketId) {
  if (!hasPermission(staff, Permission.TICKET_CLAIM)) {
    throw new PermissionError('Only staff can release tickets.');
  }

  await interaction.deferUpdate();

  const tickets = client.getSystem('tickets');
  const ticket = await tickets.unclaim(ticketId, interaction.guildId, interaction.member, {
    // Staff with ticket.manage can release someone else's ticket — for when
    // the holder has gone offline mid-shift.
    force: hasPermission(staff, Permission.TICKET_MANAGE),
  });

  await tickets.refreshHeader(interaction.channel, ticket);

  await interaction.followUp({
    embeds: [unclaimAnnouncement(interaction.user)],
  });
}

/**
 * Close: opens the confirmation modal.
 *
 * `showModal` must be the first response to an interaction — it cannot follow a
 * defer — so this path must not await anything slow beforehand. The permission
 * check uses the already-resolved staff object (in memory, no query), and the
 * ticket's existence is verified in the modal handler, which can defer.
 */
async function close(interaction, ticketId) {
  // No check here at all, deliberately. Establishing whether the clicker is the
  // opener needs the ticket record, and that read cannot happen before
  // `showModal`. It is also very nearly redundant: the channel's overwrites
  // only admit the opener and staff, so whoever clicked is already one of them.
  // The modal handler enforces it properly against the database.
  await interaction.showModal(closeConfirmModal(ticketId));
}

async function transcript(interaction, staff, ticketId) {
  if (!hasPermission(staff, Permission.TICKET_CLAIM)) {
    throw new PermissionError('Only staff can pull a transcript mid-ticket.');
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const ticket = await Ticket.findOne({ guildId: interaction.guildId, ticketId });
  if (!ticket) throw new UserError('That ticket no longer exists.');

  const result = await generateTranscript(interaction.channel, ticket);
  await interaction.editReply({
    embeds: [
      embeds.info(`Transcript of **#${padNumber(ticketId)}** — ${result.messageCount} messages.`),
    ],
    files: [result.attachment],
  });
}
