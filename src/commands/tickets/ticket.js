import { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } from 'discord.js';
import { Ticket } from '../../database/models/Ticket.js';
import { Permission, TicketPriority, TicketStatus } from '../../config/constants.js';
import { hasPermission, resolveStaff } from '../../systems/staff/permissions.js';
import { statusLabel } from '../../systems/tickets/components.js';
import { embeds, padNumber, field } from '../../utils/embeds.js';
import { fullTimestamp } from '../../utils/time.js';
import { UserError, PermissionError } from '../../core/errors.js';

/**
 * Staff-side ticket management.
 *
 * The everyday flow (open, claim, close) is buttons — these are the cases a
 * button cannot express: pulling in a second person, leaving an internal note,
 * bumping priority, or looking up a ticket from outside its channel.
 */
export const data = new SlashCommandBuilder()
  .setName('ticket')
  .setDescription('Manage a support ticket')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
  .addSubcommand((sub) =>
    sub
      .setName('add')
      .setDescription('Give someone access to this ticket')
      .addUserOption((o) => o.setName('member').setDescription('Who to add').setRequired(true)),
  )
  .addSubcommand((sub) =>
    sub
      .setName('note')
      .setDescription('Add an internal note (never shown to the ticket opener)')
      .addStringOption((o) =>
        o.setName('content').setDescription('The note').setRequired(true).setMaxLength(1000),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('priority')
      .setDescription('Change this ticket’s priority')
      .addStringOption((o) =>
        o
          .setName('level')
          .setDescription('New priority')
          .setRequired(true)
          .addChoices(
            { name: 'Low', value: TicketPriority.LOW },
            { name: 'Normal', value: TicketPriority.NORMAL },
            { name: 'High', value: TicketPriority.HIGH },
            { name: 'Urgent', value: TicketPriority.URGENT },
          ),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('transfer')
      .setDescription('Hand this ticket to another staff member')
      .addUserOption((o) => o.setName('member').setDescription('New handler').setRequired(true)),
  )
  .addSubcommand((sub) =>
    sub
      .setName('info')
      .setDescription('Look up a ticket by number')
      .addIntegerOption((o) =>
        o.setName('number').setDescription('Ticket number').setRequired(true).setMinValue(1),
      ),
  );

export const meta = {
  permission: Permission.TICKET_CLAIM,
  cooldown: 3,
};

export async function execute(interaction, { client, staff }) {
  const sub = interaction.options.getSubcommand();
  const tickets = client.getSystem('tickets');

  if (sub === 'info') return info(interaction);

  // Everything else acts on "the ticket this channel belongs to".
  const ticket = await tickets.findByChannel(interaction.channelId);
  if (!ticket) throw new UserError('Run this inside a ticket channel.');

  await interaction.deferReply({
    flags: sub === 'note' ? MessageFlags.Ephemeral : undefined,
  });

  if (sub === 'add') {
    const member = interaction.options.getMember('member');
    if (!member) throw new UserError('That member is not in the server.');
    await tickets.addParticipant(ticket.ticketId, interaction.guildId, member);
    return interaction.editReply({
      embeds: [embeds.success(`${member} was added to this ticket by ${interaction.user}.`)],
    });
  }

  if (sub === 'note') {
    const content = interaction.options.getString('content');
    await tickets.addNote(ticket.ticketId, interaction.guildId, interaction.user, content);
    return interaction.editReply({
      embeds: [embeds.success('Note saved to the ticket record.')],
    });
  }

  if (sub === 'priority') {
    if (!hasPermission(staff, Permission.TICKET_MANAGE)) {
      throw new PermissionError('You cannot change ticket priority.');
    }
    ticket.priority = interaction.options.getString('level');
    await ticket.save();
    return interaction.editReply({
      embeds: [embeds.success(`Priority set to **${ticket.priority}**.`)],
    });
  }

  if (sub === 'transfer') {
    const member = interaction.options.getMember('member');
    if (!member) throw new UserError('That member is not in the server.');
    if (!hasPermission(await resolveStaff(member), Permission.TICKET_CLAIM)) {
      throw new UserError(`${member} is not able to handle tickets.`);
    }
    await tickets.transfer(ticket.ticketId, interaction.guildId, member);
    return interaction.editReply({
      embeds: [embeds.success(`Ticket handed to ${member}.`)],
    });
  }
}

async function info(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const number = interaction.options.getInteger('number');
  const ticket = await Ticket.findOne({ guildId: interaction.guildId, ticketId: number });
  if (!ticket) throw new UserError(`No ticket #${padNumber(number)} on record.`);

  const embed = embeds
    .brand(`Ticket #${padNumber(ticket.ticketId)}`)
    .addFields(
      field('Status', statusLabel(ticket.status), true),
      field('Category', ticket.category, true),
      field('Priority', ticket.priority, true),
      field('Opened by', `<@${ticket.openerId}>`, true),
      field('Handled by', ticket.claimedBy ? `<@${ticket.claimedBy}>` : 'Unclaimed', true),
      field('Created', fullTimestamp(ticket.createdAt), true),
    );

  if (ticket.channelId && ticket.status !== TicketStatus.CLOSED) {
    embed.addFields(field('Channel', `<#${ticket.channelId}>`, true));
  }
  if (ticket.closeReason) embed.addFields(field('Close reason', ticket.closeReason));
  if (ticket.notes.length) {
    embed.addFields(
      field(
        `Internal notes (${ticket.notes.length})`,
        ticket.notes
          .slice(-3)
          .map((n) => `**${n.authorTag}**: ${n.content}`)
          .join('\n'),
      ),
    );
  }

  await interaction.editReply({ embeds: [embed] });
}
