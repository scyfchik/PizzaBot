import { SlashCommandBuilder, PermissionFlagsBits, MessageFlags, EmbedBuilder } from 'discord.js';
import { Punishment } from '../../database/models/Punishment.js';
import {
  Permission,
  AppealStatus,
  LogChannel,
  Colors,
} from '../../config/constants.js';
import { caseLogEmbed, appealLabel } from '../../systems/moderation/caseEmbeds.js';
import { hasPermission } from '../../systems/staff/permissions.js';
import { embeds, field, padNumber, userLabel } from '../../utils/embeds.js';
import { fullTimestamp } from '../../utils/time.js';
import { UserError, PermissionError } from '../../core/errors.js';

/**
 * Case management.
 *
 * Cases are never deleted — `void` marks one inactive and records who did it.
 * Every mutation here writes to the staff log, because the people with the
 * power to edit the record are exactly the people whose edits need witnessing.
 */
export const data = new SlashCommandBuilder()
  .setName('case')
  .setDescription('View or manage a moderation case')
  .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
  .addSubcommand((sub) =>
    sub
      .setName('view')
      .setDescription('Show a case')
      .addIntegerOption((o) =>
        o.setName('id').setDescription('Case number').setRequired(true).setMinValue(1),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('reason')
      .setDescription('Correct a case reason')
      .addIntegerOption((o) => o.setName('id').setDescription('Case number').setRequired(true))
      .addStringOption((o) =>
        o.setName('reason').setDescription('New reason').setRequired(true).setMaxLength(400),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('evidence')
      .setDescription('Attach evidence to a case')
      .addIntegerOption((o) => o.setName('id').setDescription('Case number').setRequired(true))
      .addStringOption((o) =>
        o.setName('links').setDescription('Links, comma separated').setRequired(true),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('note')
      .setDescription('Add an internal note to a case')
      .addIntegerOption((o) => o.setName('id').setDescription('Case number').setRequired(true))
      .addStringOption((o) =>
        o.setName('content').setDescription('The note').setRequired(true).setMaxLength(900),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('appeal')
      .setDescription('Set the appeal status of a case')
      .addIntegerOption((o) => o.setName('id').setDescription('Case number').setRequired(true))
      .addStringOption((o) =>
        o
          .setName('status')
          .setDescription('New status')
          .setRequired(true)
          .addChoices(
            { name: 'Active (no appeal)', value: AppealStatus.ACTIVE },
            { name: 'Appealed', value: AppealStatus.APPEALED },
            { name: 'Reviewed', value: AppealStatus.REVIEWED },
            { name: 'Accepted', value: AppealStatus.ACCEPTED },
            { name: 'Rejected', value: AppealStatus.REJECTED },
          ),
      )
      .addStringOption((o) => o.setName('decision').setDescription('Reason for the decision')),
  )
  .addSubcommand((sub) =>
    sub
      .setName('void')
      .setDescription('Void a case — it stays on record but stops counting')
      .addIntegerOption((o) => o.setName('id').setDescription('Case number').setRequired(true))
      .addStringOption((o) =>
        o.setName('reason').setDescription('Why').setRequired(true).setMaxLength(300),
      ),
  );

export const meta = { permission: Permission.CASE_VIEW, cooldown: 2 };

export async function execute(interaction, { client, staff }) {
  const sub = interaction.options.getSubcommand();
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const caseId = interaction.options.getInteger('id');
  const punishment = await Punishment.findOne({ guildId: interaction.guildId, caseId });
  if (!punishment) throw new UserError(`No case #${padNumber(caseId)} on record.`);

  const logs = client.getSystem('logging');

  switch (sub) {
    case 'view':
      return view(interaction, punishment, staff);
    case 'reason':
      return editReason(interaction, punishment, staff, logs);
    case 'evidence':
      return addEvidence(interaction, punishment, staff, logs);
    case 'note':
      return addNote(interaction, punishment, staff);
    case 'appeal':
      return setAppeal(interaction, punishment, staff, logs);
    case 'void':
      return voidCase(interaction, punishment, staff, logs);
  }
}

async function view(interaction, punishment, staff) {
  const embed = caseLogEmbed(punishment).setTitle(`Case #${padNumber(punishment.caseId)}`);

  embed.addFields(field('Recorded', fullTimestamp(punishment.createdAt), true));

  if (punishment.notes.length && hasPermission(staff, Permission.STAFF_NOTES)) {
    embed.addFields(
      field(
        `Internal notes (${punishment.notes.length})`,
        punishment.notes
          .slice(-5)
          .map((n) => `**${n.authorTag}**: ${n.content}`)
          .join('\n'),
      ),
    );
  }

  if (punishment.appeal?.reviewedBy) {
    embed.addFields(
      field(
        'Appeal decision',
        `${appealLabel(punishment.appeal.status)} by <@${punishment.appeal.reviewedBy}>` +
          `${punishment.appeal.decisionReason ? `\n${punishment.appeal.decisionReason}` : ''}`,
      ),
    );
  }

  await interaction.editReply({ embeds: [embed] });
}

async function editReason(interaction, punishment, staff, logs) {
  requireNode(staff, Permission.CASE_EDIT);

  const before = punishment.reason;
  punishment.reason = interaction.options.getString('reason');
  await punishment.save();

  await refreshLog(punishment, logs);
  await auditLog(logs, interaction, punishment, 'Case reason edited', [
    field('Before', before),
    field('After', punishment.reason),
  ]);

  await interaction.editReply({
    embeds: [embeds.success(`Case #${padNumber(punishment.caseId)} reason updated.`)],
  });
}

async function addEvidence(interaction, punishment, staff, logs) {
  requireNode(staff, Permission.CASE_EDIT);

  const links = interaction.options
    .getString('links')
    .split(/[\n,]+/)
    .map((v) => v.trim())
    .filter(Boolean)
    .slice(0, 10);

  punishment.evidence.push(...links);
  await punishment.save();
  await refreshLog(punishment, logs);

  await interaction.editReply({
    embeds: [
      embeds.success(`Added ${links.length} item(s) to case #${padNumber(punishment.caseId)}.`),
    ],
  });
}

async function addNote(interaction, punishment, staff) {
  requireNode(staff, Permission.STAFF_NOTES);

  punishment.notes.push({
    authorId: interaction.user.id,
    authorTag: interaction.user.tag,
    content: interaction.options.getString('content'),
  });
  await punishment.save();

  await interaction.editReply({
    embeds: [embeds.success(`Note added to case #${padNumber(punishment.caseId)}.`)],
  });
}

async function setAppeal(interaction, punishment, staff, logs) {
  requireNode(staff, Permission.CASE_APPEAL);

  const status = interaction.options.getString('status');
  const decision = interaction.options.getString('decision');

  punishment.appeal.status = status;
  punishment.appeal.reviewedBy = interaction.user.id;
  punishment.appeal.reviewedAt = new Date();
  if (decision) punishment.appeal.decisionReason = decision;

  // An accepted appeal means the punishment no longer stands, so the case stops
  // counting against the player in `/player history` and future appeals.
  if (status === AppealStatus.ACCEPTED) {
    punishment.active = false;
    punishment.voidedAt = new Date();
    punishment.voidedBy = interaction.user.id;
    punishment.voidReason = `Appeal accepted${decision ? `: ${decision}` : ''}`;
  }

  await punishment.save();
  await refreshLog(punishment, logs);
  await auditLog(logs, interaction, punishment, 'Appeal status changed', [
    field('Status', appealLabel(status), true),
    field('Decision', decision ?? '—'),
  ]);

  await interaction.editReply({
    embeds: [
      embeds.success(
        `Case #${padNumber(punishment.caseId)} appeal set to **${appealLabel(status)}**.` +
          (status === AppealStatus.ACCEPTED
            ? '\nThe case was voided — it no longer counts against the player. ' +
              'Remember to lift the punishment itself if it is still in force.'
            : ''),
      ),
    ],
  });
}

async function voidCase(interaction, punishment, staff, logs) {
  requireNode(staff, Permission.CASE_VOID);

  if (!punishment.active) throw new UserError('That case is already voided.');

  punishment.active = false;
  punishment.voidedAt = new Date();
  punishment.voidedBy = interaction.user.id;
  punishment.voidReason = interaction.options.getString('reason');
  await punishment.save();

  await refreshLog(punishment, logs);
  await auditLog(logs, interaction, punishment, 'Case voided', [
    field('Reason', punishment.voidReason),
    field('Original moderator', punishment.moderatorId ? `<@${punishment.moderatorId}>` : 'Automatic'),
  ]);

  await interaction.editReply({
    embeds: [
      embeds.success(
        `Case #${padNumber(punishment.caseId)} voided. It stays on record but no longer counts.`,
      ),
    ],
  });
}

function requireNode(staff, node) {
  if (!hasPermission(staff, node)) {
    throw new PermissionError(`Your rank does not include \`${node}\`.`);
  }
}

/** Keep the original moderation-log embed in sync with the edited case. */
function refreshLog(punishment, logs) {
  if (!punishment.logMessageId) return Promise.resolve(false);
  return logs.edit(
    punishment.guildId,
    LogChannel.MODERATION,
    punishment.logMessageId,
    caseLogEmbed(punishment),
  );
}

/** Staff-log entry — who changed the record, and how. */
function auditLog(logs, interaction, punishment, title, fields) {
  return logs.staff(
    interaction.guildId,
    new EmbedBuilder()
      .setColor(Colors.INFO)
      .setAuthor({ name: `${title} · Case #${padNumber(punishment.caseId)}` })
      .addFields(
        field('Staff member', userLabel(interaction.user), true),
        field('Case subject', `<@${punishment.userId}>`, true),
        ...fields,
      )
      .setTimestamp(),
  );
}
