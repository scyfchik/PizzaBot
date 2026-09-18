import mongoose from 'mongoose';
import { PurchaseStatus } from '../../config/constants.js';

/**
 * A single in-game transaction, reported by the game.
 *
 * Exists so purchase-support tickets can be answered with facts instead of
 * "we'll look into it": the ticket viewer pulls the player's recent purchases
 * automatically, including the failed ones, which is usually the whole answer.
 *
 * `transactionId` is Roblox's `ProcessReceipt` id and is **unique** — the same
 * receipt must never be recorded twice. Roblox retries `ProcessReceipt` until
 * the game returns `PurchaseGranted`, so duplicate delivery is normal and the
 * unique index is what makes ingest idempotent.
 */
const purchaseSchema = new mongoose.Schema(
  {
    guildId: { type: String, required: true, index: true },

    /** Roblox's PurchaseId. The idempotency key for the whole pipeline. */
    transactionId: { type: String, required: true },

    robloxId: { type: String, required: true, index: true },
    robloxUsername: { type: String, default: null },

    productId: { type: String, default: null },
    productName: { type: String, default: null },
    /** developer_product | gamepass | subscription */
    productType: { type: String, default: 'developer_product' },

    robuxAmount: { type: Number, default: 0 },

    status: {
      type: String,
      default: PurchaseStatus.COMPLETED,
      enum: Object.values(PurchaseStatus),
      index: true,
    },
    /** Why a failed purchase failed, as reported by the game. */
    failureReason: { type: String, default: null },

    /** When it happened in-game, which may lag when it reached us. */
    purchasedAt: { type: Date, default: Date.now },

    /** Set when staff resolve a purchase-support ticket about it. */
    supportTicketId: { type: Number, default: null },
    refundedBy: { type: String, default: null },
    refundedAt: { type: Date, default: null },
    refundNote: { type: String, default: null },
  },
  { timestamps: true },
);

/** Idempotency: the same receipt can arrive many times and land once. */
purchaseSchema.index({ guildId: 1, transactionId: 1 }, { unique: true });
purchaseSchema.index({ guildId: 1, robloxId: 1, purchasedAt: -1 });
purchaseSchema.index({ guildId: 1, status: 1, purchasedAt: -1 });

export const Purchase = mongoose.model('Purchase', purchaseSchema);
