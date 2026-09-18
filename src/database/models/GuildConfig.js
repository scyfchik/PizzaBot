import mongoose from 'mongoose';
import { DEFAULT_RANKS } from '../../config/constants.js';

/**
 * Per-guild runtime configuration.
 *
 * Seeded by `/setup`, then owned by the database and edited live with
 * `/config`. Keeping thresholds here rather than in env means the team can tune
 * anti-raid during an actual raid without a redeploy.
 */

const channelId = { type: String, default: null };

/**
 * A staff rank: a name, some Discord role IDs, and the permission nodes those
 * roles grant. Nothing in the codebase checks `key` — it exists so /config can
 * address a rank. Ranks are fully editable; these are only defaults.
 */
const rankSchema = new mongoose.Schema(
  {
    key: { type: String, required: true },
    name: { type: String, required: true },
    /** Higher acts on lower. Also decides who anti-nuke may not touch alone. */
    position: { type: Number, required: true },
    roleIds: { type: [String], default: [] },
    permissions: { type: [String], default: [] },
    /**
     * Protected ranks are never auto-punished by security systems — the bot
     * holds the action and asks a human instead. See systems/security/antiNuke.
     */
    protected: { type: Boolean, default: false },
  },
  { _id: false },
);

const guildConfigSchema = new mongoose.Schema(
  {
    guildId: { type: String, required: true, unique: true, index: true },

    /** Completed at least one successful /setup run. */
    setupComplete: { type: Boolean, default: false },

    staffRanks: {
      type: [rankSchema],
      default: () => DEFAULT_RANKS.map((r) => ({ ...r, roleIds: [] })),
    },

    logChannels: {
      security: channelId,
      moderation: channelId,
      tickets: channelId,
      staff: channelId,
      server: channelId,
    },

    tickets: {
      enabled: { type: Boolean, default: true },
      categoryId: channelId,
      panelChannelId: channelId,
      panelMessageId: { type: String, default: null },
      supportRoleId: { type: String, default: null },
      maxOpenPerUser: { type: Number, default: 2 },
      /** Category keys turned off for this server. */
      disabledCategories: { type: [String], default: [] },
      transcriptsEnabled: { type: Boolean, default: true },
      dmTranscriptToUser: { type: Boolean, default: true },
      /** Store a web-viewable transcript and include its private link. */
      webTranscriptsEnabled: { type: Boolean, default: true },
      /**
       * Days a transcript link stays alive. 0 keeps it indefinitely.
       *
       * Defaults to 90 rather than forever: transcripts hold personal data, and
       * a link that works for years is a slow leak waiting to happen.
       */
      transcriptExpiryDays: { type: Number, default: 90 },
    },

    security: {
      quarantineRoleId: { type: String, default: null },
      alertChannelId: channelId,
      pingRoleId: { type: String, default: null },

      antiRaid: {
        enabled: { type: Boolean, default: true },
        /** N joins within `windowSeconds` trips the join-wave detector. */
        joinThreshold: { type: Number, default: 8 },
        windowSeconds: { type: Number, default: 20 },
        /** Accounts younger than this count as "new" for wave detection. */
        newAccountDays: { type: Number, default: 7 },
        newAccountThreshold: { type: Number, default: 5 },
        /** quarantine | kick | alert_only */
        action: { type: String, default: 'quarantine' },
        autoLockdown: { type: Boolean, default: false },
        lockdownMinutes: { type: Number, default: 15 },
      },

      // Anti-spam and content filtering are deliberately absent. Pizza Bot does
      // not read messages for moderation — Dyno/Carl-bot own that, and two bots
      // deleting the same message produces double punishments.

      antiNuke: {
        enabled: { type: Boolean, default: true },
        /** Users/bots exempt entirely. Every entry is a hole — keep it tiny. */
        whitelist: { type: [String], default: [] },
        channelDeleteLimit: { type: Number, default: 3 },
        roleDeleteLimit: { type: Number, default: 3 },
        banLimit: { type: Number, default: 5 },
        kickLimit: { type: Number, default: 5 },
        webhookCreateLimit: { type: Number, default: 3 },
        windowSeconds: { type: Number, default: 30 },
        /**
         * Response for ordinary members. Protected ranks are NEVER handled
         * automatically regardless of this setting.
         * alert_only | remove_permissions
         */
        response: { type: String, default: 'remove_permissions' },
        /** Warn when a role gains Administrator / Manage Guild / Manage Roles. */
        watchPermissionEscalation: { type: Boolean, default: true },
        /** Minutes a held confirmation stays actionable before it expires. */
        confirmationTimeoutMinutes: { type: Number, default: 30 },
      },

      lockdown: {
        active: { type: Boolean, default: false },
        startedAt: { type: Date, default: null },
        startedBy: { type: String, default: null },
        reason: { type: String, default: null },
        expiresAt: { type: Date, default: null },
        /** Snapshot of prior overwrites so lifting restores the exact state. */
        snapshot: { type: mongoose.Schema.Types.Mixed, default: [] },
      },
    },

    /**
     * Moderation history.
     *
     * Pizza Bot records punishments from Discord's audit log; it does not issue
     * them. There is nothing to configure about escalation or DM notices here,
     * because whichever bot actually performs the action owns those decisions.
     */
    moderation: {
      /** Write a case when another bot or moderator acts. */
      recordExternalActions: { type: Boolean, default: true },
    },

    /** QA workflow — bug reports from players and the testing team. */
    qa: {
      enabled: { type: Boolean, default: true },
      /** Board channel where every bug report is posted and kept in sync. */
      boardChannelId: channelId,
      /** Role pinged for new reports and eligible to be assigned as tester. */
      testerRoleId: { type: String, default: null },
      /** Current game version, offered as the default in the bug form. */
      currentVersion: { type: String, default: null },
      /** Ping the tester role on critical severity only, to avoid alert fatigue. */
      pingOnCriticalOnly: { type: Boolean, default: true },
    },

    /** Live game data reported by the Roblox experience. */
    game: {
      /** Where notable in-game events are mirrored. */
      eventChannelId: channelId,
      /** Ping this role on reported errors and failed purchases. */
      alertRoleId: { type: String, default: null },
      /** Shown on player profiles when the game reports a version. */
      currentVersion: { type: String, default: null },
    },

    /** Reserved — read by the Roblox services when that integration lands. */
    roblox: {
      enabled: { type: Boolean, default: false },
      groupId: { type: String, default: null },
      universeId: { type: String, default: null },
      verifiedRoleId: { type: String, default: null },
      testerRoleId: { type: String, default: null },
      announcementChannelId: channelId,
    },

    schemaVersion: { type: Number, default: 1 },
  },
  { timestamps: true },
);

export const GuildConfig = mongoose.model('GuildConfig', guildConfigSchema);
