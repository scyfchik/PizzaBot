import mongoose from 'mongoose';
import { TicketCategory, TicketStatus, TicketPriority } from '../../config/constants.js';

/**
 * A support ticket.
 *
 * The Discord channel is disposable; this document is the record. Everything a
 * staff member needs after the channel is gone — the modal answers, who claimed
 * it, internal notes, the transcript path — lives here.
 */

const noteSchema = new mongoose.Schema(
  {
    authorId: { type: String, required: true },
    authorTag: { type: String, default: null },
    content: { type: String, required: true },
    createdAt: { type: Date, default: Date.now },
  },
  { _id: true },
);

const ticketSchema = new mongoose.Schema(
  {
    ticketId: { type: Number, required: true }, // human-facing #000152
    guildId: { type: String, required: true, index: true },

    channelId: { type: String, default: null, index: true },
    /** Kept after the channel is deleted so links in logs still make sense. */
    channelName: { type: String, default: null },

    /**
     * The header message carrying the status embed and the Claim/Close buttons.
     * Stored so claim, unclaim and close can update it from anywhere — a
     * command, a timer — not only from a click on the message itself.
     */
    headerMessageId: { type: String, default: null },

    openerId: { type: String, required: true, index: true },
    openerTag: { type: String, default: null },

    category: { type: String, required: true, enum: Object.values(TicketCategory) },
    status: { type: String, default: TicketStatus.OPEN, enum: Object.values(TicketStatus) },
    priority: {
      type: String,
      default: TicketPriority.NORMAL,
      enum: Object.values(TicketPriority),
    },

    /**
     * Answers from the category's modal, stored as ordered key/value pairs so
     * adding a field to a form never requires a schema migration.
     */
    responses: {
      type: [
        {
          _id: false,
          key: { type: String, required: true },
          label: { type: String, required: true },
          value: { type: String, default: '' },
        },
      ],
      default: [],
    },

    /** Convenience mirror of the Roblox username answer, for cross-referencing. */
    robloxUsername: { type: String, default: null, index: true, sparse: true },

    claimedBy: { type: String, default: null, index: true },
    claimedByTag: { type: String, default: null },
    claimedAt: { type: Date, default: null },
    /** Every staff member who ever claimed it — handovers are visible. */
    handlers: { type: [String], default: [] },

    /** Extra users added to the channel with /ticket add. */
    participants: { type: [String], default: [] },

    notes: { type: [noteSchema], default: [] },

    closedBy: { type: String, default: null },
    closedByTag: { type: String, default: null },
    closedAt: { type: Date, default: null },
    closeReason: { type: String, default: null },
    /** open -> close duration in ms, denormalised for staff performance stats. */
    resolutionTimeMs: { type: Number, default: null },
    /** First staff reply latency — the metric that actually matters to players. */
    firstResponseMs: { type: Number, default: null },

    /**
     * Messages exchanged before closing. Promoted out of `transcript` because
     * it stays meaningful even when transcripts are disabled, and staff stats
     * read it without caring how the transcript was stored.
     */
    messageCount: { type: Number, default: 0 },

    transcript: {
      generated: { type: Boolean, default: false },
      path: { type: String, default: null },
      messageCount: { type: Number, default: 0 },
      url: { type: String, default: null }, // link to the uploaded transcript
    },

    lastUserMessageAt: { type: Date, default: null },
    lastStaffMessageAt: { type: Date, default: null },
  },
  { timestamps: true },
);

ticketSchema.index({ guildId: 1, ticketId: 1 }, { unique: true });
ticketSchema.index({ guildId: 1, status: 1, createdAt: -1 });
ticketSchema.index({ guildId: 1, openerId: 1, status: 1 });
/** Powers the inactivity auto-close sweep. */
ticketSchema.index({ status: 1, lastUserMessageAt: 1 });

export const Ticket = mongoose.model('Ticket', ticketSchema);
