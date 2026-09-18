import mongoose from 'mongoose';
import { PunishmentType, CaseOrigin, AppealStatus } from '../../config/constants.js';

/**
 * The case log — one document per moderation action, ever.
 *
 * Immutable by convention: a case is never deleted, only voided (`active:
 * false` + a reason + who voided it). That is what makes `/history`
 * trustworthy in an appeal, and it means a compromised staff account cannot
 * quietly erase its own record.
 */

const noteSchema = new mongoose.Schema(
  {
    authorId: { type: String, required: true },
    authorTag: { type: String, default: null },
    content: { type: String, required: true, maxlength: 1000 },
    createdAt: { type: Date, default: Date.now },
  },
  { _id: true },
);

const punishmentSchema = new mongoose.Schema(
  {
    caseId: { type: Number, required: true }, // human-facing, per guild
    guildId: { type: String, required: true, index: true },

    type: { type: String, required: true, enum: Object.values(PunishmentType) },
    origin: { type: String, default: CaseOrigin.COMMAND, enum: Object.values(CaseOrigin) },

    /** Target. Tag is snapshotted — the account may leave or be deleted. */
    userId: { type: String, required: true, index: true },
    userTag: { type: String, default: null },

    /** Actor. `null` means the bot acted automatically. */
    moderatorId: { type: String, default: null, index: true },
    moderatorTag: { type: String, default: null },

    reason: { type: String, default: 'No reason provided' },

    /** Message links, screenshots, video URLs — whatever justifies the case. */
    evidence: { type: [String], default: [] },

    /** Staff-only discussion. Never shown to the punished user. */
    notes: { type: [noteSchema], default: [] },

    /** Appeal lifecycle. Linked to the ban-appeal ticket when one exists. */
    appeal: {
      status: { type: String, default: AppealStatus.ACTIVE, enum: Object.values(AppealStatus) },
      ticketId: { type: Number, default: null },
      reviewedBy: { type: String, default: null },
      reviewedAt: { type: Date, default: null },
      decisionReason: { type: String, default: null },
    },

    /** Timeouts and temp-bans; null for permanent actions. */
    duration: { type: Number, default: null }, // milliseconds
    expiresAt: { type: Date, default: null },

    active: { type: Boolean, default: true },
    voidedAt: { type: Date, default: null },
    voidedBy: { type: String, default: null },
    voidReason: { type: String, default: null },

    /** Did the user actually receive the DM notification? */
    notified: { type: Boolean, default: false },
    /** Message id of the moderation-log embed, so it can be updated in place. */
    logMessageId: { type: String, default: null },

    context: {
      channelId: { type: String, default: null },
      triggerRule: { type: String, default: null }, // e.g. "spam_mention"
      autoEscalated: { type: Boolean, default: false },
    },
  },
  { timestamps: true },
);

punishmentSchema.index({ guildId: 1, caseId: 1 }, { unique: true });
punishmentSchema.index({ guildId: 1, userId: 1, createdAt: -1 });
punishmentSchema.index({ guildId: 1, moderatorId: 1, createdAt: -1 });
punishmentSchema.index({ guildId: 1, 'appeal.status': 1 });
/** Drives the expiry sweeper for temp-bans and quarantines. */
punishmentSchema.index({ active: 1, expiresAt: 1 });

export const Punishment = mongoose.model('Punishment', punishmentSchema);
