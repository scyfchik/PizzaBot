import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  EmbedBuilder,
} from 'discord.js';
import { buildId } from '../../utils/ids.js';
import {
  Colors,
  Emojis,
  TicketStatus,
  TicketDecision,
  TicketDecisionMeta,
} from '../../config/constants.js';
import { field, padNumber, userLabel, truncate } from '../../utils/embeds.js';
import { fullTimestamp } from '../../utils/time.js';
import { getCategory, enabledCategories } from './categories.js';

/**
 * Every visual piece of the ticket system.
 *
 * All custom IDs here are *static* (no ticket id baked into the panel), so a
 * panel posted months ago keeps working after a restart or a redeploy. The
 * ticket buttons carry the ticket number because they live in the ticket
 * channel and the number never changes.
 */

// ---------------------------------------------------------------- panel

export function panelEmbed(guild) {
  return new EmbedBuilder()
    .setColor(Colors.BRAND)
    .setTitle('🍕 Support')
    .setDescription(
      'Need help? Pick a category below and fill in the short form.\n\n' +
        'A private channel opens for you and a staff member will claim it. ' +
        'Please only open a ticket if you actually need one — duplicate tickets slow everyone down.',
    )
    .setThumbnail(guild.iconURL())
    .setFooter({ text: "Pizza Guy's Time · Support" });
}

export function panelComponents(config) {
  const menu = new StringSelectMenuBuilder()
    .setCustomId(buildId('ticket', 'open'))
    .setPlaceholder('Choose a category…')
    .addOptions(
      enabledCategories(config).map((category) => ({
        label: category.label,
        value: category.key,
        description: category.description,
        emoji: category.emoji,
      })),
    );

  return [new ActionRowBuilder().addComponents(menu)];
}

// ---------------------------------------------------------------- modal

export function categoryModal(category) {
  const modal = new ModalBuilder()
    .setCustomId(buildId('ticket', 'submit', category.key))
    .setTitle(`${category.label}`.slice(0, 45));

  for (const f of category.fields) {
    const input = new TextInputBuilder()
      .setCustomId(f.key)
      .setLabel(f.label.slice(0, 45))
      .setStyle(f.style)
      .setRequired(f.required !== false);

    if (f.maxLength) input.setMaxLength(f.maxLength);
    if (f.placeholder) input.setPlaceholder(f.placeholder.slice(0, 100));

    modal.addComponents(new ActionRowBuilder().addComponents(input));
  }

  return modal;
}

// ---------------------------------------------------------------- ticket channel

export function ticketHeaderEmbed(ticket, opener) {
  const category = getCategory(ticket.category);

  const embed = new EmbedBuilder()
    .setColor(ticket.claimedBy ? Colors.SUCCESS : Colors.BRAND)
    .setTitle(`🎫 Ticket #${padNumber(ticket.ticketId)}`)
    .addFields(
      field('👤 User', `<@${ticket.openerId}>\n\`${ticket.openerTag ?? ticket.openerId}\``, true),
      field('🎮 Roblox', robloxLine(ticket), true),
      field('📂 Category', `${category?.emoji ?? ''} ${category?.label ?? ticket.category}`, true),
      field('📊 Status', statusLine(ticket), true),
      field('🕒 Created', fullTimestamp(ticket.createdAt ?? new Date()), true),
    );

  const avatar = opener?.displayAvatarURL?.();
  if (avatar) embed.setThumbnail(avatar);

  // Separator before the free-text answers, so the metadata block reads as one
  // unit rather than blurring into whatever the player typed.
  if (ticket.responses?.length) {
    embed.addFields({ name: '​', value: '─────────────────────' });
  }

  for (const response of ticket.responses ?? []) {
    if (response.value) embed.addFields(field(`📝 ${response.label}`, response.value));
  }

  embed.setFooter({
    text: ticket.claimedBy
      ? `Handled by ${ticket.claimedByTag ?? 'staff'}`
      : 'A staff member will be with you shortly',
  });

  return embed;
}

/**
 * Status line. Mirrors the claim state exactly — this is the field staff scan
 * to see whether a ticket still needs someone, so it must never lag the
 * database.
 */
