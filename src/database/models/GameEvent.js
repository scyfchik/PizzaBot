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
gameEventSchema.index({ guildId: 1, type: 1, occurredAt: -1 });
gameEventSchema.index({ guildId: 1, robloxId: 1, occurredAt: -1 });
/** Mongo drops these once `expiresAt` passes; nulls are kept forever. */
gameEventSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const GameEvent = mongoose.model('GameEvent', gameEventSchema);
