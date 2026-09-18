import { SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';
import { Permission } from '../../config/constants.js';
import { embeds, padNumber, field } from '../../utils/embeds.js';
import { formatDuration } from '../../utils/time.js';
import { parseEvidence, requireActionableMember, getReason } from './_shared.js';

export const data = new SlashCommandBuilder()
  .setName('warn')
  .setDescription('Warn a member and record a case')
  .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
  .addUserOption((o) => o.setName('user').setDescription('Who to warn').setRequired(true))
  .addStringOption((o) =>
    o.setName('reason').setDescription('Why').setRequired(true).setMaxLength(400),
  )
  .addStringOption((o) =>
    o
      .setName('evidence')
      .setDescription('Message links or screenshot URLs, comma separated')
      .setMaxLength(900),
  );

export const meta = { permission: Permission.MOD_WARN, cooldown: 2 };

export async function execute(interaction, { client, staff }) {
  await interaction.deferReply();

  const member = await requireActionableMember(interaction, staff);
  const moderation = client.getSystem('moderation');

  const { punishment, escalated } = await moderation.warn(
    interaction.guild,
    member,
    interaction.member,
    getReason(interaction),
    parseEvidence(interaction),
  );

  const embed = embeds
    .success(`**${member.user.tag}** was warned.`)
    .addFields(field('Reason', punishment.reason))
    .setFooter({
      text: `Case #${padNumber(punishment.caseId)}${punishment.notified ? '' : ' · DM not delivered'}`,
    });

  // Escalation is a surprise if it is not said out loud — the moderator needs
  // to know the warn turned into something bigger.
  if (escalated) {
    const detail =
      escalated.action === 'timeout'
        ? `timed out for ${formatDuration(escalated.duration)}`
        : 'kicked';
    embed.addFields(
      field(
        '⚠️ Auto-escalation',
        `${escalated.warnCount} active warnings — member was automatically ${detail}. ` +
          `(Case #${padNumber(escalated.caseId)})`,
      ),
    );
  }

  await interaction.editReply({ embeds: [embed] });
}
