import { Routes } from 'discord.js';
import { env } from '../config/env.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('command-sync');

/**
 * Keep Discord's registered slash commands in step with the code, on startup.
 *
 * ## Why this exists
 *
 * Slash commands live in two places: the code, and Discord's registry. They
 * only match if someone remembers to run `npm run deploy` after every change.
 * When they drift, the bot "stops working" in the worst possible way: old
 * commands still appear in Discord and fail when used, new ones are invisible,
 * and nothing in the logs says why. That is exactly what happened after the
 * command refactor.
 *
 * So on every start the bot compares the two and re-registers only when they
 * actually differ. A normal restart makes one read request and changes nothing.
 *
 * Guild-scoped, so updates are instant. Turn off with AUTO_DEPLOY_COMMANDS=false
 * if another process manages command registration.
 */
export async function syncCommands(client) {
  if (!env.autoDeployCommands) {
    log.info('Command auto-sync disabled (AUTO_DEPLOY_COMMANDS=false)');
    return { changed: false, skipped: true };
  }

  const route = Routes.applicationGuildCommands(env.discord.clientId, env.discord.guildId);
  const local = client.commands.toJSON();

  let live;
  try {
    live = await client.rest.get(route);
  } catch (err) {
    log.error({ err }, 'Could not read registered commands — skipping sync');
    return { changed: false, error: err };
  }

  const diff = compare(local, live);
  if (!diff.changed) {
    log.info({ count: local.length }, 'Slash commands already in sync');
    return { changed: false };
  }

  log.warn(
    { added: diff.added, removed: diff.removed, modified: diff.modified },
    'Slash commands out of sync with the code — re-registering',
  );

  try {
    const result = await client.rest.put(route, { body: local });
    log.info({ count: result.length }, 'Slash commands re-registered');
    return { changed: true, ...diff };
  } catch (err) {
    // A failed sync must not take the bot down: the existing commands still
    // work, and the error names the fix.
    log.error({ err }, 'Failed to re-register slash commands — run `npm run deploy` manually');
    return { changed: false, error: err, ...diff };
  }
}

/**
 * What differs between the code and Discord.
 * Exported for tests.
 */
export function compare(local, live) {
  const localByName = new Map(local.map((c) => [c.name, normalise(c)]));
  const liveByName = new Map(live.map((c) => [c.name, normalise(c)]));

  const added = [...localByName.keys()].filter((n) => !liveByName.has(n)).sort();
  const removed = [...liveByName.keys()].filter((n) => !localByName.has(n)).sort();
  const modified = [...localByName.keys()]
    .filter((n) => liveByName.has(n))
    .filter((n) => JSON.stringify(localByName.get(n)) !== JSON.stringify(liveByName.get(n)))
    .sort();

  return {
    changed: added.length > 0 || removed.length > 0 || modified.length > 0,
    added,
    removed,
    modified,
  };
}

/**
 * Reduce a command to the fields that define its behaviour.
 *
 * Discord echoes a command back with extra fields (id, version, application_id,
 * nsfw, contexts…) and omits defaults the builder sets explicitly (`required:
 * false`). Comparing raw JSON would report a difference on every start and
 * re-register pointlessly, so both sides are projected onto the same shape
 * with the same defaults first.
 */
function normalise(command) {
  return {
    name: command.name,
    description: command.description ?? '',
    type: command.type ?? 1,
    default_member_permissions: command.default_member_permissions ?? null,
    options: normaliseOptions(command.options),
  };
}

/**
 * Discord silently drops the emoji variation selector (U+FE0F) from stored
 * text: "⚖️ Ban Appeal" goes in, "⚖ Ban Appeal" comes back. Without this, a
 * command containing such an emoji is reported as changed on every start and
 * re-registered for nothing — observed live on /tickets.
 */
function stripVariationSelectors(text) {
  return String(text ?? '').replace(/️/g, '');
}

function normaliseOptions(options) {
  if (!options?.length) return [];
  return options.map((o) => ({
    type: o.type,
    name: o.name,
    description: o.description ?? '',
    required: Boolean(o.required),
    autocomplete: Boolean(o.autocomplete),
    min_value: o.min_value ?? null,
    max_value: o.max_value ?? null,
    min_length: o.min_length ?? null,
    max_length: o.max_length ?? null,
    channel_types: o.channel_types ? [...o.channel_types].sort() : [],
    choices: (o.choices ?? []).map((c) => ({ name: stripVariationSelectors(c.name), value: c.value })),
    options: normaliseOptions(o.options),
  }));
}
