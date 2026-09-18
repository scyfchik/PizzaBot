import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client, GatewayIntentBits, Partials, Collection } from 'discord.js';
import { CommandRegistry } from './CommandRegistry.js';
import { InteractionRouter } from './InteractionRouter.js';
import { loadEvents } from './EventRegistry.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('client');
const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The bot client.
 *
 * Extends discord.js `Client` with the registries and systems every handler
 * needs, so nothing has to reach for a module-level singleton. `client` is
 * passed explicitly into commands and events — that keeps the dependency graph
 * visible and makes handlers testable in isolation.
 */
export class PizzaClient extends Client {
  constructor() {
    super({
      intents: [
        GatewayIntentBits.Guilds, // channels, roles, command routing
        GatewayIntentBits.GuildMembers, // joins/leaves — anti-raid (privileged)
        GatewayIntentBits.GuildMessages, // message events
        GatewayIntentBits.MessageContent, // anti-spam content checks (privileged)
        GatewayIntentBits.GuildModeration, // ban add/remove — anti-nuke
      ],
      partials: [
        // Without these, events on uncached objects are silently dropped —
        // which for a moderation bot means missing the things that matter most.
        Partials.Channel,
        Partials.Message,
        Partials.GuildMember,
        Partials.User,
      ],
      allowedMentions: { parse: ['users', 'roles'], repliedUser: false },
    });

    this.commands = new CommandRegistry();
    this.interactions = new InteractionRouter();

    /** Systems attach themselves here during boot. */
    this.systems = new Collection();

    /** Timers registered by systems, cleared on shutdown. */
    this.timers = new Set();
  }

  async loadAll() {
    await this.commands.load(join(SRC, 'commands'));
    await this.interactions.load(join(SRC, 'interactions'));
    await loadEvents(this, join(SRC, 'events'));
  }

  registerSystem(name, system) {
    this.systems.set(name, system);
    return system;
  }

  getSystem(name) {
    const system = this.systems.get(name);
    if (!system) throw new Error(`System not registered: ${name}`);
    return system;
  }

  /** Interval that is automatically cleared on shutdown. */
  setManagedInterval(fn, ms) {
    const timer = setInterval(() => {
      Promise.resolve(fn()).catch((err) => log.error({ err }, 'Managed interval threw'));
    }, ms);
    timer.unref?.();
    this.timers.add(timer);
    return timer;
  }

  async shutdown() {
    for (const timer of this.timers) clearInterval(timer);
    this.timers.clear();

    // Any system exposing a `stop()` is holding an external resource — right
    // now that is the transcript HTTP server, whose open sockets would keep the
    // process alive well past shutdown.
    for (const [name, system] of this.systems) {
      if (typeof system.stop !== 'function') continue;
      try {
        await system.stop();
      } catch (err) {
        log.warn({ err, system: name }, 'System failed to stop cleanly');
      }
    }

    await this.destroy();
    log.info('Client destroyed');
  }
}
