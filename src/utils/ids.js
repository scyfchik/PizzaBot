import { ID_PREFIX } from '../config/constants.js';

/**
 * Custom ID encoding for buttons, select menus and modals.
 *
 * Format: `pgt:<domain>:<action>:<arg>:<arg>`
 *
 * Discord caps custom IDs at 100 characters and gives no structure, so every
 * project invents an encoding. Having exactly one, parsed in one place, is what
 * lets the interaction router dispatch without every handler doing its own
 * `startsWith` guesswork.
 */

const SEP = ':';

export function buildId(domain, action, ...args) {
  const id = [ID_PREFIX, domain, action, ...args.map(String)].join(SEP);
  if (id.length > 100) {
    throw new Error(`Custom ID exceeds Discord's 100 character limit: ${id}`);
  }
  return id;
}

/** Returns `null` for IDs that are not ours, so foreign components are ignored. */
export function parseId(customId) {
  if (typeof customId !== 'string' || !customId.startsWith(`${ID_PREFIX}${SEP}`)) return null;
  const [, domain, action, ...args] = customId.split(SEP);
  if (!domain || !action) return null;
  return { domain, action, args };
}
