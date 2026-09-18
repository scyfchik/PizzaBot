import mongoose from 'mongoose';

/**
 * Atomic sequence generator.
 *
 * Ticket numbers and case numbers must be gapless, unique and human-readable
 * (#000152). Counting existing documents is racy under concurrent writes, so
 * every number comes from a single `findOneAndUpdate($inc)` — one round trip,
 * atomic at the document level, safe across multiple shards or processes.
 */
const counterSchema = new mongoose.Schema(
  {
    _id: { type: String, required: true }, // e.g. "ticket:<guildId>"
    seq: { type: Number, default: 0 },
  },
  { versionKey: false },
);

counterSchema.statics.next = async function next(scope) {
  const doc = await this.findByIdAndUpdate(
    scope,
    { $inc: { seq: 1 } },
    { new: true, upsert: true, setDefaultsOnInsert: true },
  ).lean();
  return doc.seq;
};

/** Read the current value without consuming a number. */
counterSchema.statics.peek = async function peek(scope) {
  const doc = await this.findById(scope).lean();
  return doc?.seq ?? 0;
};

export const Counter = mongoose.model('Counter', counterSchema);

export const CounterScope = {
  ticket: (guildId) => `ticket:${guildId}`,
  case: (guildId) => `case:${guildId}`,
  bug: (guildId) => `bug:${guildId}`,
};
