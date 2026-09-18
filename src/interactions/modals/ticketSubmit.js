import { MessageFlags } from 'discord.js';
import { getConfig } from '../../config/guildConfig.js';
import { getCategory } from '../../systems/tickets/categories.js';
import { panelComponents } from '../../systems/tickets/components.js';
import { embeds, padNumber } from '../../utils/embeds.js';
import { UserError } from '../../core/errors.js';
import { safeAction } from '../../utils/safeAction.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('ticket-submit');

export const domain = 'ticket';
export const actions = ['submit'];

/** Category modal submitted -> create the ticket. */
export async function execute(interaction, { client, args }) {
  const [categoryKey] = args;
  const category = getCategory(categoryKey);
  if (!category) throw new UserError('That category is no longer available.');

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const responses = category.fields.map((f) => ({
    key: f.key,
    label: f.label,
    value: interaction.fields.getTextInputValue(f.key)?.trim() ?? '',
  }));

  const tickets = client.getSystem('tickets');
  const { ticket, channel } = await tickets.open(
    interaction.guild,
    interaction.user,
    categoryKey,
    responses,
  );

  // Bug reports get a tracked record alongside the ticket, because the bug
  // outlives the conversation. A failure here must not lose the ticket the
  // player just opened, so it is guarded separately.
  let bugReport = null;
  if (category.createsBugReport) {
    const answer = (key) => responses.find((r) => r.key === key)?.value || null;
    try {
      bugReport = await client.getSystem('qa').create(interaction.guild, interaction.user, {
        ticketId: ticket.ticketId,
        robloxUsername: answer('roblox_username'),
        platform: answer('platform'),
        gameVersion: answer('game_version'),
        description: answer('description'),
        reproduction: answer('reproduction'),
      });
    } catch (err) {
      log.error({ err, ticketId: ticket.ticketId }, 'Failed to file bug report for ticket');
    }
  }

  await interaction.editReply({
    embeds: [
      embeds.success(
        `Ticket **#${padNumber(ticket.ticketId)}** opened — head to ${channel}.\n` +
          (bugReport ? `Tracked as bug **#${padNumber(bugReport.bugId)}**.\n` : '') +
          'A staff member will claim it shortly.',
      ),
    ],
  });

  // The panel's select keeps showing the chosen option until the message is
  // edited. Reset it so the next person sees a clean panel.
  if (interaction.message) {
    const config = await getConfig(interaction.guildId);
    await safeAction('reset-panel-select', () =>
      interaction.message.edit({ components: panelComponents(config) }),
    );
  }
}
