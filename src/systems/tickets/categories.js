import { TextInputStyle } from 'discord.js';
import { TicketCategory, TicketPriority, Emojis, Permission } from '../../config/constants.js';

/**
 * Ticket categories, as data.
 *
 * Each entry declares its label, the questions asked in its modal, and how the
 * resulting ticket is routed. Adding a seventh category is one object in this
 * array — no changes to the manager, the panel, or any handler.
 *
 * Discord allows a maximum of 5 inputs per modal, so `fields` is capped at 5.
 */

/** @type {Array<object>} */
export const TICKET_CATEGORIES = [
  {
    key: TicketCategory.BUG_REPORT,
    label: 'Bug Report',
    emoji: Emojis.BUG,
    description: 'Something in the game is broken',
    channelPrefix: 'bug',
    priority: TicketPriority.NORMAL,
    /** Also files a tracked BugReport — see systems/qa/BugReportService.js. */
    createsBugReport: true,
    /**
     * Exactly five fields, because Discord allows no more in a modal.
     *
     * The screenshot field was dropped on purpose: modals cannot accept file
     * uploads, so it could only ever hold a pasted URL, and asking someone to
     * upload the clip into the ticket channel a second later is both easier and
     * produces a better artefact. The channel prompt covers it.
     */
    fields: [
      {
        key: 'roblox_username',
        label: 'Your Roblox username',
        style: TextInputStyle.Short,
        required: true,
        maxLength: 32,
        placeholder: 'e.g. PizzaEnjoyer123',
      },
      {
        key: 'platform',
        label: 'What are you playing on?',
        style: TextInputStyle.Short,
        required: true,
        maxLength: 32,
        placeholder: 'PC / Mobile / Tablet / Console / VR',
      },
      {
        key: 'game_version',
        label: 'Game version (if you know it)',
        style: TextInputStyle.Short,
        required: false,
        maxLength: 32,
        placeholder: 'e.g. 0.5.0 — leave blank if unsure',
      },
      {
        key: 'description',
        label: 'What went wrong?',
        style: TextInputStyle.Paragraph,
        required: true,
        maxLength: 1000,
      },
      {
        key: 'reproduction',
        label: 'How do we reproduce it?',
        style: TextInputStyle.Paragraph,
        required: true,
        maxLength: 1000,
        placeholder: '1. Join the lobby\n2. Click the oven\n3. ...',
      },
    ],
  },

  {
    key: TicketCategory.PLAYER_REPORT,
    label: 'Player Report',
    emoji: Emojis.REPORT,
    description: 'Report a player breaking the rules',
    channelPrefix: 'report',
    priority: TicketPriority.HIGH,
    /** Reports name a third party — the channel is staff-visible only on open. */
    fields: [
      {
        key: 'reported_player',
        label: 'Who are you reporting?',
        style: TextInputStyle.Short,
        required: true,
        maxLength: 64,
        placeholder: 'Roblox username, or Discord tag',
      },
      {
        key: 'reason',
        label: 'What did they do?',
        style: TextInputStyle.Paragraph,
        required: true,
        maxLength: 1000,
      },
      {
        key: 'evidence',
        label: 'Evidence',
        style: TextInputStyle.Paragraph,
        required: true,
        maxLength: 1000,
        placeholder: 'Screenshots, clips, message links. Reports without evidence are hard to act on.',
      },
    ],
  },

  {
    key: TicketCategory.BAN_APPEAL,
    label: 'Ban Appeal',
    emoji: Emojis.APPEAL,
    description: 'Appeal a punishment',
    channelPrefix: 'appeal',
    priority: TicketPriority.NORMAL,
    /** The manager attaches the opener's case history to appeals automatically. */
    attachHistory: true,
    fields: [
      {
        key: 'roblox_username',
        label: 'Your Roblox username',
        style: TextInputStyle.Short,
        required: true,
        maxLength: 32,
      },
      {
        key: 'discord_username',
        label: 'Discord username the punishment is on',
        style: TextInputStyle.Short,
        required: true,
        maxLength: 64,
        placeholder: 'Leave as your own if it was this account',
      },
      {
        key: 'punishment_reason',
        label: 'What were you punished for?',
        style: TextInputStyle.Paragraph,
        required: true,
        maxLength: 500,
      },
      {
        key: 'appeal',
        label: 'Why should it be reversed?',
        style: TextInputStyle.Paragraph,
        required: true,
        maxLength: 1000,
      },
      {
        key: 'evidence',
        label: 'Evidence (optional)',
        style: TextInputStyle.Paragraph,
        required: false,
        maxLength: 500,
      },
    ],
  },

  {
    key: TicketCategory.PURCHASE_ISSUE,
    label: 'Purchase Issue',
    emoji: Emojis.PURCHASE,
    description: 'Robux purchase or gamepass problem',
    channelPrefix: 'purchase',
    priority: TicketPriority.HIGH,
    fields: [
      {
        key: 'roblox_username',
        label: 'Your Roblox username',
        style: TextInputStyle.Short,
        required: true,
        maxLength: 32,
      },
      {
        key: 'purchase_info',
        label: 'What did you buy, and when?',
        style: TextInputStyle.Paragraph,
        required: true,
        maxLength: 700,
        placeholder: 'Item name, price, approximate date and time',
      },
      {
        key: 'problem',
        label: "What's the problem?",
        style: TextInputStyle.Paragraph,
        required: true,
        maxLength: 1000,
        placeholder: 'e.g. Robux were taken but the gamepass never applied',
      },
    ],
  },

  {
    key: TicketCategory.STAFF_APPLICATION,
    label: 'Staff Application',
    emoji: Emojis.APPLICATION,
    description: 'Apply to join the team',
    channelPrefix: 'apply',
    priority: TicketPriority.LOW,
    /** Applications contain personal info — only these nodes may read them. */
    requiredPermission: Permission.TICKET_APPLICATIONS,
    fields: [
      {
        key: 'roblox_username',
        label: 'Your Roblox username',
        style: TextInputStyle.Short,
        required: true,
        maxLength: 32,
      },
      {
        key: 'position',
        label: 'Which position?',
        style: TextInputStyle.Short,
        required: true,
        maxLength: 64,
        placeholder: 'Moderator / Developer / QA Tester / Community Manager',
      },
      {
        key: 'availability',
        label: 'Age range, timezone and hours per week',
        style: TextInputStyle.Short,
        required: true,
        maxLength: 100,
        placeholder: 'e.g. 18-21, GMT+3, ~15h/week',
      },
      {
        key: 'experience',
        label: 'Relevant experience',
        style: TextInputStyle.Paragraph,
        required: true,
        maxLength: 1000,
      },
      {
        key: 'motivation',
        label: 'Why you?',
        style: TextInputStyle.Paragraph,
        required: true,
        maxLength: 1000,
      },
    ],
  },

  {
    key: TicketCategory.GENERAL,
    label: 'General Support',
    emoji: Emojis.GENERAL,
    description: 'Anything else',
    channelPrefix: 'help',
    priority: TicketPriority.NORMAL,
    fields: [
      {
        key: 'subject',
        label: 'Subject',
        style: TextInputStyle.Short,
        required: true,
        maxLength: 100,
      },
      {
        key: 'description',
        label: 'How can we help?',
        style: TextInputStyle.Paragraph,
        required: true,
        maxLength: 1000,
      },
    ],
  },
];

const BY_KEY = new Map(TICKET_CATEGORIES.map((c) => [c.key, c]));

export function getCategory(key) {
  return BY_KEY.get(key) ?? null;
}

/** Categories a given guild currently offers. */
export function enabledCategories(config) {
  const disabled = new Set(config.tickets?.disabledCategories ?? []);
  return TICKET_CATEGORIES.filter((c) => !disabled.has(c.key));
}
