import { SlashCommandBuilder, PermissionFlagsBits, MessageFlags, EmbedBuilder } from 'discord.js';
import { Permission, Limits, Colors } from '../../config/constants.js';
import { embeds, field, userLabel } from '../../utils/embeds.js';
import { UserError } from '../../core/errors.js';

export const data = new SlashCommandBuilder()
  .setName('clear')
  .setDescription('Bulk delete recent messages in this channel')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
  .addIntegerOption((o) =>
    o
      .setName('amount')
      .setDescription('How many messages to scan (1-100)')
      .setRequired(true)
      .setMinValue(1)
      .setMaxValue(Limits.BULK_DELETE_MAX),
  )
  .addUserOption((o) =>
    o.setName('user').setDescription('Only delete messages from this member'),
  )
  .addStringOption((o) => o.setName('reason').setDescription('For the log').setMaxLength(400));

export const meta = { permission: Permission.MOD_CLEAR, cooldown: 5 };

export async function execute(interaction, { client }) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const amount = interaction.options.getInteger('amount');
  const target = interaction.options.getUser('user');
  const reason = interaction.options.getString('reason') ?? 'No reason provided';

  const fetched = await interaction.channel.messages.fetch({ limit: amount });

  // Discord refuses to bulk-delete anything older than 14 days. Filtering here
  // turns a confusing API error into an accurate count.
  const cutoff = Date.now() - 14 * 86_400_000;
  const deletable = fetched.filter(
    (m) => m.createdTimestamp > cutoff && (!target || m.author.id === target.id),
  );

  if (!deletable.size) {
    throw new UserError(
      'Nothing to delete. Messages older than 14 days cannot be bulk deleted by any bot.',
    );
  }

  const deleted = await interaction.channel.bulkDelete(deletable, true);

  await interaction.editReply({
    embeds: [
      embeds.success(
        `Deleted **${deleted.size}** message(s)${target ? ` from ${target}` : ''}.` +
          (deleted.size < deletable.size
            ? `\n${deletable.size - deleted.size} were too old to delete.`
            : ''),
      ),
    ],
  });

  // Bulk deletion destroys evidence — it must always leave a trail.
  await client.getSystem('logging').moderation(
    interaction.guildId,
    new EmbedBuilder()
      .setColor(Colors.WARNING)
      .setAuthor({ name: 'Messages cleared' })
      .addFields(
        field('Channel', `${interaction.channel}`, true),
        field('Count', String(deleted.size), true),
        field('Moderator', userLabel(interaction.user), true),
        field('Filtered to', target ? userLabel(target) : 'Everyone', true),
        field('Reason', reason),
      )
      .setTimestamp(),
  );
}
