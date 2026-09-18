import { ChannelType, PermissionFlagsBits } from 'discord.js';
import { Ticket } from '../../database/models/Ticket.js';
import { User } from '../../database/models/User.js';
import { Punishment } from '../../database/models/Punishment.js';
import { Counter, CounterScope } from '../../database/models/Counter.js';
import { getConfig } from '../../config/guildConfig.js';
import { TicketStatus, Permission, Colors } from '../../config/constants.js';
import { UserError, ConfigError } from '../../core/errors.js';
import { getCategory } from './categories.js';
import {
  ticketHeaderEmbed,
  ticketControls,
  ticketOpenedLog,
  ticketClaimedLog,
  ticketUnclaimedLog,
  ticketClosedLog,
  transcriptButtons,
} from './components.js';
import { generateTranscript, toTranscriptMessages } from './transcript.js';
import { Transcript, generateToken, hashToken } from '../../database/models/Transcript.js';
import { RobloxProfile } from '../../database/models/RobloxProfile.js';
import { embeds, padNumber, field } from '../../utils/embeds.js';
import { safeAction, trySendDM } from '../../utils/safeAction.js';
import { hasPermission } from '../staff/permissions.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('tickets');

/** Grace period between closing a ticket and deleting its channel. */
const DELETE_DELAY_MS = 5000;

/**
 * The ticket's life as a list of moments.
 *
 * Built from the fields the ticket already carries rather than by scanning the
 * message history — it is the same information, but a reader should not have to
 * reconstruct "when was this claimed" by scrolling.
 */
function buildTimeline(ticket) {
  const entries = [
    { at: ticket.createdAt, label: 'Created', actor: ticket.openerTag },
  ];

  if (ticket.claimedAt) {
    entries.push({ at: ticket.claimedAt, label: 'Claimed', actor: ticket.claimedByTag });
  }

  // First response is stored as a duration, so turn it back into a moment.
  if (ticket.firstResponseMs != null && ticket.createdAt) {
    entries.push({
      at: new Date(new Date(ticket.createdAt).getTime() + ticket.firstResponseMs),
      label: 'First staff reply',
      actor: ticket.claimedByTag ?? 'Staff',
    });
  }

  if (ticket.closedAt) {
    entries.push({ at: ticket.closedAt, label: 'Closed', actor: ticket.closedByTag });
  }

  return entries
    .filter((e) => e.at)
    .sort((a, b) => new Date(a.at) - new Date(b.at));
}

/**
 * Messages stored per web transcript.
 *
 * A Mongo document is capped at 16MB. A ticket with thousands of long messages
 * could approach that, and a single oversized document would fail to save and
 * lose the transcript entirely — so the newest N are kept and the viewer says
 * so. The full conversation is still in the HTML file attached to the log.
 */
const WEB_TRANSCRIPT_MESSAGE_CAP = 1000;

/**
 * The ticket workflow.
 *
 *   open -> private channel -> staff claims -> staff handles ->
 *   close confirmation -> transcript saved -> channel deleted
 *
 * The Ticket document is the record; the Discord channel is disposable. Every
 * method here writes the database first and treats Discord as a side effect,
 * because a channel that exists without a matching record is an orphan nobody
 * can find, while a record without a channel is merely a closed ticket.
 */
export class TicketManager {
  constructor(client, logService, staffActivity) {
    this.client = client;
    this.logs = logService;
    this.activity = staffActivity;
  }

  // ------------------------------------------------------------- open

