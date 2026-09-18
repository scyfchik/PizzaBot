import { Events, MessageFlags } from 'discord.js';
import { resolveStaff, requirePermission } from '../../systems/staff/permissions.js';
import { UserError, newIncidentId } from '../../core/errors.js';
import { embeds } from '../../utils/embeds.js';
import { formatDuration } from '../../utils/time.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('interaction');

export const name = Events.InteractionCreate;

/**
 * The single entry point for everything a user clicks or types.
 *
 * Responsibilities, in order: route, gate, execute, and make sure the user
 * always gets *some* reply. An interaction that is never answered shows
 * "application did not respond", which reads as "the bot is broken" even when
 * only one command failed.
 */
export async function execute(client, interaction) {
  try {
    if (interaction.isChatInputCommand()) return await handleCommand(client, interaction);
    if (interaction.isAutocomplete()) return await handleAutocomplete(client, interaction);
    if (interaction.isButton() || interaction.isAnySelectMenu() || interaction.isModalSubmit()) {
      return await handleComponent(client, interaction);
    }
  } catch (err) {
    await reportError(interaction, err);
  }
}

async function handleCommand(client, interaction) {
  const command = client.commands.get(interaction.commandName);
  if (!command) {
    log.warn({ command: interaction.commandName }, 'Unknown command invoked');
    return respond(interaction, embeds.error('That command no longer exists. Try re-deploying.'));
  }

  const meta = command.meta ?? {};

  if (meta.guildOnly !== false && !interaction.inGuild()) {
    return respond(interaction, embeds.error('This command only works inside the server.'));
  }

  // Permission gate. Commands declare a node; the check cannot be forgotten
  // inside a handler body because it happens before `execute` is ever called.
  let staff = null;
  if (interaction.inGuild()) {
    staff = await resolveStaff(interaction.member);
    if (meta.permission) requirePermission(staff, meta.permission);
  }

  const remaining = client.commands.checkCooldown(
    interaction.user.id,
    interaction.commandName,
    meta.cooldown,
  );
  if (remaining > 0) {
    return respond(
      interaction,
      embeds.warning(`Slow down — try again in ${formatDuration(remaining) || '1s'}.`),
    );
  }

  log.debug(
    { command: interaction.commandName, user: interaction.user.id },
    'Executing command',
  );
  await command.execute(interaction, { client, staff });
}

async function handleAutocomplete(client, interaction) {
  const command = client.commands.get(interaction.commandName);
  if (!command?.autocomplete) return interaction.respond([]);
  try {
    await command.autocomplete(interaction, { client });
  } catch (err) {
    log.warn({ err, command: interaction.commandName }, 'Autocomplete failed');
    if (!interaction.responded) await interaction.respond([]);
  }
}

async function handleComponent(client, interaction) {
  const route = client.interactions.resolve(interaction.customId);
  // Not ours — another bot's component in a shared channel. Ignore silently.
  if (!route) return;

  const staff = interaction.inGuild() ? await resolveStaff(interaction.member) : null;
  await route.execute(interaction, { client, staff, args: route.args });
}

/** Reply or follow up, whichever the interaction's state allows. */
async function respond(interaction, embed, { ephemeral = true } = {}) {
  const payload = { embeds: [embed] };
  if (ephemeral) payload.flags = MessageFlags.Ephemeral;

  if (interaction.deferred) return interaction.editReply({ embeds: [embed] });
  if (interaction.replied) return interaction.followUp(payload);
  return interaction.reply(payload);
}

/**
 * Turn a thrown error into something the user can read.
 *
 * `UserError` is shown verbatim — the user caused it and can fix it. Anything
 * else is a bug: the user gets a generic message plus a short incident ID they
 * can quote in a ticket, and the details go to the operational log.
 */
async function reportError(interaction, err) {
  if (err instanceof UserError || err?.userFacing) {
    return respond(interaction, embeds.error(err.message)).catch(() => {});
  }

  const incidentId = newIncidentId();
  log.error(
    {
      err,
      incidentId,
      user: interaction.user?.id,
      customId: interaction.customId,
      command: interaction.commandName,
    },
    'Unhandled interaction error',
  );

  return respond(
    interaction,
    embeds.error(
      `Something went wrong on our end. Quote incident \`${incidentId}\` if you report this.`,
    ),
  ).catch(() => {});
}
