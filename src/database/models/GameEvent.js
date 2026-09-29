import mongoose from 'mongoose';
import { GameEventType } from '../../config/constants.js';

/**
 * A raw event reported by the game.
 *
 * High volume by nature — a busy experience produces a join and a leave per
 * player per session — so this collection is **expiring by default** (30 days).
 * The durable consequences of an event live elsewhere: playtime in
 * `PlayerStats`, money in `Purchase`. This is the audit trail, not the source
 * of the aggregates.
 *
 * `data` is deliberately `Mixed`: every game reports different things, and
 * forcing a schema on it would mean a migration every time a developer adds a
 * field. It is validated for size at the ingest boundary, never trusted, and
 * only ever rendered as text.
 */
const gameEventSchema = new mongoose.Schema(
  {
    guildId: { type: String, required: true, index: true },
    type: { type: String, required: true, enum: Object.values(GameEventType), index: true },

    /**
     * Unique id the game assigns to each event (a GUID).
     *
     * The game retries a batch whose HTTP response was lost — even though the
     * bot may already have stored it. Without this id, every retry would add
     * the kills, deaths and anticheat flags a second time. With it, a repeat is
     * recognised and ignored. Optional, so older reporters still work.
     */
    eventId: { type: String, default: null },

    robloxId: { type: String, default: null, index: true },
    robloxUsername: { type: String, default: null },

    /** Roblox JobId, so events can be grouped by server instance. */
    serverId: { type: String, default: null },
    placeId: { type: String, default: null },
    gameVersion: { type: String, default: null },

    data: { type: mongoose.Schema.Types.Mixed, default: {} },

    /** When it happened in-game, per the game's own clock. */
    occurredAt: { type: Date, default: Date.now },

    expiresAt: { type: Date, default: null },
  },
  { timestamps: true },
);

gameEventSchema.index({ guildId: 1, occurredAt: -1 });
/** Deduplication — partial so events without an id never collide on null. */
gameEventSchema.index(
  { guildId: 1, eventId: 1 },
  { unique: true, partialFilterExpression: { eventId: { $type: 'string' } } },
);
gameEventSchema.index({ guildId: 1, type: 1, occurredAt: -1 });
gameEventSchema.index({ guildId: 1, robloxId: 1, occurredAt: -1 });
/** Mongo drops these once `expiresAt` passes; nulls are kept forever. */
gameEventSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const GameEvent = mongoose.model('GameEvent', gameEventSchema);