export function statusLine(ticket) {
  if (ticket.status === TicketStatus.CLOSED) return '⚫ Closed';
  if (ticket.status === TicketStatus.CLOSING) return '⏳ Closing…';
  if (ticket.claimedBy) return `🟢 Claimed by <@${ticket.claimedBy}>`;
  return '🔴 Waiting for staff';
}

/**
 * The Roblox account, when we have one.
 *
 * Only the username is shown: it is free text typed by the player, and without
 * the Roblox API there is no ID to resolve it to. Printing an unverified ID
 * would imply a check that has not happened.
 */
function robloxLine(ticket) {
  if (!ticket.robloxUsername) return '*not provided*';
  return `\`${ticket.robloxUsername}\`\n*unverified*`;
}

/**
 * The button row.
 *
 * Claim and Unclaim occupy the same slot rather than sitting side by side, so
 * the row always shows the one action that makes sense right now.
 */
export function ticketControls(ticketId, { claimed = false, closed = false } = {}) {
  const claimToggle = claimed
    ? new ButtonBuilder()
        .setCustomId(buildId('ticket', 'unclaim', ticketId))
        .setLabel('Unclaim')
        .setEmoji('🔴')
        .setStyle(ButtonStyle.Secondary)
    : new ButtonBuilder()
        .setCustomId(buildId('ticket', 'claim', ticketId))
        .setLabel('Claim')
        .setEmoji('🟢')
        .setStyle(ButtonStyle.Success);

  const row = new ActionRowBuilder().addComponents(
    claimToggle.setDisabled(closed),

    new ButtonBuilder()
      .setCustomId(buildId('ticket', 'close', ticketId))
      .setLabel('Close')
      .setEmoji(Emojis.LOCK)
      .setStyle(ButtonStyle.Danger)
      .setDisabled(closed),

    new ButtonBuilder()
      .setCustomId(buildId('ticket', 'transcript', ticketId))
      .setLabel('Transcript')
      .setEmoji(Emojis.TRANSCRIPT)
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(closed),
  );

  return [row];
}

/**
 * Confirmation step — closing is destructive and easy to misclick.
 *
 * The outcome is a separate field rather than something to infer from the
 * reason text. "Closed" tells a future reader nothing about a ban appeal;
 * "Denied" tells them everything, and it is what the transcript header and
 * `/tickets list` show.
 *
 * Discord modals accept text inputs only — no select menus — so the outcome is
 * typed and parsed leniently.
 */
export function closeConfirmModal(ticketId) {
  return new ModalBuilder()
    .setCustomId(buildId('ticket', 'confirmclose', ticketId))
    .setTitle(`Close ticket #${padNumber(ticketId)}`)
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('outcome')
          .setLabel('Outcome')
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
          .setMaxLength(20)
          .setPlaceholder('accepted / denied / resolved / no action — defaults to resolved'),
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('reason')
          .setLabel('Resolution / reason for closing')
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true)
          .setMaxLength(500)
          .setPlaceholder('What was the outcome? This is saved to the ticket record.'),
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('summary')
          .setLabel('One-line summary (optional)')
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
          .setMaxLength(120)
          .setPlaceholder('e.g. Spam punishment appeal'),
      ),
    );
}

/**
 * Map typed text onto a decision.
 * Lenient on purpose: staff type "accept", "Accepted", "approved" and mean the
 * same thing, and rejecting the close over a typo would be absurd.
 */
export function parseDecision(input) {
  const value = String(input ?? '').trim().toLowerCase();
  if (!value) return TicketDecision.RESOLVED;
  if (/^acc?ept|approv|grant|unban/.test(value)) return TicketDecision.ACCEPTED;
  if (/^den|reject|decline|refus/.test(value)) return TicketDecision.DENIED;
  if (/^no.?action|ignor|invalid|dupl/.test(value)) return TicketDecision.NO_ACTION;
  if (/^pend/.test(value)) return TicketDecision.PENDING;
  return TicketDecision.RESOLVED;
}

// ---------------------------------------------------------------- logs

