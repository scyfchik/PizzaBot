import { EmbedBuilder } from 'discord.js';
import { BugReport } from '../../database/models/BugReport.js';
import { Counter, CounterScope } from '../../database/models/Counter.js';
import { getConfig } from '../../config/guildConfig.js';
import { BugStatus, BugStatusMeta, Platform, Colors } from '../../config/constants.js';
import { UserError } from '../../core/errors.js';
import { field, padNumber, truncate } from '../../utils/embeds.js';
import { fullTimestamp } from '../../utils/time.js';
import { safeAction } from '../../utils/safeAction.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('qa');

/**
 * Bug report tracking.
 *
 * A bug is not a ticket. The support conversation ends when the channel is
 * deleted; the bug stays open until a build fixes it, and may outlive several
 * conversations. So the two are separate records linked by `ticketId`, and this
 * service owns the lifecycle: OPEN → TESTING → FIXED / REJECTED.
 *
 * The board channel holds one embed per report, kept in sync on every status
 * change, so the QA team has a single place to look instead of scrolling a log.
 */
export class BugReportService {
  constructor(client, logService, staffActivity) {
    this.client = client;
    this.logs = logService;
    this.activity = staffActivity;
  }

  /**
   * File a new report.
   * @param {object} data reporter, robloxUsername, platform, gameVersion,
   *                      description, reproduction, ticketId
   */
  async create(guild, reporter, data) {
    const config = await getConfig(guild.id);
    if (!config.qa?.enabled) throw new UserError('Bug reporting is currently disabled.');

    const bugId = await Counter.next(CounterScope.bug(guild.id));

    const report = await BugReport.create({
      bugId,
      guildId: guild.id,
      ticketId: data.ticketId ?? null,
      reporterId: reporter.id,
      reporterTag: reporter.tag,
      robloxUsername: data.robloxUsername ?? null,
      platform: normalisePlatform(data.platform),
      gameVersion: data.gameVersion || config.qa?.currentVersion || null,
      description: data.description,
      reproduction: data.reproduction ?? null,
      severity: data.severity ?? 'normal',
      status: BugStatus.OPEN,
    });

    await this.#postToBoard(guild, report, config);

    log.info({ bugId, reporter: reporter.id }, 'Bug report filed');
    return report;
  }

  /** Assign a tester and move the report to TESTING. */
  async assign(guildId, bugId, tester) {
    const report = await this.#require(guildId, bugId);
    if (report.status === BugStatus.FIXED || report.status === BugStatus.REJECTED) {
      throw new UserError(`Bug #${padNumber(bugId)} is already ${report.status}.`);
    }

    const previous = report.status;
    report.assignedTester = tester.id;
    report.assignedTesterTag = tester.user?.tag ?? tester.tag;
    report.assignedAt = new Date();
    report.status = BugStatus.TESTING;
    report.history.push({
      from: previous,
      to: BugStatus.TESTING,
      byId: tester.id,
      byTag: report.assignedTesterTag,
      note: 'Assigned',
    });
    await report.save();

    await this.activity?.bugAssigned(guildId, tester);
    await this.#syncBoard(guildId, report);
    return report;
  }

  /**
   * Move a report to a new status.
   * Every transition is appended to `history`, so a bug that was rejected and
   * later reopened does not look like it was always open.
   */
  async setStatus(guildId, bugId, status, actor, note = null) {
    const report = await this.#require(guildId, bugId);
    if (report.status === status) throw new UserError(`Bug #${padNumber(bugId)} is already ${status}.`);

    const previous = report.status;
    report.status = status;
    report.history.push({
      from: previous,
      to: status,
      byId: actor.id,
      byTag: actor.tag ?? actor.user?.tag,
      note,
    });

    if (status === BugStatus.FIXED || status === BugStatus.REJECTED) {
      report.resolvedBy = actor.id;
      report.resolvedAt = new Date();
      report.resolutionNote = note;
      await this.activity?.bugResolved(guildId, actor, status);
    } else {
      // Reopening clears the resolution so the record does not claim it was
      // fixed while it sits in TESTING again.
      report.resolvedBy = null;
      report.resolvedAt = null;
      report.resolutionNote = null;
    }

    await report.save();
    await this.#syncBoard(guildId, report);

    log.info({ bugId, from: previous, to: status, by: actor.id }, 'Bug status changed');
    return report;
  }

  /**
   * Paginated list. Never returns an unbounded set — a year-old board would
   * otherwise pull thousands of documents to render twenty lines.
   */
  async list(guildId, { status = null, tester = null, page = 1, perPage = 10 } = {}) {
    const query = { guildId };
    if (status) query.status = status;
    if (tester) query.assignedTester = tester;

    const [items, total] = await Promise.all([
      BugReport.find(query)
        .sort({ createdAt: -1 })
        .skip((page - 1) * perPage)
        .limit(perPage)
        .lean(),
      BugReport.countDocuments(query),
    ]);

    return { items, total, page, pages: Math.max(1, Math.ceil(total / perPage)) };
  }

