/**
 * Error taxonomy.
 *
 * The interaction handler needs to answer one question when something throws:
 * "can I show this to the user?". `UserError` means yes. Everything else is an
 * internal fault — the user gets a generic message and an incident id, the
 * details go to the operational log and the staff error feed.
 */

/** A problem the user caused and can fix. Message is shown verbatim. */
export class UserError extends Error {
  constructor(message, { ephemeral = true } = {}) {
    super(message);
    this.name = 'UserError';
    this.userFacing = true;
    this.ephemeral = ephemeral;
  }
}

/** The actor lacks the required staff tier or Discord permission. */
export class PermissionError extends UserError {
  constructor(message = 'You do not have permission to use this.') {
    super(message);
    this.name = 'PermissionError';
  }
}

/** The action is valid but not allowed against this target (hierarchy, self, bot). */
export class HierarchyError extends UserError {
  constructor(message = 'You cannot take this action against that member.') {
    super(message);
    this.name = 'HierarchyError';
  }
}

/** A required piece of guild configuration is missing. Shown to staff. */
export class ConfigError extends UserError {
  constructor(key, hint = '') {
    super(`Configuration missing: \`${key}\`.${hint ? ` ${hint}` : ''}`);
    this.name = 'ConfigError';
    this.key = key;
  }
}

/** Something inside the bot failed. Never shown verbatim to a user. */
export class InternalError extends Error {
  constructor(message, cause) {
    super(message, { cause });
    this.name = 'InternalError';
    this.userFacing = false;
  }
}

/** Short, human-quotable id so a user can reference an error in a ticket. */
export function newIncidentId() {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}