  /**
   * Create a ticket from a submitted modal.
   * `responses` is `[{ key, label, value }]` in the category's field order.
   */
  async open(guild, opener, categoryKey, responses) {
    const config = await getConfig(guild.id);
    const category = getCategory(categoryKey);

    if (!config.tickets?.enabled) throw new UserError('The ticket system is currently disabled.');
    if (!category) throw new UserError('That ticket category no longer exists.');
    if (config.tickets.disabledCategories?.includes(categoryKey)) {
      throw new UserError(`**${category.label}** tickets are closed right now.`);
    }
    if (!config.tickets.categoryId) {
      throw new ConfigError('tickets.categoryId', 'Run `/setup` to pick a ticket category.');
    }

    const profile = await User.ensure(guild.id, opener.id, { username: opener.tag });
    if (profile.flags?.ticketBlocked) {
      throw new UserError('You are blocked from opening tickets. Contact staff directly.');
    }

    const openCount = await Ticket.countDocuments({
      guildId: guild.id,
      openerId: opener.id,
      status: { $ne: TicketStatus.CLOSED },
    });
    if (openCount >= (config.tickets.maxOpenPerUser ?? 2)) {
      throw new UserError(
        `You already have ${openCount} open ticket(s). Please use those before opening another.`,
      );
    }

    // Reserve the number *before* creating anything, so a failure mid-way
    // leaves a gap rather than two tickets sharing a number.
    const ticketId = await Counter.next(CounterScope.ticket(guild.id));

    const channel = await this.#createChannel(guild, config, category, opener, ticketId);

    const ticket = await Ticket.create({
      ticketId,
      guildId: guild.id,
      channelId: channel.id,
      channelName: channel.name,
      openerId: opener.id,
      openerTag: opener.tag,
      category: categoryKey,
      status: TicketStatus.OPEN,
      priority: category.priority,
      responses,
      robloxUsername: responses.find((r) => r.key === 'roblox_username')?.value ?? null,
      lastUserMessageAt: new Date(),
    });

    await User.updateOne({ guildId: guild.id, discordId: opener.id }, { $inc: { 'stats.ticketsOpened': 1 } });

    await this.#postHeader(channel, ticket, opener, config, category);

    await this.logs.tickets(guild.id, ticketOpenedLog(ticket));
    log.info({ ticketId, category: categoryKey, opener: opener.id }, 'Ticket opened');

    return { ticket, channel };
  }

