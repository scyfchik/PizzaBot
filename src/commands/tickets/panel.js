import {
  SlashCommandBuilder,
  PermissionFlagsBits,
  ChannelType,
  MessageFlags,
} from 'discord.js';
import { getConfig, saveConfig } from '../../config/guildConfig.js';
import { panelEmbed, panelComponents } from '../../systems/tickets/components.js';
import { Permission } from '../../config/constants.js';
import { embeds } from '../../utils/embeds.js';
import { UserError } from '../../core/errors.js';

export const data = new SlashCommandBuilder()
  .setName('panel')
  .setDescription('Post or refresh the ticket panel')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addSubcommand((sub) =>
    sub
      .setName('post')
      .setDescription('Post the ticket panel in a channel')
      .addChannelOption((opt) =>
        opt
          .setName('channel')
          .setDescription('Where to post it (defaults to the configured panel channel)')
          .addChannelTypes(ChannelType.GuildText),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('refresh')
      .setDescription('Update the existing panel after changing ticket categories'),
  );

export const meta = {
  permission: Permission.PANEL_MANAGE,
  cooldown: 5,
};

export async function execute(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const config = await getConfig(interaction.guildId);
  const sub = interaction.options.getSubcommand();

  if (sub === 'post') return post(interaction, config);
  return refresh(interaction, config);
}

async function post(interaction, config) {
  const channel =
    interaction.options.getChannel('channel') ??
    (config.tickets.panelChannelId
      ? await interaction.guild.channels.fetch(config.tickets.panelChannelId).catch(() => null)
      : null);

  if (!channel) {
    throw new UserError('Pick a channel, or set one with `/config tickets panel-channel` first.');
  }

  const message = await channel.send({
    embeds: [panelEmbed(interaction.guild)],
    components: panelComponents(config),
  });

  // Remember where the panel lives so /panel refresh can find it later.
  config.tickets.panelChannelId = channel.id;
  config.tickets.panelMessageId = message.id;
  await saveConfig(config);

  await interaction.editReply({
    embeds: [embeds.success(`Panel posted in ${channel}.`)],
  });
}

async function refresh(interaction, config) {
  const { panelChannelId, panelMessageId } = config.tickets;
  if (!panelChannelId || !panelMessageId) {
    throw new UserError('No panel has been posted yet. Use `/panel post` first.');
  }

  const channel = await interaction.guild.channels.fetch(panelChannelId).catch(() => null);
  const message = channel ? await channel.messages.fetch(panelMessageId).catch(() => null) : null;

  if (!message) {
    throw new UserError('The saved panel message is gone — post a new one with `/panel post`.');
  }

  await message.edit({
    embeds: [panelEmbed(interaction.guild)],
    components: panelComponents(config),
  });

  await interaction.editReply({ embeds: [embeds.success(`Panel refreshed in ${channel}.`)] });
}
