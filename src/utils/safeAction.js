import { createLogger } from './logger.js';

const log = createLogger('safe-action');

/**
 * Wrapper for Discord API mutations that are allowed to fail.
 *
 * During an incident the bot may be quarantining twenty accounts; if the third
 * one has a higher role, the other seventeen still need handling. This turns a
 * throw into a logged `{ ok: false }` so a response routine never dies halfway.
 *
 * Use it for side effects. Do NOT use it where the caller needs the result to
 * be correct — swallowing an error there hides real bugs.
 */
export async function safeAction(description, fn) {
  try {
    const value = await fn();
    return { ok: true, value };
  } catch (err) {
    log.warn({ err, action: description }, 'Discord action failed');
    return { ok: false, error: err };
  }
}

/** DMs a user, tolerating closed DMs. Returns whether it landed. */
export async function trySendDM(user, payload) {
  const result = await safeAction(`dm:${user?.id}`, () => user.send(payload));
  return result.ok;
}
