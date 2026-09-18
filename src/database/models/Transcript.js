import mongoose from 'mongoose';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * A stored ticket transcript, served by the web viewer.
 *
 * Structured message data rather than rendered HTML, so the viewer's design can
 * change without regenerating every historic transcript. The HTML file on disk
 * is kept as a fallback for when the web server is disabled or unreachable.
 *
 * ## Access model
 *
 * There is no login. Access is by **unguessable URL token** — 32 random bytes,
 * which is not brute-forceable, and the server rate-limits lookups anyway.
 *
 * Only the SHA-256 *hash* of the token is stored. A dump of this collection
 * therefore does not hand someone every transcript in the studio's history;
 * the plaintext token exists only in the link that was sent to the ticket log
 * and the opener's DMs.
 *
 * Transcripts hold whatever players typed, which routinely includes real names,
 * purchase details and account information. Treat this collection as personal
 * data: it expires by default, and the viewer is served `noindex`.
 */

const messageSchema = new mongoose.Schema(
  {
    _id: false,
    id: String,
    authorId: String,
    authorTag: String,
    authorAvatar: String,
    bot: { type: Boolean, default: false },
    /** Rendered by the viewer as text; never as HTML. */
    content: { type: String, default: '' },
    createdAt: Date,
    editedAt: { type: Date, default: null },
    attachments: {
      type: [
        {
          _id: false,
          name: String,
          url: String,
          contentType: String,
          size: Number,
        },
      ],
      default: [],
    },
    embeds: {
      type: [
        {
          _id: false,
          title: String,
          description: String,
          color: Number,
          fields: [{ _id: false, name: String, value: String }],
        },
      ],
      default: [],
    },
    /** Staff at the time of writing — drives the role badge in the viewer. */
    isStaff: { type: Boolean, default: false },
  },
  { _id: false },
);

const transcriptSchema = new mongoose.Schema(
  {
    guildId: { type: String, required: true, index: true },
    ticketId: { type: Number, required: true },

    /** SHA-256 of the URL token. The token itself is never stored. */
    tokenHash: { type: String, required: true, unique: true, index: true },

    /** Denormalised ticket header, so the viewer needs one read. */
    meta: {
      category: String,
      categoryLabel: String,
      guildName: String,
      channelName: String,
      openerId: String,
      openerTag: String,
      openerAvatar: String,
      robloxUsername: String,
      claimedBy: String,
      claimedByTag: String,
      closedBy: String,
      closedByTag: String,
      closeReason: String,
      createdAt: Date,
      closedAt: Date,
      firstResponseMs: Number,
      resolutionTimeMs: Number,
      /** accepted / denied / resolved / no_action — the outcome, not just "closed". */
      decision: String,
      summary: String,
      /** The category form answers. */
      responses: [{ _id: false, key: String, label: String, value: String }],
    },

    /**
     * What happened and when. Derived at close time rather than reconstructed
     * by a reader scrolling the message list for the moment someone claimed it.
     */
    timeline: {
      type: [{ _id: false, at: Date, label: String, actor: String }],
      default: [],
    },

    /**
     * The player's standing at the moment the ticket closed.
     *
     * Snapshotted, not looked up live: a transcript read a year later should
     * show what staff were looking at when they made the decision, not what is
     * true now. An appeal judged against "0 prior warnings" stays defensible
     * even after the player collects five more.
     */
    playerContext: {
      robloxId: { type: String, default: null },
      accountAgeDays: { type: Number, default: null },
      previousTickets: { type: Number, default: null },
      activeWarnings: { type: Number, default: null },
      totalPunishments: { type: Number, default: null },
      playtimeMinutes: { type: Number, default: null },
      level: { type: Number, default: null },
      robuxSpent: { type: Number, default: null },
      /** Recent transactions, for purchase-support tickets. */
      recentPurchases: {
        type: [
          {
            _id: false,
            productName: String,
            robuxAmount: Number,
            status: String,
            transactionId: String,
            purchasedAt: Date,
          },
        ],
        default: [],
      },
    },

    messages: { type: [messageSchema], default: [] },
    messageCount: { type: Number, default: 0 },
    /** True when the ticket had more messages than the storage cap. */
    truncated: { type: Boolean, default: false },

    /** Null means it never expires. */
    expiresAt: { type: Date, default: null },
    /** Set by staff to kill a link early without deleting the record. */
    revoked: { type: Boolean, default: false },

    viewCount: { type: Number, default: 0 },
    lastViewedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

transcriptSchema.index({ guildId: 1, ticketId: 1 });
/**
 * Mongo removes the document once `expiresAt` passes. Documents with a null
 * value are left alone, which is what "never expires" means here.
 */
transcriptSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

/** Whether this transcript may still be served. */
transcriptSchema.methods.isServable = function isServable() {
  if (this.revoked) return false;
  if (this.expiresAt && this.expiresAt <= new Date()) return false;
  return true;
};

export const Transcript = mongoose.model('Transcript', transcriptSchema);

/** 32 random bytes, URL-safe. Not guessable, not derived from the ticket id. */
export function generateToken() {
  return randomBytes(32).toString('base64url');
}

export function hashToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Constant-time hash comparison.
 *
 * The lookup is by indexed hash, so this is belt-and-braces rather than the
 * primary defence — but comparing digests with `===` is the kind of thing that
 * gets copied into a place where it does matter.
 */
export function tokensMatch(hashA, hashB) {
  const a = Buffer.from(String(hashA), 'hex');
  const b = Buffer.from(String(hashB), 'hex');
  if (a.length !== b.length || a.length === 0) return false;
  return timingSafeEqual(a, b);
}
