/**
 * Thrown by every Roblox service method until the integration is built.
 *
 * Explicit rather than silent: a method that returns `null` would look like
 * "player not found" and produce confusing behaviour downstream. This makes it
 * obvious that the feature does not exist yet.
 */
export class NotImplementedError extends Error {
  constructor(method) {
    super(
      `${method} is not implemented. The Roblox integration is scaffolded but not built — ` +
        'see src/systems/roblox/README.md.',
    );
    this.name = 'NotImplementedError';
    this.userFacing = false;
  }
}
