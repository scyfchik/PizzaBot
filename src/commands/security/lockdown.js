import { SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';
import { getConfig } from '../../config/guildConfig.js';
import { Permission } from '../../config/constants.js';
import { embeds, field } from '../../utils/embeds.js';
import { fullTimestamp } from '../../utils/time.js';

export const data = new SlashCommandBuilder()
  .setName('lockdown')
  .setDescription('Lock or unlock every text channel')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addSubcommand((sub) =>
    sub
      .setName('enable')
      .setDescription('Stop @everyone from sending messages server-wide')
      .addStringOption((o) =>
        o.setName('reason').setDescription('Why').setRequired(true).setMaxLength(300),
      )
      .addIntegerOption((o) =>
        o
          .setName('minutes')
          .setDescription('Auto-lift after this many minutes (default 15, 0 = manual)')
          .setMinValue(0)
          .setMaxValue(1440),
      ),
  )
  .addSubcommand((sub) => sub.setName('disable').setDescription('Lift the lockdown'))
  .addSubcommand((sub) => sub.setName('status').setDescription('Is a lockdown active?'));

export const meta = { permission: Permission.SECURITY_LOCKDOWN, cooldown: 5 };

export async function execute(interaction, { client }) {
  await interaction.deferReply();

  const lockdown = client.getSystem('lockdown');
  const sub = interaction.options.getSubcommand();

  if (sub === 'status') {
    const config = await getConfig(interaction.guildId);
    const state = config.security.lockdown;

    if (!state.active) {
      return interaction.editReply({ embeds: [embeds.success('No lockdown is active.')] });
    }

    return interaction.editReply({
      embeds: [
        embeds
          .warning('**Lockdown is active.**')
          .addFields(
            field('Reason', state.reason ?? '—'),
            field('Started', fullTimestamp(state.startedAt), true),
            field('By', state.startedBy ? `<@${state.startedBy}>` : 'Automatic', true),
            field(
              'Auto-lifts',
              state.expiresAt ? fullTimestamp(state.expiresAt) : 'Never — lift manually',
              true,
            ),
            field('Channels locked', String(state.snapshot?.length ?? 0), true),
          ),
      ],
    });
  }

  if (sub === 'enable') {
    const reason = interaction.options.getString('reason');
    const minutes = interaction.options.getInteger('minutes') ?? 15;

    const count = await lockdown.enable(interaction.guild, {
      reason,
      minutes,
      by: interaction.user,
    });

    return interaction.editReply({
      embeds: [
        embeds
          .warning(`🔒 Lockdown enabled — **${count}** channels locked.`)
          .addFields(
            field('Reason', reason),
            field(
              'Auto-lift',
              minutes ? `in ${minutes} minutes` : 'never — remember to run `/lockdown disable`',
              true,
            ),
          ),
      ],
    });
  }

  const restored = await lockdown.disable(interaction.guild, interaction.user);
  return interaction.editReply({
    embeds: [
      embeds.success(
        `🔓 Lockdown lifted — **${restored}** channels restored to their previous permissions.`,
      ),
    ],
  });
}
