import mongoose from 'mongoose';

/**
 * The link between a Discord account and a Roblox account.
 *
 * Global, not per-guild. A Roblox account belongs to the person, not to their
 * membership of one server — storing it per-guild would mean the same player
 * re-verifying in every server and the same link duplicated N times, with N
 * chances to disagree.
 *
 * `verified` is the field that matters. A row can exist with `verified: false`
 * (the player told us a username) long before anyone proved it. Nothing should
 * treat an unverified row as identity — see `src/systems/roblox/README.md`.
 */
const robloxProfileSchema = new mongoose.Schema(
  {
    discordId: { type: String, required: true, unique: true, index: true },

    /** Null until the Roblox API resolves the username to an ID. */
    robloxId: { type: String, default: null, index: true, sparse: true },
    username: { type: String, default: null },
    displayName: { type: String, default: null },

    verified: { type: Boolean, default: false, index: true },
    verifiedAt: { type: Date, default: null },
    /** manual | code | gamepass | oauth — how the link was proven. */
    verificationMethod: { type: String, default: null },
    /** Who approved a manual verification. */
    verifiedBy: { type: String, default: null },

    /** Pending profile-code verification. */
    pending: {
      code: { type: String, default: null },
      requestedUsername: { type: String, default: null },
      expiresAt: { type: Date, default: null },
      attempts: { type: Number, default: 0 },
    },

    /** Filled by the future group/tester sync. */
    isTester: { type: Boolean, default: false },
    groupRank: { type: Number, default: null },
    groupRoleName: { type: String, default: null },

    lastCheckedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

/**
 * Deliberately NOT a TTL index. Mongo's TTL deletes the whole document, so
 * expiring `pending.expiresAt` that way would destroy a verified profile that
 * happens to have a stale pending block. Expiry is checked in code instead.
 */
robloxProfileSchema.methods.hasLivePending = function hasLivePending() {
  return Boolean(this.pending?.code && this.pending.expiresAt > new Date());
};

export const RobloxProfile = mongoose.model('RobloxProfile', robloxProfileSchema);
