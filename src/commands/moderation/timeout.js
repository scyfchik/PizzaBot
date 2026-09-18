import { SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';
import { Permission } from '../../config/constants.js';
import { embeds, padNumber, field } from '../../utils/embeds.js';
import { parseDuration, formatDuration } from '../../utils/time.js';
import { UserError } from '../../core/errors.js';
import { parseEvidence, requireActionableMember, getReason } from './_shared.js';

export const data = new SlashCommandBuilder()
  .setName('timeout')
  .setDescription('Time a member out, or remove an existing timeout')
  .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
  .addSubcommand((sub) =>
    sub
      .setName('add')
      .setDescription('Time a member out')
      .addUserOption((o) => o.setName('user').setDescription('Who').setRequired(true))
      .addStringOption((o) =>
        o
          .setName('duration')
          .setDescription('e.g. 10m, 2h, 1d — maximum 28 days')
          .setRequired(true),
      )
      .addStringOption((o) =>
        o.setName('reason').setDescription('Why').setRequired(true).setMaxLength(400),
      )
      .addStringOption((o) => o.setName('evidence').setDescription('Links, comma separated')),
  )
  .addSubcommand((sub) =>
    sub
      .setName('remove')
      .setDescription('Lift a timeout early')
      .addUserOption((o) => o.setName('user').setDescription('Who').setRequired(true))
      .addStringOption((o) => o.setName('reason').setDescription('Why').setMaxLength(400)),
  );

export const meta = { permission: Permission.MOD_TIMEOUT, cooldown: 2 };

export async function execute(interaction, { client, staff }) {
  await interaction.deferReply();

  const member = await requireActionableMember(interaction, staff);
  const moderation = client.getSystem('moderation');

  if (interaction.options.getSubcommand() === 'remove') {
    const { punishment } = await moderation.removeTimeout(
      interaction.guild,
      member,
      interaction.member,
      getReason(interaction),
    );
    return interaction.editReply({
      embeds: [
        embeds
          .success(`Timeout lifted for **${member.user.tag}**.`)
          .setFooter({ text: `Case #${padNumber(punishment.caseId)}` }),
      ],
    });
  }

  const duration = parseDuration(interaction.options.getString('duration'));
  if (!duration) {
    throw new UserError('I could not read that duration. Try `10m`, `2h`, `1d` or `1w`.');
  }

  const { punishment } = await moderation.timeout(
    interaction.guild,
    member,
    interaction.member,
    duration,
    getReason(interaction),
    parseEvidence(interaction),
  );

  await interaction.editReply({
    embeds: [
      embeds
        .success(`**${member.user.tag}** was timed out for **${formatDuration(duration)}**.`)
        .addFields(field('Reason', punishment.reason))
        .setFooter({
          text: `Case #${padNumber(punishment.caseId)}${
            punishment.notified ? '' : ' · DM not delivered'
          }`,
        }),
    ],
  });
}