export function ticketOpenedLog(ticket) {
  const category = getCategory(ticket.category);
  return new EmbedBuilder()
    .setColor(Colors.SUCCESS)
    .setAuthor({ name: `Ticket #${padNumber(ticket.ticketId)} opened` })
    .addFields(
      field('Category', `${category?.emoji ?? ''} ${category?.label}`, true),
      field('Opened by', `<@${ticket.openerId}> (\`${ticket.openerId}\`)`, true),
      field('Channel', `<#${ticket.channelId}>`, true),
    )
    .setTimestamp();
}

export function ticketClaimedLog(ticket, staffUser) {
  return new EmbedBuilder()
    .setColor(Colors.INFO)
    .setAuthor({ name: `Ticket #${padNumber(ticket.ticketId)} claimed` })
    .addFields(
      field('Claimed by', userLabel(staffUser), true),
      field('Opened by', `<@${ticket.openerId}>`, true),
      field('Channel', ticket.channelId ? `<#${ticket.channelId}>` : '—', true),
    )
    .setTimestamp();
}

export function ticketUnclaimedLog(ticket, staffUser) {
  return new EmbedBuilder()
    .setColor(Colors.WARNING)
    .setAuthor({ name: `Ticket #${padNumber(ticket.ticketId)} released` })
    .addFields(
      field('Released by', userLabel(staffUser), true),
      field('Opened by', `<@${ticket.openerId}>`, true),
      field('Channel', ticket.channelId ? `<#${ticket.channelId}>` : '—', true),
    )
    .setFooter({ text: 'Back in the queue — needs a new handler' })
    .setTimestamp();
}

/** Posted in the ticket channel itself when a staff member takes it. */
export function claimAnnouncement(staffUser) {
  return new EmbedBuilder()
    .setColor(Colors.SUCCESS)
    .setDescription(
      `${Emojis.CLAIM} Staff member <@${staffUser.id}> is now handling this ticket.`,
    )
    .setTimestamp();
}

/** Posted when a staff member releases a ticket back to the queue. */
export function unclaimAnnouncement(staffUser) {
  return new EmbedBuilder()
    .setColor(Colors.WARNING)
    .setDescription(
      `🔴 <@${staffUser.id}> released this ticket. It is waiting for a staff member again.`,
    )
    .setTimestamp();
}

export function ticketClosedLog(ticket, viewerUrl = null) {
  const category = getCategory(ticket.category);
  const embed = new EmbedBuilder()
    .setColor(Colors.NEUTRAL)
    .setAuthor({ name: `Ticket #${padNumber(ticket.ticketId)} closed` })
    .addFields(
      field('Category', `${category?.emoji ?? ''} ${category?.label}`, true),
      field('Opened by', `<@${ticket.openerId}>`, true),
      field('Handled by', ticket.claimedBy ? `<@${ticket.claimedBy}>` : 'Unclaimed', true),
      field('Closed by', `<@${ticket.closedBy}>`, true),
      field('Reason', truncate(ticket.closeReason, 900)),
    )
    .setTimestamp();

  if (ticket.firstResponseMs != null) {
    embed.addFields(field('First response', humanMs(ticket.firstResponseMs), true));
  }
  if (ticket.resolutionTimeMs != null) {
    embed.addFields(field('Open for', humanMs(ticket.resolutionTimeMs), true));
  }

  // The link carries the access token, so it goes only here — the ticket log,
  // which is staff-only — and to the opener's DMs. Never into a public channel.
  if (viewerUrl) {
    embed.addFields(
      field(
        `${Emojis.TRANSCRIPT} Transcript`,
        `[Open the web transcript](${viewerUrl})\n` +
          '*Private link — anyone who has it can read this ticket.*',
      ),
    );
  }

  return embed;
}

function humanMs(ms) {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

export function statusLabel(status) {
  return (
    {
      [TicketStatus.OPEN]: '🟢 Open',
      [TicketStatus.CLAIMED]: '🔵 Claimed',
      [TicketStatus.CLOSED]: '⚫ Closed',
    }[status] ?? status
  );
}
