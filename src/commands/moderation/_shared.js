import { UserError } from '../../core/errors.js';
import { assertCanActOn } from '../../systems/staff/permissions.js';

/**
 * Helpers shared by the moderation commands.
 * The `_` prefix keeps the command loader from treating this as a command.
 */

/** Evidence is a free-text option — split it into a list of links/notes. */
export function parseEvidence(interaction) {
  const raw = interaction.options.getString('evidence');
  if (!raw) return [];
  return raw
    .split(/[\n,]+/)
    .map((v) => v.trim())
    .filter(Boolean)
    .slice(0, 10);
}

/**
 * Fetch the target as a guild member and run every hierarchy rule.
 * Commands that can act on people who already left (ban, unban) do not use this.
 */
export async function requireActionableMember(interaction, staff, optionName = 'user') {
  const member = interaction.options.getMember(optionName);
  if (!member) throw new UserError('That user is not in this server.');
  await assertCanActOn(interaction.member, member, staff);
  return member;
}

/** Standard reason option handling — `requireReason` is enforced by the schema. */
export function getReason(interaction) {
  return interaction.options.getString('reason') ?? 'No reason provided';
}
