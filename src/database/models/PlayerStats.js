import mongoose from 'mongoose';

/**
 * In-game statistics for one Roblox player.
 *
 * **Every field here is reported by the game, not fetched from Roblox.** There
 * is no public API that exposes a player's playtime, level or progression in
 * your experience — that data only exists on your servers, so the game sends it
 * to the ingest endpoint and this is where it lands.
 *
 * Keyed by `robloxId`, not `discordId`: most players never link a Discord
 * account, and their stats still matter. The link is resolved through
 * `RobloxProfile` when one exists.
 *
 * Counters are incremented, never recalculated, so the ingest path stays a
 * single `$inc` per event rather than a read-modify-write.
 */
const playerStatsSchema = new mongoose.Schema(
  {
    guildId: { type: String, required: true, index: true },
    robloxId: { type: String, required: true, index: true },
    robloxUsername: { type: String, default: null },
    displayName: { type: String, default: null },

    /** Account creation date, from the Roblox API when it lands. */
    accountCreated: { type: Date, default: null },

    progression: {
      level: { type: Number, default: 0 },
      xp: { type: Number, default: 0 },
      /** Free-form, because every game measures progress differently. */
      custom: { type: mongoose.Schema.Types.Mixed, default: {} },
    },

    activity: {
      playtimeMinutes: { type: Number, default: 0 },
      sessions: { type: Number, default: 0 },
      deaths: { type: Number, default: 0 },
      firstSeenAt: { type: Date, default: null },
      lastSeenAt: { type: Date, default: null, index: true },
      /** Set on join, cleared on leave — lets /game stats count who is on now. */
      currentServerId: { type: String, default: null },
    },

    economy: {
      /** Robux spent in this experience, summed from completed purchases. */
      robuxSpent: { type: Number, default: 0 },
      purchaseCount: { type: Number, default: 0 },
      failedPurchaseCount: { type: Number, default: 0 },
      refundedCount: { type: Number, default: 0 },
      lastPurchaseAt: { type: Date, default: null },
    },

    flags: {
      /** Reported by the game — an in-game ban is not a Discord ban. */
      bannedInGame: { type: Boolean, default: false },
      banReason: { type: String, default: null },
      isTester: { type: Boolean, default: false },
    },
  },
  { timestamps: true },
);

playerStatsSchema.index({ guildId: 1, robloxId: 1 }, { unique: true });
/** Leaderboards and "who is online" both read these. */
playerStatsSchema.index({ guildId: 1, 'economy.robuxSpent': -1 });
playerStatsSchema.index({ guildId: 1, 'activity.playtimeMinutes': -1 });
playerStatsSchema.index({ guildId: 1, 'activity.currentServerId': 1 });

export const PlayerStats = mongoose.model('PlayerStats', playerStatsSchema);
