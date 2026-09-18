import mongoose from 'mongoose';

/**
 * A published game update.
 *
 * Stored rather than only posted, for two reasons: the announcement can be
 * edited and re-rendered from the record, and a bug report can name the version
 * it was fixed in (`BugReport.fixedInVersion`) and have that mean something.
 */
const changelogSchema = new mongoose.Schema(
  {
    guildId: { type: String, required: true, index: true },
    /** Free text so "0.5.0", "0.5.0-hotfix" and "Halloween" all work. */
    version: { type: String, required: true },
    title: { type: String, default: null },

    /** The three standard sections. Each entry is one bullet. */
    added: { type: [String], default: [] },
    fixed: { type: [String], default: [] },
    changed: { type: [String], default: [] },

    credits: { type: String, default: null },
    /** Banner or screenshot shown with the announcement. */
    imageUrl: { type: String, default: null },

    authorId: { type: String, required: true },
    authorTag: { type: String, default: null },

    /** Where it went, so it can be edited in place later. */
    channelId: { type: String, default: null },
    messageId: { type: String, default: null },
    publishedAt: { type: Date, default: null },

    /** Bug report ids this release closed. */
    closedBugIds: { type: [Number], default: [] },
  },
  { timestamps: true },
);

changelogSchema.index({ guildId: 1, version: 1 }, { unique: true });
changelogSchema.index({ guildId: 1, createdAt: -1 });

export const Changelog = mongoose.model('Changelog', changelogSchema);
