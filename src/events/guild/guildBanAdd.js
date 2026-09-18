import { Events, AuditLogEvent } from 'discord.js';
import { Punishment } from '../../database/models/Punishment.js';
import { PunishmentType } from '../../config/constants.js';
import { externalActionEmbed } from '../../systems/logging/serverEvents.js';
import { safeAction } from '../../utils/safeAction.js';

export const name = Events.GuildBanAdd;

/**
 * Catches bans issued outside the bot — Discord's own right-click menu, or
 * another bot. Those never reach `/ban`, so without this the case log silently
 * disagrees with reality.
 */
export async function execute(client, ban) {
  await client.getSystem('antiNuke').onBanAdd(ban);

  // A ban we issued already has a case; do not log it twice.
  const recent = await Punishment.findOne({
    guildId: ban.guild.id,
    userId: ban.user.id,
    type: PunishmentType.BAN,
    createdAt: { $gte: new Date(Date.now() - 15_000) },
  });
  if (recent) return;

  const audit = await safeAction('ban-audit', () =>
    ban.guild.fetchAuditLogs({ type: AuditLogEvent.MemberBanAdd, limit: 5 }),
  );

  const entry = audit.ok
    ? audit.value.entries.find(
        (e) => e.target?.id === ban.user.id && Date.now() - e.createdTimestamp < 15_000,
      )
    : null;

  if (entry?.executor?.id === client.user.id) return;

  await client
    .getSystem('logging')
    .moderation(
      ban.guild.id,
      externalActionEmbed('Ban', ban.user, entry?.executor, entry?.reason ?? ban.reason),
    );
}
