/**
 * Shared vocabulary for the whole bot.
 *
 * Anything an embed, a database enum or a permission check needs to agree on
 * lives here, so a value is never spelled two different ways in two files.
 */

/** Brand + semantic embed colours. */
export const Colors = Object.freeze({
  BRAND: 0xf2a33c, // pizza crust orange
  SUCCESS: 0x43b581,
  INFO: 0x5865f2,
  WARNING: 0xfaa61a,
  DANGER: 0xed4245,
  CRITICAL: 0x992d22,
  NEUTRAL: 0x2b2d31,
});

export const Emojis = Object.freeze({
  BUG: '🐛',
  REPORT: '🚨',
  APPEAL: '⚖️',
  PURCHASE: '💳',
  APPLICATION: '📋',
  GENERAL: '❓',
  SHIELD: '🛡️',
  LOCK: '🔒',
  UNLOCK: '🔓',
  CLAIM: '🙋',
  CLOSE: '🔨',
  TRANSCRIPT: '📄',
  NOTE: '📝',
  ALERT: '⚠️',
  TROPHY: '🏆',
  CHART: '📊',
  PIZZA: '🍕',
  SPARKLE: '✨',
  WRENCH: '🔧',
  LINK: '🔗',
  CHECK: '✅',
  CROSS: '❌',
});

/**
 * Permission nodes.
 *
 * Staff access is granted by *node*, not by rank. A rank is just a named bundle
 * of nodes attached to some Discord role IDs, and both the bundle and the role
 * IDs live in the database — see `DEFAULT_RANKS` for the seed values and
 * `/config ranks` to change them. Nothing in the codebase checks a rank name.
 */
export const Permission = Object.freeze({
  // Tickets
  TICKET_CLAIM: 'ticket.claim',
  TICKET_CLOSE: 'ticket.close',
  TICKET_MANAGE: 'ticket.manage', // add/remove members, priority, reopen
  TICKET_APPLICATIONS: 'ticket.applications', // read staff applications

  // Moderation
  MOD_WARN: 'mod.warn',
  MOD_TIMEOUT: 'mod.timeout',
  MOD_KICK: 'mod.kick',
  MOD_BAN: 'mod.ban',
  MOD_UNBAN: 'mod.unban',
  MOD_CLEAR: 'mod.clear',
  MOD_HISTORY: 'mod.history',

  // Cases
  CASE_VIEW: 'case.view',
  CASE_EDIT: 'case.edit',
  CASE_VOID: 'case.void',
  CASE_APPEAL: 'case.appeal', // change appeal status

  // Staff tools
  STAFF_INFO: 'staff.info',
  STAFF_NOTES: 'staff.notes',
  /** View another staff member's activity; everyone staff can view their own. */
  STAFF_ACTIVITY: 'staff.activity',
  STAFF_LEADERBOARD: 'staff.leaderboard',

  // QA
  QA_VIEW: 'qa.view',
  /** Assign testers, change bug status, close reports. */
  QA_MANAGE: 'qa.manage',

  // Development communication
  CHANGELOG_PUBLISH: 'changelog.publish',

  // Security
  SECURITY_ALERTS: 'security.alerts', // pinged for alerts
  SECURITY_CONFIRM: 'security.confirm', // approve a held anti-nuke response
  SECURITY_LOCKDOWN: 'security.lockdown',
  SECURITY_MANAGE: 'security.manage',

  // Administration
  CONFIG_VIEW: 'config.view',
  CONFIG_EDIT: 'config.edit',
  PANEL_MANAGE: 'panel.manage',
  SETUP: 'setup',

  /** Wildcard — holds every node. Reserve for Owner/Co-Owner. */
  ALL: '*',
});

export const ALL_PERMISSIONS = Object.freeze(
  Object.values(Permission).filter((p) => p !== Permission.ALL),
);

/**
 * Default staff ranks, seeded into GuildConfig on `/setup`.
 *
 * `position` orders the hierarchy: staff can only act on people below them.
 * `roleIds` is filled in per server — nothing here is hardcoded into a check.
 */
