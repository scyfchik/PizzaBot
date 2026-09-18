import { env } from '../../config/env.js';
import { getConfig } from '../../config/guildConfig.js';
import { Permission } from '../../config/constants.js';
import { PermissionError, HierarchyError } from '../../core/errors.js';

/**
 * Staff permissions.
 *
 * There are no hardcoded tiers. A rank is a row in `GuildConfig.staffRanks`:
 * a name, some Discord role IDs, a position, and a list of permission nodes.
 * Every check in the codebase asks "does this member hold node X" — never
 * "is this member a Moderator" — so renaming, reordering or re-scoping a rank
 * is a config change, not a code change.
 *
 * Bot owners (OWNER_IDS in .env) bypass everything. That is the bootstrap:
 * without it, a fresh server has nobody who can run /setup.
 */

/**
 * Resolve a member's staff standing.
 * A member holding several staff roles gets the union of their permissions and
 * the highest of their positions.
 */
export async function resolveStaff(member) {
  const isOwner = env.owners.includes(member.id) || member.guild.ownerId === member.id;

  if (isOwner) {
    return {
      isOwner: true,
      isStaff: true,
      position: Number.MAX_SAFE_INTEGER,
      permissions: new Set([Permission.ALL]),
      rankNames: ['Owner'],
      topRank: { key: 'owner', name: 'Owner', position: Number.MAX_SAFE_INTEGER, protected: true },
      protected: true,
    };
  }

  const config = await getConfig(member.guild.id);
  const roleIds = new Set(member.roles.cache.keys());

  const matched = (config.staffRanks ?? [])
    .filter((rank) => rank.roleIds?.some((id) => roleIds.has(id)))
    .sort((a, b) => b.position - a.position);

  if (!matched.length) {
    return {
      isOwner: false,
      isStaff: false,
      position: 0,
      permissions: new Set(),
      rankNames: [],
      topRank: null,
      protected: false,
    };
  }

  const permissions = new Set();
  for (const rank of matched) for (const node of rank.permissions ?? []) permissions.add(node);

  return {
    isOwner: false,
    isStaff: true,
    position: matched[0].position,
    permissions,
    rankNames: matched.map((r) => r.name),
    topRank: matched[0],
    /** True if ANY held rank is protected — security systems defer to a human. */
    protected: matched.some((r) => r.protected),
  };
}

export function hasPermission(staff, node) {
  return staff.permissions.has(Permission.ALL) || staff.permissions.has(node);
}

/** Throws `PermissionError` when the node is missing. */
export function requirePermission(staff, node) {
  if (!hasPermission(staff, node)) {
    throw new PermissionError(
      staff.isStaff
        ? `Your rank (${staff.rankNames.join(', ')}) does not include \`${node}\`.`
        : 'This command is for staff only.',
    );
  }
}

/**
 * Validate that `actor` may act on `target`.
 *
 * Three independent rules, all of which must pass:
 *   1. Bot standing   — Discord will refuse anything above the bot's top role.
 *   2. Staff standing — you cannot act on an equal or higher rank.
 *   3. Role standing  — you cannot act on someone whose top role is >= yours.
 *
 * Rule 2 is what stops a compromised moderator account from removing the rest
 * of the staff team. Rule 3 catches people with power the bot does not know
 * about because their role was never registered as a rank.
 */
export async function assertCanActOn(actorMember, targetMember, actorStaff = null) {
  if (actorMember.id === targetMember.id) {
    throw new HierarchyError('You cannot take this action against yourself.');
  }
  if (targetMember.id === actorMember.client.user.id) {
    throw new HierarchyError('I cannot take this action against myself.');
  }
  if (targetMember.id === targetMember.guild.ownerId) {
    throw new HierarchyError('The server owner cannot be actioned by the bot.');
  }

  const botMember = await targetMember.guild.members.fetchMe();
  if (targetMember.roles.highest.position >= botMember.roles.highest.position) {
    throw new HierarchyError(
      "That member's highest role is above mine, so Discord will not let me act on them. " +
        'Move my role higher in Server Settings → Roles.',
    );
  }

  const actor = actorStaff ?? (await resolveStaff(actorMember));
  if (actor.isOwner) return;

  const target = await resolveStaff(targetMember);
  if (target.isStaff && target.position >= actor.position) {
    throw new HierarchyError(
      `${targetMember.user.username} holds an equal or higher rank than you.`,
    );
  }

  if (targetMember.roles.highest.position >= actorMember.roles.highest.position) {
    throw new HierarchyError(
      `${targetMember.user.username}'s highest role is above or equal to yours.`,
    );
  }
}

/**
 * Whether a member holds a protected rank.
 *
 * Security systems use this to decide between acting and asking. Anything that
 * could take power away from senior staff must go through a human — a bug in a
 * detector should never be able to decapitate the team.
 */
export async function isProtectedMember(member) {
  if (!member?.guild) return false;
  if (member.id === member.guild.ownerId) return true;
  if (env.owners.includes(member.id)) return true;
  const staff = await resolveStaff(member);
  return staff.protected;
}

/** Human-readable rank label for embeds. */
export function rankLabel(staff) {
  if (!staff.isStaff) return 'Member';
  return staff.rankNames.join(' · ');
}
