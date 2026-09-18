import mongoose from 'mongoose';

/**
 * Per-guild member profile — the bot's own view of a person.
 *
 * This is a *projection*, not a source of truth: counts are denormalised so a
 * moderator running /history gets one document read instead of an aggregation
 * over every case. The authoritative records stay in Punishment and Ticket.
 */
const userSchema = new mongoose.Schema(
  {
    discordId: { type: String, required: true, index: true },
    guildId: { type: String, required: true, index: true },

    username: { type: String, default: null }, // last seen tag, for transcripts
    displayName: { type: String, default: null },

    // The Roblox link used to live here. It moved to the `RobloxProfile`
    // collection, which is global rather than per-guild: a Roblox account
    // belongs to the person, not to their membership of one server.

    stats: {
      warns: { type: Number, default: 0 },
      timeouts: { type: Number, default: 0 },
      kicks: { type: Number, default: 0 },
      bans: { type: Number, default: 0 },
      ticketsOpened: { type: Number, default: 0 },
    },

    staff: {
      // Action counters moved to the `StaffActivity` collection, which breaks
      // them down per action type and powers the leaderboard.
      /** Last rank key seen, for display only — roles remain the source of truth. */
      lastKnownRank: { type: String, default: null },
    },

    flags: {
      /** Watchlist: every action by this user is mirrored to the staff feed. */
      watched: { type: Boolean, default: false },
      watchReason: { type: String, default: null },
      /** Blocked from opening tickets (abuse of the support system). */
      ticketBlocked: { type: Boolean, default: false },
      appealBlocked: { type: Boolean, default: false },
    },

    firstSeenAt: { type: Date, default: Date.now },
    lastSeenAt: { type: Date, default: Date.now },
  },
  { timestamps: true },
);

userSchema.index({ guildId: 1, discordId: 1 }, { unique: true });
userSchema.index({ guildId: 1, 'flags.watched': 1 });

/** Get-or-create in one round trip; every system funnels through this. */
userSchema.statics.ensure = function ensure(guildId, discordId, patch = {}) {
  return this.findOneAndUpdate(
    { guildId, discordId },
    { $set: { lastSeenAt: new Date(), ...patch }, $setOnInsert: { firstSeenAt: new Date() } },
    { new: true, upsert: true, setDefaultsOnInsert: true },
  );
};

export const User = mongoose.model('User', userSchema);