export const DEFAULT_RANKS = Object.freeze([
  {
    key: 'owner',
    name: 'Owner',
    position: 100,
    protected: true,
    permissions: [Permission.ALL],
  },
  {
    key: 'co_owner',
    name: 'Co-Owner',
    position: 90,
    protected: true,
    permissions: [Permission.ALL],
  },
  {
    key: 'game_director',
    name: 'Game Director',
    position: 80,
    protected: true,
    permissions: [Permission.ALL],
  },
  {
    key: 'lead_developer',
    name: 'Lead Developer',
    position: 70,
    protected: true,
    permissions: [
      Permission.TICKET_CLAIM,
      Permission.TICKET_CLOSE,
      Permission.TICKET_MANAGE,
      Permission.MOD_HISTORY,
      Permission.CASE_VIEW,
      Permission.STAFF_INFO,
      Permission.STAFF_NOTES,
      Permission.SECURITY_ALERTS,
      Permission.SECURITY_CONFIRM,
      Permission.SECURITY_LOCKDOWN,
      Permission.CONFIG_VIEW,
      Permission.CONFIG_EDIT,
      Permission.PANEL_MANAGE,
      Permission.QA_VIEW,
      Permission.QA_MANAGE,
      Permission.CHANGELOG_PUBLISH,
      Permission.STAFF_ACTIVITY,
      Permission.STAFF_LEADERBOARD,
    ],
  },
  {
    key: 'developer',
    name: 'Developer',
    position: 60,
    protected: true,
    permissions: [
      Permission.TICKET_CLAIM,
      Permission.TICKET_CLOSE,
      Permission.CASE_VIEW,
      Permission.CONFIG_VIEW,
      Permission.QA_VIEW,
      Permission.QA_MANAGE,
      Permission.CHANGELOG_PUBLISH,
    ],
  },
  {
    key: 'qa_lead',
    name: 'QA Lead',
    position: 55,
    protected: false,
    permissions: [
      Permission.TICKET_CLAIM,
      Permission.TICKET_CLOSE,
      Permission.TICKET_MANAGE,
      Permission.CASE_VIEW,
      Permission.STAFF_INFO,
      Permission.QA_VIEW,
      Permission.QA_MANAGE,
      Permission.STAFF_ACTIVITY,
      Permission.STAFF_LEADERBOARD,
    ],
  },
  {
    key: 'qa_tester',
    name: 'QA Tester',
    position: 50,
    protected: false,
    permissions: [
      Permission.TICKET_CLAIM,
      Permission.TICKET_CLOSE,
      Permission.CASE_VIEW,
      Permission.QA_VIEW,
    ],
  },
  {
    key: 'community_manager',
    name: 'Community Manager',
    position: 45,
    protected: false,
    permissions: [
      Permission.TICKET_CLAIM,
      Permission.TICKET_CLOSE,
      Permission.TICKET_MANAGE,
      Permission.TICKET_APPLICATIONS,
      Permission.MOD_WARN,
      Permission.MOD_TIMEOUT,
      Permission.MOD_HISTORY,
      Permission.CASE_VIEW,
      Permission.CASE_EDIT,
      Permission.CASE_APPEAL,
      Permission.STAFF_INFO,
      Permission.STAFF_NOTES,
      Permission.PANEL_MANAGE,
      Permission.QA_VIEW,
      Permission.STAFF_ACTIVITY,
      Permission.STAFF_LEADERBOARD,
    ],
  },
  {
    key: 'moderator',
    name: 'Moderator',
    position: 30,
    protected: false,
    permissions: [
      Permission.TICKET_CLAIM,
      Permission.TICKET_CLOSE,
      Permission.MOD_WARN,
      Permission.MOD_TIMEOUT,
      Permission.MOD_KICK,
      Permission.MOD_BAN,
      Permission.MOD_UNBAN,
      Permission.MOD_CLEAR,
      Permission.MOD_HISTORY,
      Permission.CASE_VIEW,
      Permission.CASE_APPEAL,
      Permission.STAFF_NOTES,
    ],
  },
  {
    key: 'trial_moderator',
    name: 'Trial Moderator',
    position: 20,
    protected: false,
    permissions: [
      Permission.TICKET_CLAIM,
      Permission.MOD_WARN,
      Permission.MOD_TIMEOUT,
      Permission.MOD_HISTORY,
      Permission.CASE_VIEW,
    ],
  },
]);

/** Punishment kinds recorded in the case log. */
export const PunishmentType = Object.freeze({
  WARN: 'warn',
  TIMEOUT: 'timeout',
  UNTIMEOUT: 'untimeout',
  KICK: 'kick',
  BAN: 'ban',
  UNBAN: 'unban',
  QUARANTINE: 'quarantine',
  UNQUARANTINE: 'unquarantine',
});

/** Appeal lifecycle for a case. */
export const AppealStatus = Object.freeze({
  ACTIVE: 'active', // no appeal filed
  APPEALED: 'appealed', // player submitted an appeal ticket
  REVIEWED: 'reviewed', // staff read it, decision pending
  ACCEPTED: 'accepted', // punishment lifted
  REJECTED: 'rejected', // punishment stands
});

