import { Events, ActivityType } from 'discord.js';
import { LogService } from '../../systems/logging/LogService.js';
import { StaffActivityService } from '../../systems/staff/StaffActivityService.js';
import { ModerationService } from '../../systems/moderation/ModerationService.js';
import { TicketManager } from '../../systems/tickets/TicketManager.js';
import { BugReportService } from '../../systems/qa/BugReportService.js';
import { SecurityService } from '../../systems/security/SecurityService.js';
import { AntiSpam } from '../../systems/security/AntiSpam.js';
import { AntiRaid } from '../../systems/security/AntiRaid.js';
import { AntiNuke } from '../../systems/security/AntiNuke.js';
import { Lockdown } from '../../systems/security/Lockdown.js';
import { getConfig } from '../../config/guildConfig.js';
import { ensureIndexes } from '../../database/connection.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('ready');

export const name = Events.ClientReady;
export const once = true;

/**
 * System bootstrap.
 *
 * Systems are constructed here rather than at import time because they need a
 * logged-in client. Wiring them in one place makes the dependency order
 * explicit: logging has no dependencies, moderation and tickets need logging,
 * the detectors need moderation.
 */
export async function execute(client) {
  const logging = client.registerSystem('logging', new LogService(client));

  // Activity counters come before the systems that increment them.
  const activity = client.registerSystem('staffActivity', new StaffActivityService());

  const moderation = client.registerSystem(
    'moderation',
    new ModerationService(client, logging, activity),
  );
  client.registerSystem('tickets', new TicketManager(client, logging, activity));
  client.registerSystem('qa', new BugReportService(client, logging, activity));

  const security = client.registerSystem('security', new SecurityService(client, logging));
  const lockdown = client.registerSystem('lockdown', new Lockdown(client, security));

  client.registerSystem('antiSpam', new AntiSpam(client, security, moderation));
  client.registerSystem('antiRaid', new AntiRaid(client, security, moderation, lockdown));
  client.registerSystem('antiNuke', new AntiNuke(client, security));

  // Kicked off now, not during connect: a build left pending by a failed
  // startup would keep the process alive with nothing to do.
  ensureIndexes();

  // Warm the config cache so the first message of the day does not pay for a
  // database round trip inside the anti-spam hot path.
  for (const guild of client.guilds.cache.values()) {
    await getConfig(guild.id).catch((err) =>
      log.error({ err, guild: guild.id }, 'Failed to load guild config'),
    );
  }

  startTimers(client, moderation, lockdown);

  client.user.setPresence({
    activities: [{ name: 'the server 🍕', type: ActivityType.Watching }],
    status: 'online',
  });

  log.info(
    { tag: client.user.tag, guilds: client.guilds.cache.size, systems: client.systems.size },
    'Bot is ready',
  );
}

function startTimers(client, moderation, lockdown) {
  // Lift expired temp-bans, quarantines and lockdowns.
  client.setManagedInterval(() => moderation.sweepExpired(), 60_000);
  client.setManagedInterval(() => lockdown.sweepExpired(), 60_000);

  // Detector windows hold one key per active user; prune keeps that bounded.
  client.setManagedInterval(() => {
    client.getSystem('antiSpam').prune();
    client.getSystem('antiRaid').prune();
    client.getSystem('antiNuke').prune();
  }, 300_000);
}
