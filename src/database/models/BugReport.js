import mongoose from 'mongoose';
import { BugStatus, Platform } from '../../config/constants.js';

/**
 * A tracked bug report.
 *
 * Separate from the ticket that produced it, because the two have different
 * lifetimes: the support conversation ends when the channel is deleted, but the
 * bug stays open until a build fixes it. Linking by `ticketId` keeps the
 * conversation findable in the transcript afterwards.
 */
const bugReportSchema = new mongoose.Schema(
  {
    bugId: { type: Number, required: true }, // human-facing, per guild
    guildId: { type: String, required: true, index: true },

    /** The ticket this came from, when it came from one. */
    ticketId: { type: Number, default: null },

    reporterId: { type: String, required: true, index: true },
    reporterTag: { type: String, default: null },

    robloxUsername: { type: String, default: null, index: true, sparse: true },
    platform: { type: String, default: Platform.UNKNOWN, enum: Object.values(Platform) },
    /** Free text: players report "0.5.0", "latest", "today's update". */
    gameVersion: { type: String, default: null },

    description: { type: String, required: true, maxlength: 2000 },
    reproduction: { type: String, default: null, maxlength: 2000 },
    /** Links or attachment URLs collected in the ticket channel afterwards. */
    media: { type: [String], default: [] },

    status: { type: String, default: BugStatus.OPEN, enum: Object.values(BugStatus), index: true },
    severity: { type: String, default: 'normal', enum: ['low', 'normal', 'high', 'critical'] },

    assignedTester: { type: String, default: null, index: true },
    assignedTesterTag: { type: String, default: null },
    assignedAt: { type: Date, default: null },

    /** Set when the status moves to FIXED or REJECTED. */
    resolvedBy: { type: String, default: null },
    resolvedAt: { type: Date, default: null },
    resolutionNote: { type: String, default: null },
    /** Changelog version this shipped in, once one exists. */
    fixedInVersion: { type: String, default: null },

    /** Every status transition, so a rejected-then-reopened bug is legible. */
    history: {
      type: [
        {
          _id: false,
          from: String,
          to: String,
          byId: String,
          byTag: String,
          note: String,
          at: { type: Date, default: Date.now },
        },
      ],
      default: [],
    },

    /** Message id of the embed in the bug channel, so it can be kept in sync. */
    boardMessageId: { type: String, default: null },
  },
  { timestamps: true },
);

bugReportSchema.index({ guildId: 1, bugId: 1 }, { unique: true });
bugReportSchema.index({ guildId: 1, status: 1, createdAt: -1 });
bugReportSchema.index({ guildId: 1, assignedTester: 1, status: 1 });

export const BugReport = mongoose.model('BugReport', bugReportSchema);