  /** Counts per status in one grouped pass, for the QA summary. */
  async counts(guildId) {
    const rows = await BugReport.aggregate([
      { $match: { guildId } },
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]);

    const result = Object.fromEntries(Object.values(BugStatus).map((s) => [s, 0]));
    for (const row of rows) result[row._id] = row.count;
    return result;
  }

  get(guildId, bugId) {
    return BugReport.findOne({ guildId, bugId: Number(bugId) });
  }

  // ------------------------------------------------------------- board

  async #postToBoard(guild, report, config) {
    const channelId = config.qa?.boardChannelId;
    if (!channelId) return;

    const channel = guild.channels.cache.get(channelId);
    if (!channel) {
      log.warn({ guildId: guild.id, channelId }, 'QA board channel missing');
      return;
    }

    // Only critical reports ping by default — a tester role pinged for every
    // cosmetic bug stops being read within a week.
    const shouldPing =
      config.qa.testerRoleId &&
      (!config.qa.pingOnCriticalOnly || report.severity === 'critical');

    const result = await safeAction('post-bug-board', () =>
      channel.send({
        content: shouldPing ? `<@&${config.qa.testerRoleId}>` : undefined,
        embeds: [bugEmbed(report)],
      }),
    );

    if (result.ok) {
      report.boardMessageId = result.value.id;
      await report.save();
    }
  }

  async #syncBoard(guildId, report) {
    if (!report.boardMessageId) return false;

    const config = await getConfig(guildId);
    const channel = this.client.channels.cache.get(config.qa?.boardChannelId);
    if (!channel) return false;

    const result = await safeAction('sync-bug-board', async () => {
      const message = await channel.messages.fetch(report.boardMessageId);
      return message.edit({ embeds: [bugEmbed(report)] });
    });
    return result.ok;
  }

  async #require(guildId, bugId) {
    const report = await BugReport.findOne({ guildId, bugId: Number(bugId) });
    if (!report) throw new UserError(`No bug report #${padNumber(bugId)} on record.`);
    return report;
  }
}

/** Normalise free-text platform input onto the enum, defaulting to Unknown. */
function normalisePlatform(input) {
  if (!input) return Platform.UNKNOWN;
  const value = String(input).trim().toLowerCase();

  if (/pc|windows|mac|desktop|computer/.test(value)) return Platform.PC;
  if (/phone|mobile|android|ios|iphone/.test(value)) return Platform.MOBILE;
  if (/tablet|ipad/.test(value)) return Platform.TABLET;
  if (/xbox|console|playstation|ps[45]/.test(value)) return Platform.CONSOLE;
  if (/vr|quest|oculus/.test(value)) return Platform.VR;

  return Platform.UNKNOWN;
}

/** The board embed. Exported so commands can render a report identically. */
export function bugEmbed(report) {
  const meta = BugStatusMeta[report.status] ?? { label: report.status, color: Colors.NEUTRAL };

  const embed = new EmbedBuilder()
    .setColor(meta.color)
    .setTitle(`🐛 Bug #${padNumber(report.bugId)}`)
    .addFields(
      field('📊 Status', meta.label, true),
      field('🖥️ Platform', report.platform, true),
      field('🏷️ Version', report.gameVersion ?? '*unspecified*', true),
      field('👤 Reporter', `<@${report.reporterId}>`, true),
      field('🎮 Roblox', report.robloxUsername ? `\`${report.robloxUsername}\`` : '*not provided*', true),
      field('🧪 Tester', report.assignedTester ? `<@${report.assignedTester}>` : '*unassigned*', true),
      field('📝 Description', truncate(report.description, 900)),
    )
    .setFooter({ text: `Severity: ${report.severity}` })
    .setTimestamp(report.createdAt ?? new Date());

  if (report.reproduction) {
    embed.addFields(field('🔁 Steps to reproduce', truncate(report.reproduction, 900)));
  }
  if (report.media?.length) {
    embed.addFields(field('📎 Media', report.media.slice(0, 5).join('\n')));
  }
  if (report.resolvedAt) {
    embed.addFields(
      field(
        'Resolution',
        `${meta.label} by <@${report.resolvedBy}> · ${fullTimestamp(report.resolvedAt)}` +
          (report.resolutionNote ? `\n${truncate(report.resolutionNote, 400)}` : ''),
      ),
    );
  }
  if (report.fixedInVersion) {
    embed.addFields(field('Shipped in', report.fixedInVersion, true));
  }

  return embed;
}

/** One line per report, for `/bug list`. */
export function bugLine(report) {
  const meta = BugStatusMeta[report.status] ?? { label: report.status };
  return (
    `${meta.label} \`#${padNumber(report.bugId)}\` ${truncate(report.description, 60)}\n` +
    `└ ${report.platform} · ${report.gameVersion ?? 'no version'}` +
    `${report.assignedTester ? ` · <@${report.assignedTester}>` : ''}`
  );
}
