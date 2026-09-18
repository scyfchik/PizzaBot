import { SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';
import { Permission } from '../../config/constants.js';
import { embeds, padNumber, field } from '../../utils/embeds.js';
import { parseDuration, formatDuration } from '../../utils/time.js';
import { assertCanActOn } from '../../systems/staff/permissions.js';
import { UserError } from '../../core/errors.js';
import { parseEvidence, getReason } from './_shared.js';

/**
 * Ban accepts a *user*, not a member, so people who already left — or who were
 * never here — can still be banned by ID. Hierarchy is only checked when the
 * target is actually in the server.
 */
export const data = new SlashCommandBuilder()
  .setName('ban')
  .setDescription('Ban a user, permanently or for a set time')
  .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers)
  .addUserOption((o) => o.setName('user').setDescription('Who to ban').setRequired(true))
  .addStringOption((o) =>
    o.setName('reason').setDescription('Why').setRequired(true).setMaxLength(400),
  )
  .addStringOption((o) =>
    o.setName('duration').setDescription('Temporary ban, e.g. 7d. Omit for permanent.'),
  )
  .addIntegerOption((o) =>
    o
      .setName('delete-messages')
      .setDescription('Delete their recent messages')
      .addChoices(
        { name: "Don't delete", value: 0 },
        { name: 'Last hour', value: 3600 },
        { name: 'Last 24 hours', value: 86400 },
        { name: 'Last 7 days', value: 604800 },
      ),
  )
  .addStringOption((o) => o.setName('evidence').setDescription('Links, comma separated'));

export const meta = { permission: Permission.MOD_BAN, cooldown: 3 };

export async function execute(interaction, { client, staff }) {
  await interaction.deferReply();

  const user = interaction.options.getUser('user');
  const member = interaction.options.getMember('user');

  // Only enforce hierarchy if they are here — you cannot outrank someone who left.
  if (member) await assertCanActOn(interaction.member, member, staff);

  let duration = null;
  const rawDuration = interaction.options.getString('duration');
  if (rawDuration) {
    duration = parseDuration(rawDuration);
    if (!duration) throw new UserError('I could not read that duration. Try `7d` or `12h`.');
  }

  const moderation = client.getSystem('moderation');
  const { punishment } = await moderation.ban(
    interaction.guild,
    user,
    interaction.member,
    getReason(interaction),
    {
      evidence: parseEvidence(interaction),
      deleteMessageSeconds: interaction.options.getInteger('delete-messages') ?? 0,
      duration,
    },
  );

  await interaction.editReply({
    embeds: [
      embeds
        .success(
          `**${user.tag}** was banned${duration ? ` for **${formatDuration(duration)}**` : ' permanently'}.`,
        )
        .addFields(field('Reason', punishment.reason))
        .setFooter({
          text: `Case #${padNumber(punishment.caseId)}${
            punishment.notified ? '' : ' · DM not delivered'
          }`,
        }),
    ],
  });
}
