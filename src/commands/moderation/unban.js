import { SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';
import { Permission } from '../../config/constants.js';
import { embeds, padNumber } from '../../utils/embeds.js';
import { UserError } from '../../core/errors.js';
import { getReason } from './_shared.js';

export const data = new SlashCommandBuilder()
  .setName('unban')
  .setDescription('Lift a ban')
  .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers)
  .addStringOption((o) =>
    o
      .setName('user')
      .setDescription('User ID of the banned account')
      .setRequired(true)
      .setAutocomplete(true),
  )
  .addStringOption((o) => o.setName('reason').setDescription('Why').setMaxLength(400));

export const meta = { permission: Permission.MOD_UNBAN, cooldown: 3 };

export async function execute(interaction, { client }) {
  await interaction.deferReply();

  const userId = interaction.options.getString('user').trim();
  if (!/^\d{17,20}$/.test(userId)) {
    throw new UserError('That is not a valid user ID. Pick one from the suggestions.');
  }

  const moderation = client.getSystem('moderation');
  const { punishment } = await moderation.unban(
    interaction.guild,
    userId,
    interaction.member,
    getReason(interaction),
  );

  await interaction.editReply({
    embeds: [
      embeds
        .success(`**${punishment.userTag ?? userId}** was unbanned.`)
        .setFooter({ text: `Case #${padNumber(punishment.caseId)}` }),
    ],
  });
}

/**
 * Suggest currently banned users — nobody remembers raw IDs, and making staff
 * dig through the ban list is how unbans get applied to the wrong account.
 */
export async function autocomplete(interaction) {
  const query = interaction.options.getFocused().toLowerCase();
  const bans = await interaction.guild.bans.fetch().catch(() => null);
  if (!bans) return interaction.respond([]);

  const matches = [...bans.values()]
    .filter((ban) => !query || ban.user.tag.toLowerCase().includes(query) || ban.user.id.includes(query))
    .slice(0, 25)
    .map((ban) => ({ name: `${ban.user.tag} (${ban.user.id})`.slice(0, 100), value: ban.user.id }));

  await interaction.respond(matches);
}
