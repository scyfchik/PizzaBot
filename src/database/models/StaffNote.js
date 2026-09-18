import mongoose from 'mongoose';

/**
 * Free-form staff annotations on a member.
 *
 * Deliberately separate from Punishment: a note is not a punishment and must
 * never show up in an appeal as one, but staff still need somewhere to record
 * "gave this player a final verbal warning in VC" or "known alt of X".
 */
const staffNoteSchema = new mongoose.Schema(
  {
    guildId: { type: String, required: true, index: true },
    userId: { type: String, required: true, index: true },

    authorId: { type: String, required: true },
    authorTag: { type: String, default: null },

    content: { type: String, required: true, maxlength: 1500 },

    /** Pinned notes surface at the top of /history. */
    pinned: { type: Boolean, default: false },
  },
  { timestamps: true },
);

staffNoteSchema.index({ guildId: 1, userId: 1, createdAt: -1 });

export const StaffNote = mongoose.model('StaffNote', staffNoteSchema);