/** Who issued a case: a human via a command, or a system reacting on its own. */
export const CaseOrigin = Object.freeze({
  COMMAND: 'command',
  AUTO_ESCALATION: 'auto_escalation',
  ANTI_SPAM: 'anti_spam',
  /** Scam patterns and the word blacklist — content, not volume. */
  AUTOMOD: 'automod',
  ANTI_RAID: 'anti_raid',
  ANTI_NUKE: 'anti_nuke',
});

export const TicketCategory = Object.freeze({
  BUG_REPORT: 'bug_report',
  PLAYER_REPORT: 'player_report',
  BAN_APPEAL: 'ban_appeal',
  PURCHASE_ISSUE: 'purchase_issue',
  STAFF_APPLICATION: 'staff_application',
  GENERAL: 'general',
});

export const TicketStatus = Object.freeze({
  OPEN: 'open',
  CLAIMED: 'claimed',
  /** Transient: transcript is being written and the channel is about to go. */
  CLOSING: 'closing',
  CLOSED: 'closed',
});

/** Bug report lifecycle. */
export const BugStatus = Object.freeze({
  OPEN: 'OPEN',
  TESTING: 'TESTING',
  FIXED: 'FIXED',
  REJECTED: 'REJECTED',
});

export const BugStatusMeta = Object.freeze({
  OPEN: { label: '🔴 Open', color: 0xed4245 },
  TESTING: { label: '🟡 Testing', color: 0xfaa61a },
  FIXED: { label: '🟢 Fixed', color: 0x43b581 },
  REJECTED: { label: '⚫ Rejected', color: 0x2b2d31 },
});

/** Platforms the game runs on — used by bug reports. */
export const Platform = Object.freeze({
  PC: 'PC',
  MOBILE: 'Mobile',
  TABLET: 'Tablet',
  CONSOLE: 'Console',
  VR: 'VR',
  UNKNOWN: 'Unknown',
});

export const TicketPriority = Object.freeze({
  LOW: 'low',
  NORMAL: 'normal',
  HIGH: 'high',
  URGENT: 'urgent',
});

/** Security event vocabulary — one value per detector outcome. */
export const SecurityEvent = Object.freeze({
  JOIN_WAVE: 'join_wave',
  NEW_ACCOUNT_WAVE: 'new_account_wave',
  LOCKDOWN_ENABLED: 'lockdown_enabled',
  LOCKDOWN_DISABLED: 'lockdown_disabled',
  SPAM_RATE: 'spam_rate',
  SPAM_DUPLICATE: 'spam_duplicate',
  SPAM_MENTION: 'spam_mention',
  SPAM_EMOJI: 'spam_emoji',
  SPAM_LINK: 'spam_link',
  SPAM_INVITE: 'spam_invite',
  SCAM_PATTERN: 'scam_pattern',
  BLACKLISTED_WORD: 'blacklisted_word',
  NUKE_CHANNEL_DELETE: 'nuke_channel_delete',
  NUKE_ROLE_DELETE: 'nuke_role_delete',
  NUKE_MASS_BAN: 'nuke_mass_ban',
  NUKE_MASS_KICK: 'nuke_mass_kick',
  NUKE_PERMISSION_CHANGE: 'nuke_permission_change',
  NUKE_WEBHOOK_CREATE: 'nuke_webhook_create',
});

/** Drives alert colour, ping behaviour and retention. */
export const Severity = Object.freeze({
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high',
  CRITICAL: 'critical',
});

export const SeverityColor = Object.freeze({
  low: Colors.INFO,
  medium: Colors.WARNING,
  high: Colors.DANGER,
  critical: Colors.CRITICAL,
});

/** Log destinations — each maps to its own channel in GuildConfig. */
export const LogChannel = Object.freeze({
  SECURITY: 'security',
  MODERATION: 'moderation',
  TICKETS: 'tickets',
  STAFF: 'staff',
  SERVER: 'server',
});

/**
 * Custom ID namespace for buttons/menus/modals.
 * Format: `pgt:<domain>:<action>:<...args>` — parsed centrally in utils/ids.js
 * so no handler has to invent its own encoding.
 */
export const ID_PREFIX = 'pgt';

export const Limits = Object.freeze({
  EMBED_DESCRIPTION: 4096,
  EMBED_FIELD_VALUE: 1024,
  REASON_MAX: 450, // Discord audit-log reason cap is 512; leave room for a prefix
  BULK_DELETE_MAX: 100,
});
