import { PermissionFlagsBits, EmbedBuilder } from 'discord.js';
import { SecurityLog } from '../../database/models/SecurityLog.js';
import { Permission, Colors } from '../../config/constants.js';
import { hasPermission } from '../../systems/staff/permissions.js';
import { embeds, field, userLabel } from '../../utils/embeds.js';
import { PermissionError, UserError } from '../../core/errors.js';
import { safeAction } from '../../utils/safeAction.js';

export const domain = 'sec';
export const actions = ['strip', 'dismiss', 'restore'];

/**
 * Human confirmation for held anti-nuke responses.
 *
 * Anti-nuke never acts against protected ranks on its own — it posts an alert
 * with these buttons and waits. That is the whole safety property: a bug in a
 * detector can produce a false alarm, but it cannot remove a Game Director's
 * roles without someone clicking a button.
 *
 * The target and the roles are encoded in the custom ID, so these buttons keep
 * working after a restart.
 */
export async function execute(interaction, { staff, args }) {
  if (!hasPermission(staff, Permission.SECURITY_CONFIRM)) {
    throw new PermissionError('Only the security team can action this alert.');
  }

  const action = interaction.customId.split(':')[2];
  const [userId, payload] = args;

  await interaction.deferReply();

  const member = await interaction.guild.members.fetch(userId).catch(() => null);

  if (action === 'dismiss') return dismiss(interaction, userId, payload);
  if (action === 'strip') return strip(interaction, member, userId, payload);
  if (action === 'restore') return restore(interaction, member, payload);
}

async function dismiss(interaction, userId, incidentId) {
  await SecurityLog.updateMany(
    { guildId: interaction.guildId, incidentId },
    {
      $set: {
        acknowledgedBy: interaction.user.id,
        acknowledgedAt: new Date(),
        action: 'dismissed_authorised',
      },
    },
  );

  await disableButtons(interaction);
  await interaction.editReply({
    embeds: [
      embeds
        .success(
          `Marked incident \`${incidentId}\` as authorised. <@${userId}> keeps their permissions.`,
        )
        .setFooter({ text: `Confirmed by ${interaction.user.tag}` }),
    ],
  });
}

async function strip(interaction, member, userId, incidentId) {
  if (!member) throw new UserError('That member is no longer in the server.');

  const botMember = await interaction.guild.members.fetchMe();
  const DANGEROUS =
    PermissionFlagsBits.Administrator |
    PermissionFlagsBits.ManageGuild |
    PermissionFlagsBits.ManageRoles |
    PermissionFlagsBits.ManageChannels |
    PermissionFlagsBits.BanMembers |
    PermissionFlagsBits.KickMembers |
    PermissionFlagsBits.ManageWebhooks;

  const targets = member.roles.cache.filter(
    (role) =>
      role.id !== interaction.guild.id &&
      (role.permissions.bitfield & DANGEROUS) !== 0n &&
      role.position < botMember.roles.highest.position &&
      !role.managed,
  );

  if (!targets.size) {
    throw new UserError(
      'No removable dangerous roles — their roles sit above mine, or they hold none. ' +
        'You will need to act manually.',
    );
  }

  const result = await safeAction('confirmed-strip', () =>
    member.roles.remove([...targets.keys()], `Anti-nuke confirmed by ${interaction.user.tag}`),
  );
  if (!result.ok) throw new UserError('Discord refused the role removal — check my role position.');

  await SecurityLog.updateMany(
    { guildId: interaction.guildId, incidentId },
    {
      $set: {
        acknowledgedBy: interaction.user.id,
        acknowledgedAt: new Date(),
        action: `confirmed_strip:${targets.size}`,
      },
    },
  );

  await disableButtons(interaction);
  await interaction.editReply({
    embeds: [
      new EmbedBuilder()
        .setColor(Colors.CRITICAL)
        .setAuthor({ name: '🛡️ Permissions removed' })
        .setDescription(`Dangerous roles removed from ${member}.`)
        .addFields(
          field('Confirmed by', userLabel(interaction.user), true),
          field('Incident', `\`${incidentId}\``, true),
          field('Roles removed', [...targets.values()].map((r) => `<@&${r.id}>`).join(', ')),
          field(
            'To undo',
            `Re-add the roles manually, or use the restore button on the original alert.`,
          ),
        )
        .setTimestamp(),
    ],
  });
}

async function restore(interaction, member, packedRoleIds) {
  if (!member) throw new UserError('That member is no longer in the server.');

  const roleIds = packedRoleIds.split('.').filter(Boolean);
  if (!roleIds.length) throw new UserError('No roles recorded for restoration.');

  const result = await safeAction('restore-roles', () =>
    member.roles.add(roleIds, `False positive — restored by ${interaction.user.tag}`),
  );
  if (!result.ok) throw new UserError('Could not restore the roles — check my role position.');

  await disableButtons(interaction);
  await interaction.editReply({
    embeds: [
      embeds
        .success(`Restored ${roleIds.length} role(s) to ${member}.`)
        .setFooter({ text: `Marked as a false positive by ${interaction.user.tag}` }),
    ],
  });
}

/** Stop the same alert being actioned twice by two different people. */
async function disableButtons(interaction) {
  const rows = interaction.message.components.map((row) => ({
    ...row.toJSON(),
    components: row.components.map((c) => ({ ...c.toJSON(), disabled: true })),
  }));
  await safeAction('disable-alert-buttons', () => interaction.message.edit({ components: rows }));
}
