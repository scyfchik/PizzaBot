import mongoose from 'mongoose';

/**
 * Per-staff activity counters.
 *
 * Deliberately a counter document, not a query over the logs. `/staff
 * leaderboard` on a server with a year of history would otherwise mean an
 * aggregation across tens of thousands of Punishment and Ticket documents every
 * time someone runs it. Instead each action does one `$inc` at the moment it
 * happens, and the leaderboard is a single indexed `find().sort().limit()`.
 *
 * The trade-off is that these are derived numbers that can drift if a write
 * fails. That is acceptable: Punishment and Ticket remain the source of truth,
 * and `/history` and `/case` read those. Nothing disciplinary is ever decided
 * from this collection — it answers "who is carrying the load", not "what did
 * this person do".
 */

const counter = { type: Number, default: 0 };

const staffActivitySchema = new mongoose.Schema(
  {
    guildId: { type: String, required: true, index: true },
    userId: { type: String, required: true, index: true },
    /** Snapshotted for leaderboards — the account may leave. */
    username: { type: String, default: null },

    tickets: {
      claimed: counter,
      closed: counter,
      unclaimed: counter,
      /** Running total of first-response times, for a cheap mean. */
      responseTimeTotalMs: { type: Number, default: 0 },
      responseSamples: counter,
    },

    moderation: {
      warns: counter,
      timeouts: counter,
      kicks: counter,
      bans: counter,
      unbans: counter,
      clears: counter,
    },

    qa: {
      reportsHandled: counter,
      reportsClosed: counter,
      reportsFixed: counter,
    },

    totals: {
      /** Everything countable, kept denormalised so the leaderboard can sort. */
      actions: { type: Number, default: 0, index: true },
    },

    lastActivityAt: { type: Date, default: null },
    /** What they did last, for the activity panel. */
    lastAction: { type: String, default: null },
  },
  { timestamps: true },
);

staffActivitySchema.index({ guildId: 1, userId: 1 }, { unique: true });
/** Drives the leaderboard: one indexed read, already ordered. */
staffActivitySchema.index({ guildId: 1, 'totals.actions': -1 });

/** Mean first-response time in ms, or null when there is no sample yet. */
staffActivitySchema.virtual('averageResponseMs').get(function averageResponseMs() {
  if (!this.tickets?.responseSamples) return null;
  return Math.round(this.tickets.responseTimeTotalMs / this.tickets.responseSamples);
});

staffActivitySchema.set('toObject', { virtuals: true });
staffActivitySchema.set('toJSON', { virtuals: true });

export const StaffActivity = mongoose.model('StaffActivity', staffActivitySchema);