  async #createChannel(guild, config, category, opener, ticketId) {
    const overwrites = [
      { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
      {
        id: this.client.user.id,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ManageChannels,
          PermissionFlagsBits.ManageMessages,
          PermissionFlagsBits.ReadMessageHistory,
          PermissionFlagsBits.AttachFiles,
          PermissionFlagsBits.EmbedLinks,
        ],
      },
      {
        id: opener.id,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory,
          PermissionFlagsBits.AttachFiles,
          PermissionFlagsBits.EmbedLinks,
        ],
      },
    ];

    // Staff access. A category may restrict itself to a single permission node
    // (staff applications contain personal data), otherwise every rank that can
    // claim tickets gets in.
    const node = category.requiredPermission ?? Permission.TICKET_CLAIM;
    for (const rank of config.staffRanks ?? []) {
      const grants = rank.permissions?.includes(Permission.ALL) || rank.permissions?.includes(node);
      if (!grants) continue;
      for (const roleId of rank.roleIds ?? []) {
        if (overwrites.some((o) => o.id === roleId)) continue;
        overwrites.push({
          id: roleId,
          allow: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.ReadMessageHistory,
            PermissionFlagsBits.AttachFiles,
            PermissionFlagsBits.EmbedLinks,
          ],
        });
      }
    }

    if (config.tickets.supportRoleId && !overwrites.some((o) => o.id === config.tickets.supportRoleId)) {
      overwrites.push({
        id: config.tickets.supportRoleId,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory,
        ],
      });
    }

    return guild.channels.create({
      name: `${category.channelPrefix}-${padNumber(ticketId)}`,
      type: ChannelType.GuildText,
      parent: config.tickets.categoryId,
      topic: `Ticket #${padNumber(ticketId)} · ${category.label} · opened by ${opener.tag}`,
      permissionOverwrites: overwrites,
      reason: `Ticket #${padNumber(ticketId)} opened by ${opener.tag}`,
    });
  }

  async #postHeader(channel, ticket, opener, config, category) {
    const header = ticketHeaderEmbed(ticket, opener);

    const ping = config.tickets.supportRoleId ? `<@&${config.tickets.supportRoleId}> ` : '';

    const message = await channel.send({
      content: `${ping}<@${ticket.openerId}>`,
      embeds: [header],
      components: ticketControls(ticket.ticketId),
    });

    ticket.headerMessageId = message.id;
    await ticket.save();

    // Pinned so it stays reachable once the conversation grows.
    await safeAction('pin-ticket-header', () => message.pin());

    // Appeals are judged against history, so put it in front of staff rather
    // than making them run /history elsewhere. Sent as its own message, not a
    // header field: the header is rewritten on every claim and close, and this
    // must not be rebuilt (or silently lost) each time.
    if (category.attachHistory) {
      const cases = await Punishment.find({ guildId: ticket.guildId, userId: opener.id })
        .sort({ createdAt: -1 })
        .limit(5)
        .lean();

      await safeAction('post-case-history', () =>
        channel.send({
          embeds: [
            embeds
              .neutral(`📋 Case history for ${opener.tag}`)
              .setDescription(
                cases.length
                  ? cases
                      .map(
                        (c) =>
                          `\`#${padNumber(c.caseId)}\` **${c.type}** — ${
                            c.reason?.slice(0, 60) ?? ''
                          }${c.active ? '' : ' *(voided)*'}`,
                      )
                      .join('\n')
                  : 'No prior cases on record.',
              ),
          ],
        }),
      );
    }
  }

  /**
   * Rewrite the header message to match the ticket's current state.
   *
   * One method for every state change, so the embed and the buttons can never
   * disagree with the database — the failure mode being a ticket that reads
   * "Waiting for staff" while someone is already working it.
   */
  async refreshHeader(channel, ticket) {
    if (!channel || !ticket.headerMessageId) return false;

    const opener = await this.client.users.fetch(ticket.openerId).catch(() => null);

    const result = await safeAction('refresh-ticket-header', async () => {
      const message = await channel.messages.fetch(ticket.headerMessageId);
      return message.edit({
        embeds: [ticketHeaderEmbed(ticket, opener)],
        components: ticketControls(ticket.ticketId, {
          claimed: Boolean(ticket.claimedBy),
          // Buttons go dead the moment closing starts, not when it finishes.
          closed:
            ticket.status === TicketStatus.CLOSED || ticket.status === TicketStatus.CLOSING,
        }),
      });
    });

    return result.ok;
  }

  // ------------------------------------------------------------- claim

  async claim(ticketId, guildId, staffMember) {
    const ticket = await this.#require(ticketId, guildId);

    if (ticket.status === TicketStatus.CLOSED) throw new UserError('That ticket is already closed.');
    if (ticket.claimedBy === staffMember.id) throw new UserError('You have already claimed this ticket.');
    if (ticket.claimedBy) {
      throw new UserError(`Already claimed by <@${ticket.claimedBy}>. Ask them to hand it over.`);
    }

    ticket.claimedBy = staffMember.id;
    ticket.claimedByTag = staffMember.user.tag;
    ticket.claimedAt = new Date();
    ticket.status = TicketStatus.CLAIMED;
    if (!ticket.handlers.includes(staffMember.id)) ticket.handlers.push(staffMember.id);
    await ticket.save();

    await this.activity?.ticketClaimed(guildId, staffMember);

    await this.logs.tickets(guildId, ticketClaimedLog(ticket, staffMember.user));
    log.info({ ticketId, staff: staffMember.id }, 'Ticket claimed');
    return ticket;
  }

  /**
   * Release a claimed ticket back to the queue.
   *
   * Only the holder or someone with `ticket.manage` may do this — otherwise any
   * staff member could quietly drop a colleague's ticket. `handlers` keeps the
   * previous claimer, so the audit trail survives the release.
   */
  async unclaim(ticketId, guildId, staffMember, { force = false } = {}) {
    const ticket = await this.#require(ticketId, guildId);

    if (ticket.status === TicketStatus.CLOSED) throw new UserError('That ticket is closed.');
    if (!ticket.claimedBy) throw new UserError('That ticket is not claimed by anyone.');
    if (ticket.claimedBy !== staffMember.id && !force) {
      throw new UserError(
        `This ticket is held by <@${ticket.claimedBy}>. ` +
          'Only they, or staff with `ticket.manage`, can release it.',
      );
    }

    ticket.claimedBy = null;
    ticket.claimedByTag = null;
    ticket.claimedAt = null;
    ticket.status = TicketStatus.OPEN;
    await ticket.save();

    await this.activity?.ticketUnclaimed(guildId, staffMember);
    await this.logs.tickets(guildId, ticketUnclaimedLog(ticket, staffMember.user));
    log.info({ ticketId, staff: staffMember.id }, 'Ticket unclaimed');
    return ticket;
  }

  /** Hand a claimed ticket to someone else without losing the audit trail. */
  async transfer(ticketId, guildId, newStaff) {
    const ticket = await this.#require(ticketId, guildId);
    if (ticket.status === TicketStatus.CLOSED) throw new UserError('That ticket is closed.');

    ticket.claimedBy = newStaff.id;
    ticket.claimedByTag = newStaff.user.tag;
    ticket.claimedAt = new Date();
    ticket.status = TicketStatus.CLAIMED;
    if (!ticket.handlers.includes(newStaff.id)) ticket.handlers.push(newStaff.id);
    await ticket.save();
    return ticket;
  }

  // ------------------------------------------------------------- close

  /**
   * Close a ticket.
   *
   * Order matters, because the channel is destroyed at the end and everything
   * worth keeping has to be safe before then:
   *   1. generate the transcript (while the messages still exist)
   *   2. write the outcome to MongoDB
   *   3. DM the transcript to the opener
   *   4. post it to the ticket log
   *   5. delete the channel after a short grace period
   *
   * Each step is independently guarded — a member with closed DMs must not
   * stop the ticket from closing.
   */
  async close(ticketId, guildId, closer, reason, { decision = null, summary = null } = {}) {
    const ticket = await this.#require(ticketId, guildId);
    if (ticket.status === TicketStatus.CLOSED) throw new UserError('That ticket is already closed.');
    // Two people clicking Close within the transcript window would otherwise
    // generate two transcripts and two log entries for one ticket.
    if (ticket.status === TicketStatus.CLOSING) {
      throw new UserError('This ticket is already being closed.');
    }

    const config = await getConfig(guildId);
    const guild = await this.client.guilds.fetch(guildId);
    const channel = ticket.channelId ? guild.channels.cache.get(ticket.channelId) : null;

    // Mark it closing before the slow part. Transcript generation pages through
    // the whole channel history, which on a long ticket takes a few seconds —
    // without this the header still reads "Claimed" while the channel is
    // visibly being torn down, and a second person can click Close again.
    ticket.status = TicketStatus.CLOSING;
    await ticket.save();
    if (channel) await this.refreshHeader(channel, ticket);

    let transcript = null;
    if (config.tickets.transcriptsEnabled && channel) {
      const result = await safeAction('transcript', () => generateTranscript(channel, ticket));
      if (result.ok) transcript = result.value;
    }

    ticket.messageCount = transcript?.messageCount ?? ticket.messageCount ?? 0;
    ticket.status = TicketStatus.CLOSED;
    ticket.closedBy = closer.id;
    ticket.closedByTag = closer.tag ?? closer.user?.tag;
    ticket.closedAt = new Date();
    ticket.closeReason = reason;
    if (decision) ticket.decision = decision;
    if (summary) ticket.summary = summary;
    ticket.resolutionTimeMs = Date.now() - new Date(ticket.createdAt).getTime();
    if (transcript) {
      ticket.transcript = {
        generated: true,
        path: transcript.path,
        messageCount: transcript.messageCount,
      };
    }
    await ticket.save();

    // Web transcript record, built from the same capture. Guarded separately:
    // the HTML file is the fallback, so a failure here must neither stop the
    // ticket closing nor lose the attachment that already exists.
    let links = { viewUrl: null, downloadUrl: null };
    if (transcript && config.tickets.webTranscriptsEnabled !== false) {
      try {
        links = await this.#storeWebTranscript(guild, ticket, transcript, config);
      } catch (err) {
        log.error({ err, ticketId }, 'Failed to store web transcript — falling back to the file');
      }
    }

    const viewerUrl = links.viewUrl;
    const buttons = transcriptButtons(links.viewUrl, links.downloadUrl);

    // The web viewer is the primary route, so the file is attached only when
    // there is no working link — otherwise every closed ticket ships a
    // duplicate copy of data we already stored.
    const attachment = viewerUrl || !transcript ? [] : [transcript.attachment];

    // Let the opener keep a copy — they lose channel access in a moment.
    if (config.tickets.dmTranscriptToUser) {
      const opener = await this.client.users.fetch(ticket.openerId).catch(() => null);
      if (opener) {
        const summary = embeds
          .neutral(`Ticket #${padNumber(ticket.ticketId)} closed`)
          .setColor(Colors.BRAND)
          .addFields(field('Reason', reason))
          .setFooter({ text: guild.name });

        summary.addFields(
          field(
            'Your transcript',
            viewerUrl
              ? 'Open it with the button below.\n*Keep this link private — anyone who has it can read the whole ticket.*'
              : 'Attached to this message as an HTML file.',
          ),
        );

        await trySendDM(opener, {
          embeds: [summary],
          components: buttons,
          files: attachment,
        });
      }
    }

    const logMessage = await this.logs.tickets(guildId, ticketClosedLog(ticket, viewerUrl), {
      components: buttons.length ? buttons : undefined,
      files: attachment.length ? attachment : undefined,
    });
    if (logMessage) {
      ticket.transcript.url = logMessage.url;
      await ticket.save();
    }

    // Credit whoever closed it. The response time only counts when this person
    // is the one who actually answered — crediting a colleague's wait to the
    // staff member who happened to close the ticket makes the metric useless.
    await this.activity?.ticketClosed(
      guildId,
      closer,
      ticket.claimedBy === closer.id ? ticket.firstResponseMs : null,
    );

    if (channel) await this.#deleteChannel(channel, ticket, closer);

    log.info({ ticketId, closer: closer.id }, 'Ticket closed');
    return ticket;
  }

  /**
   * Persist the web transcript and return its private link.
   *
   * The token is generated here and returned in the URL; only its hash is
   * stored. That means this is the one and only moment the plaintext token
   * exists — it goes into the ticket log and the opener's DM, and nowhere else.
   * If both of those are lost, the link is unrecoverable by design.
   */
  async #storeWebTranscript(guild, ticket, transcript, config) {
    const web = this.client.getSystem('web');
    // `listening`, not `enabled`: a configured-but-crashed server must produce
    // the file fallback rather than links that go nowhere.
    if (!web?.listening) return { viewUrl: null, downloadUrl: null };

    const category = getCategory(ticket.category);

    // Staff at the time of writing, so the viewer can badge their messages.
    const staffIds = new Set();
    for (const rank of config.staffRanks ?? []) {
      if (!rank.permissions?.length) continue;
      for (const roleId of rank.roleIds ?? []) {
        const role = guild.roles.cache.get(roleId);
        for (const memberId of role?.members?.keys() ?? []) staffIds.add(memberId);
      }
    }

    const all = toTranscriptMessages(transcript.raw ?? [], staffIds);
    const truncated = all.length > WEB_TRANSCRIPT_MESSAGE_CAP;
    // Keep the most recent, which is where the resolution lives.
    const messages = truncated ? all.slice(-WEB_TRANSCRIPT_MESSAGE_CAP) : all;

    const token = generateToken();
    const expiryDays = config.tickets.transcriptExpiryDays ?? 90;

    await Transcript.create({
      guildId: guild.id,
      ticketId: ticket.ticketId,
      tokenHash: hashToken(token),
      meta: {
        category: ticket.category,
        categoryLabel: category?.label ?? ticket.category,
        guildName: guild.name,
        channelName: ticket.channelName,
        openerId: ticket.openerId,
        openerTag: ticket.openerTag,
        robloxUsername: ticket.robloxUsername,
        claimedBy: ticket.claimedBy,
        claimedByTag: ticket.claimedByTag,
        closedBy: ticket.closedBy,
        closedByTag: ticket.closedByTag,
        closeReason: ticket.closeReason,
        createdAt: ticket.createdAt,
        closedAt: ticket.closedAt,
        firstResponseMs: ticket.firstResponseMs,
        resolutionTimeMs: ticket.resolutionTimeMs,
        decision: ticket.decision,
        summary: ticket.summary,
        responses: ticket.responses,
      },
      timeline: buildTimeline(ticket),
      playerContext: await this.#buildPlayerContext(guild, ticket),
      messages,
      messageCount: all.length,
      truncated,
      // 0 means keep indefinitely; anything else sets the TTL.
      expiresAt: expiryDays > 0 ? new Date(Date.now() + expiryDays * 86_400_000) : null,
    });

    log.info(
      { ticketId: ticket.ticketId, messages: messages.length, truncated },
      'Web transcript stored',
    );

    return { viewUrl: web.buildUrl(token), downloadUrl: web.buildDownloadUrl(token) };
  }

  /**
   * Snapshot the player's standing at close time.
   *
   * Every lookup is guarded individually and the whole thing is best-effort:
   * richer context is nice, but it must never be the reason a transcript fails
   * to save. Missing values render as "unknown" rather than zero, because a
   * confident zero is worse than an honest gap.
   */
  async #buildPlayerContext(guild, ticket) {
    const context = { robloxId: null };

    try {
      const opener = await this.client.users.fetch(ticket.openerId).catch(() => null);
      if (opener) {
        context.accountAgeDays = Math.floor(
          (Date.now() - opener.createdAt.getTime()) / 86_400_000,
        );
      }

      const [previousTickets, activeWarnings, totalPunishments] = await Promise.all([
        Ticket.countDocuments({
          guildId: guild.id,
          openerId: ticket.openerId,
          ticketId: { $ne: ticket.ticketId },
        }),
        Punishment.countDocuments({
          guildId: guild.id,
          userId: ticket.openerId,
          type: 'warn',
          active: true,
        }),
        Punishment.countDocuments({ guildId: guild.id, userId: ticket.openerId }),
      ]);

      Object.assign(context, { previousTickets, activeWarnings, totalPunishments });

      // Game data, when the player is linked and the game has reported them.
      const profile = await RobloxProfile.findOne({ discordId: ticket.openerId }).lean();
      const gameData = this.client.systems.get('gameData');
      if (!gameData) return context;

      const username = profile?.username ?? ticket.robloxUsername;
      const stats = profile?.robloxId
        ? await gameData.getStats(guild.id, profile.robloxId)
        : username
          ? await gameData.findByUsername(guild.id, username)
          : null;

      if (!stats) return context;

      context.robloxId = stats.robloxId;
      context.playtimeMinutes = stats.activity?.playtimeMinutes ?? null;
      context.level = stats.progression?.level ?? null;
      context.robuxSpent = stats.economy?.robuxSpent ?? null;

      const purchases = await gameData.purchases(guild.id, stats.robloxId, 5);
      context.recentPurchases = purchases.map((p) => ({
        productName: p.productName ?? p.productId ?? 'Unknown',
        robuxAmount: p.robuxAmount,
        status: p.status,
        transactionId: p.transactionId,
        purchasedAt: p.purchasedAt,
      }));
    } catch (err) {
      log.warn({ err, ticketId: ticket.ticketId }, 'Could not build full player context');
    }

    return context;
  }

  /**
   * Delete the channel once the record is safe.
   *
   * By this point the transcript is written to disk, attached to the ticket log
   * and DM'd to the opener, and the Ticket document holds everything worth
   * keeping — so the channel itself is disposable. There is no archive
   * category: archived ticket channels pile up forever, and a channel list with
   * two thousand dead tickets in it is worse than useless.
   *
   * The five-second delay exists so whoever is in the channel sees the outcome
   * and can grab anything they still need before it disappears.
   */
  async #deleteChannel(channel, ticket, closer) {
    await safeAction('deletion-notice', () =>
      channel.send({
        embeds: [
          embeds.warning(
            `Transcript saved. This channel will be deleted in **${DELETE_DELAY_MS / 1000} seconds**.`,
          ),
        ],
      }),
    );

    // Not awaited: the interaction that triggered the close has to finish now,
    // not five seconds from now.
    setTimeout(() => {
      safeAction('delete-ticket-channel', () =>
        channel.delete(`Ticket #${padNumber(ticket.ticketId)} closed by ${closer.tag ?? closer.id}`),
      );
    }, DELETE_DELAY_MS).unref?.();
  }

  // ------------------------------------------------------------- misc

  async addNote(ticketId, guildId, author, content) {
    const ticket = await this.#require(ticketId, guildId);
    ticket.notes.push({ authorId: author.id, authorTag: author.tag, content });
    await ticket.save();
    return ticket;
  }

  async addParticipant(ticketId, guildId, member) {
    const ticket = await this.#require(ticketId, guildId);
    const guild = await this.client.guilds.fetch(guildId);
    const channel = guild.channels.cache.get(ticket.channelId);
    if (!channel) throw new UserError('That ticket no longer has a channel.');

    await channel.permissionOverwrites.edit(member.id, {
      ViewChannel: true,
      SendMessages: true,
      ReadMessageHistory: true,
    });

    if (!ticket.participants.includes(member.id)) {
      ticket.participants.push(member.id);
      await ticket.save();
    }
    return ticket;
  }

  /** Resolve the ticket for a channel, or `null` if it is not a ticket channel. */
  findByChannel(channelId) {
    return Ticket.findOne({ channelId });
  }

  async #require(ticketId, guildId) {
    const ticket = await Ticket.findOne({ guildId, ticketId: Number(ticketId) });
    if (!ticket) throw new UserError(`Ticket #${padNumber(ticketId)} does not exist.`);
    return ticket;
  }

  /**
   * Whether a member may act on a ticket. Staff with the node can act on any
   * ticket; the opener can only close their own.
   */
  canManage(staff, ticket, userId, node = Permission.TICKET_CLOSE) {
    if (staff && hasPermission(staff, node)) return true;
    return ticket.openerId === userId;
  }
}
