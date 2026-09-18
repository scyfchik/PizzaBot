import mongoose from 'mongoose';
import { SecurityEvent, Severity } from '../../config/constants.js';

/**
 * Forensic record of every security detection.
 *
 * Written on detection, *before* any punitive action, so an incident is still
 * reconstructable if the response itself fails. Low-severity noise expires
 * automatically; high and critical events are kept indefinitely.
 */
const securityLogSchema = new mongoose.Schema(
  {
    guildId: { type: String, required: true, index: true },
    event: { type: String, required: true, enum: Object.values(SecurityEvent) },
    severity: { type: String, default: Severity.LOW, enum: Object.values(Severity) },

    /** Who triggered it (spammer, raider, rogue admin). */
    userId: { type: String, default: null, index: true },
    userTag: { type: String, default: null },

    channelId: { type: String, default: null },

    /** What the bot did in response: 'delete', 'timeout', 'quarantine', ... */
    action: { type: String, default: 'none' },
    actionSucceeded: { type: Boolean, default: true },
    actionError: { type: String, default: null },

    /** Detector-specific evidence — thresholds hit, sample content, counts. */
    details: { type: mongoose.Schema.Types.Mixed, default: {} },

    /** Groups every log line produced by one raid or nuke attempt. */
    incidentId: { type: String, default: null, index: true },

    /** Case number, when the response also created a punishment record. */
    caseId: { type: Number, default: null },

    /** Set once a staff member acknowledges the alert. */
    acknowledgedBy: { type: String, default: null },
    acknowledgedAt: { type: Date, default: null },

    /** TTL anchor — see index below. Null means keep forever. */
    expiresAt: { type: Date, default: null },
  },
  { timestamps: true },
);

securityLogSchema.index({ guildId: 1, createdAt: -1 });
securityLogSchema.index({ guildId: 1, event: 1, createdAt: -1 });
securityLogSchema.index({ guildId: 1, severity: 1, createdAt: -1 });
/** Mongo removes documents once `expiresAt` passes; null-valued docs are kept. */
securityLogSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const SecurityLog = mongoose.model('SecurityLog', securityLogSchema);
