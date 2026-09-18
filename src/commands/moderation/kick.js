import { SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';
import { Permission } from '../../config/constants.js';
import { embeds, padNumber, field } from '../../utils/embeds.js';
import { parseEvidence, requireActionableMember, getReason } from './_shared.js';

export const data = new SlashCommandBuilder()
  .setName('kick')
  .setDescription('Remove a member from the server')
  .setDefaultMemberPermissions(PermissionFlagsBits.KickMembers)
  .addUserOption((o) => o.setName('user').setDescription('Who to kick').setRequired(true))
  .addStringOption((o) =>
    o.setName('reason').setDescription('Why').setRequired(true).setMaxLength(400),
  )
  .addStringOption((o) => o.setName('evidence').setDescription('Links, comma separated'));

export const meta = { permission: Permission.MOD_KICK, cooldown: 3 };

export async function execute(interaction, { client, staff }) {
  await interaction.deferReply();

  const member = await requireActionableMember(interaction, staff);
  const moderation = client.getSystem('moderation');

  const { punishment } = await moderation.kick(
    interaction.guild,
    member,
    interaction.member,
    getReason(interaction),
    parseEvidence(interaction),
  );

  await interaction.editReply({
    embeds: [
      embeds
        .success(`**${member.user.tag}** was kicked.`)
        .addFields(field('Reason', punishment.reason))
        .setFooter({
          text: `Case #${padNumber(punishment.caseId)}${
            punishment.notified ? '' : ' · DM not delivered'
          }`,
        }),
    ],
  });
}
