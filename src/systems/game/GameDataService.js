import { PlayerStats } from '../../database/models/PlayerStats.js';
import { Purchase } from '../../database/models/Purchase.js';
import { GameEvent } from '../../database/models/GameEvent.js';
import { EmbedBuilder } from 'discord.js';
import {
  GameEventType,
  PurchaseStatus,
  ProductType,
  AnticheatSeverity,
  NOTABLE_GAME_EVENTS,
  GAME_EVENT_RETENTION_DAYS,
  Colors,
} from '../../config/constants.js';
import { field, truncate } from '../../utils/embeds.js';

/** Cap on how much a single event's payload may carry into the database. */
const MAX_DATA_BYTES = 4096;

/**
 * Everything the bot knows about what happens inside the game.
 *
 * All of it arrives through `ingest()`, called by the web server's `/api/v1`
 * route — nothing here polls Roblox, because nothing here is available from
 * Roblox. Playtime, level, purchases and deaths exist only on your game
 * servers.
 *
 * Two rules shape this file:
 *
 *   1. **Ingest is idempotent.** Roblox retries `ProcessReceipt` until the game
 *      acknowledges it, and HTTP calls from a game server get retried on
 *      timeout. Every write is therefore an upsert keyed on something stable.
 *   2. **Ingest never trusts its input.** The payload comes from a game server
 *      holding a shared key; a leaked key must not become arbitrary database
 *      writes. Types are coerced, numbers are clamped, and unknown event types
 *      are rejected rather than stored.
 */
export class GameDataService {
  constructor(client, logService) {
    this.client = client;
    this.logs = logService;
  }

  /**
   * Process one reported event.
   * @returns {{ ok: boolean, reason?: string }}
   */
  async ingest(guildId, raw) {
    const type = String(raw?.type ?? '');
    if (!Object.values(GameEventType).includes(type)) {
      return { ok: false, reason: `unknown event type: ${type.slice(0, 40)}` };
    }

    const robloxId = raw.robloxId != null ? String(raw.robloxId).slice(0, 32) : null;
    if (robloxId && !/^\d{1,20}$/.test(robloxId)) {
      return { ok: false, reason: 'robloxId must be numeric' };
    }

    const username = clampString(raw.robloxUsername, 32);
    const occurredAt = parseDate(raw.occurredAt) ?? new Date();

    // Oversized payloads are trimmed rather than rejected: losing one field is
    // better than losing the event, and a runaway payload must not be able to
    // grow the collection without limit.
    let data = raw.data && typeof raw.data === 'object' ? raw.data : {};
    if (Buffer.byteLength(JSON.stringify(data)) > MAX_DATA_BYTES) {
      data = { truncated: true };
    }

    const eventId = clampString(raw.eventId, 64);
    if (eventId && !/^[A-Za-z0-9{}\-_]{8,64}$/.test(eventId)) {
      return { ok: false, reason: 'eventId has an invalid format' };
    }

    const retentionDays = GAME_EVENT_RETENTION_DAYS[type] ?? GAME_EVENT_RETENTION_DAYS.default;

    try {
      await GameEvent.create({
        guildId,
        type,
        eventId,
        robloxId,
        robloxUsername: username,
        serverId: clampString(raw.serverId, 64),
        placeId: clampString(raw.placeId, 32),
        gameVersion: clampString(raw.gameVersion, 32),
        data,
        occurredAt,
        expiresAt: new Date(Date.now() + retentionDays * 86_400_000),
      });
    } catch (err) {
      // Same eventId already stored: a retried batch. Accept it, change nothing,
      // so the game stops retrying and the counters are not inflated.
      if (err?.code === 11000) return { ok: true, duplicate: true };
      throw err;
    }

    if (robloxId) {
      await this.#applyToStats(guildId, robloxId, username, type, raw, occurredAt);
    }

    if (
      type === GameEventType.PURCHASE_COMPLETED ||
      type === GameEventType.PURCHASE_FAILED ||
      type === GameEventType.GAMEPASS_PURCHASED
    ) {
      await this.#recordPurchase(guildId, robloxId, username, type, raw, occurredAt);
    }

    const highAnticheat =
      type === GameEventType.ANTICHEAT_FLAG &&
      normaliseSeverity(raw.data?.severity) === AnticheatSeverity.HIGH;

    if (NOTABLE_GAME_EVENTS.includes(type) || highAnticheat) {
      await this.#notify(guildId, type, username ?? robloxId, raw);
    }

    return { ok: true };
  }

  /** Fold an event into the player's running totals. */
  async #applyToStats(guildId, robloxId, username, type, raw, occurredAt) {
    const inc = {};
    const set = { 'activity.lastSeenAt': occurredAt };
    if (username) set.robloxUsername = username;

    switch (type) {
      case GameEventType.PLAYER_JOIN:
        inc['activity.sessions'] = 1;
        set['activity.currentServerId'] = clampString(raw.serverId, 64);
        break;

      case GameEventType.PLAYER_LEAVE: {
        // The game reports session length; it is the only side that knows it.
        const minutes = clampNumber(raw.data?.sessionMinutes, 0, 1440);
        if (minutes) inc['activity.playtimeMinutes'] = minutes;
        set['activity.currentServerId'] = null;
        break;
      }

      case GameEventType.PLAYER_DEATH:
        inc['combat.deaths'] = 1;
        break;

      case GameEventType.PLAYER_KILL:
        // Reported for the killer only. The victim's death is its own
        // player_death event — counting it here too would double every death.
        inc['combat.kills'] = 1;
        set['combat.lastKillAt'] = occurredAt;
        break;

      case GameEventType.ANTICHEAT_FLAG: {
        const check = normaliseCheckName(raw.data?.check);
        inc['anticheat.flags'] = 1;
        inc[`anticheat.byCheck.${check}`] = 1;
        if (normaliseSeverity(raw.data?.severity) === AnticheatSeverity.HIGH) {
          inc['anticheat.highSeverity'] = 1;
        }
        set['anticheat.lastFlagAt'] = occurredAt;
        set['anticheat.lastCheck'] = check;
        break;
      }

      case GameEventType.LEVEL_UP: {
        // Level is absolute, not incremental — a replayed event must not
        // ratchet someone to level 400.
        const level = clampNumber(raw.data?.level, 0, 1_000_000);
        if (level != null) set['progression.level'] = level;
        const xp = clampNumber(raw.data?.xp, 0, Number.MAX_SAFE_INTEGER);
        if (xp != null) set['progression.xp'] = xp;
        break;
      }

      default:
        break;
    }

    const update = { $set: set, $setOnInsert: { 'activity.firstSeenAt': occurredAt } };
    if (Object.keys(inc).length) update.$inc = inc;

    await PlayerStats.updateOne({ guildId, robloxId }, update, { upsert: true });

    // First flag is set once. Not `$min`: in BSON ordering null sorts before
    // every date, so `$min` against the default null would never replace it.
    if (type === GameEventType.ANTICHEAT_FLAG) {
      await PlayerStats.updateOne(
        { guildId, robloxId, 'anticheat.firstFlagAt': null },
        { $set: { 'anticheat.firstFlagAt': occurredAt } },
      );
    }
  }

  /**
   * Record a transaction.
   *
   * Idempotent on `transactionId`: `upsert` with `$setOnInsert` means a retried
   * receipt updates nothing and, crucially, does not double-count the Robux.
   * The stats increment only runs when the upsert actually inserted.
   */
  async #recordPurchase(guildId, robloxId, username, type, raw, occurredAt) {
    if (!robloxId) return;

    const isGamePass = type === GameEventType.GAMEPASS_PURCHASED;
    const productId = clampString(raw.data?.productId ?? raw.data?.gamePassId, 64);

    // A game pass can only be bought once per player, so player + pass is a
    // natural transaction id — a replayed event cannot record it twice.
    const transactionId = isGamePass
      ? productId && `gamepass:${robloxId}:${productId}`
      : clampString(raw.data?.transactionId ?? raw.transactionId, 128);
    if (!transactionId) return;

    const completed = type !== GameEventType.PURCHASE_FAILED;
    const robux = clampNumber(raw.data?.robuxAmount, 0, 1_000_000) ?? 0;
    const productType = isGamePass ? ProductType.GAMEPASS : normaliseProductType(raw.data?.productType);

    const result = await Purchase.updateOne(
      { guildId, transactionId },
      {
        $setOnInsert: {
          guildId,
          transactionId,
          robloxId,
          robloxUsername: username,
          productId,
          productName: clampString(raw.data?.productName, 120),
          productType,
          robuxAmount: robux,
          status: completed ? PurchaseStatus.COMPLETED : PurchaseStatus.FAILED,
          failureReason: completed ? null : clampString(raw.data?.failureReason, 200),
          purchasedAt: occurredAt,
        },
      },
      { upsert: true },
    );

    // upsertedCount is 1 only on a genuine first insert.
    if (!result.upsertedCount) {
      // Roblox retries ProcessReceipt until it succeeds, so a receipt first
      // reported as failed can later be granted. Promote it — otherwise a
      // purchase appeal would show "not granted" for something the player has.
      // Never the other way: a late failure must not undo a grant.
      if (!completed) return;
      const promoted = await Purchase.updateOne(
        { guildId, transactionId, status: PurchaseStatus.FAILED },
        {
          $set: {
            status: PurchaseStatus.COMPLETED,
            failureReason: null,
            robuxAmount: robux,
            purchasedAt: occurredAt,
            ...(clampString(raw.data?.productName, 120) && { productName: clampString(raw.data?.productName, 120) }),
          },
        },
      );
      if (!promoted.modifiedCount) return;
      await PlayerStats.updateOne(
        { guildId, robloxId },
        {
          $inc: { 'economy.purchaseCount': 1, 'economy.robuxSpent': robux, 'economy.failedPurchaseCount': -1 },
          $set: { 'economy.lastPurchaseAt': occurredAt },
        },
        { upsert: true },
      );
      return;
    }

    const inc = completed
      ? { 'economy.purchaseCount': 1, 'economy.robuxSpent': robux }
      : { 'economy.failedPurchaseCount': 1 };

    await PlayerStats.updateOne(
      { guildId, robloxId },
      { $inc: inc, $set: completed ? { 'economy.lastPurchaseAt': occurredAt } : {} },
      { upsert: true },
    );
  }

  /** Mirror the events staff actually need to see into the log feed. */
  async #notify(guildId, type, who, raw) {
    const colour = type === GameEventType.ERROR ? Colors.DANGER : Colors.WARNING;
    const embed = new EmbedBuilder()
      .setColor(colour)
      .setAuthor({ name: `🎮 Game event · ${type}` })
      .addFields(
        field('Player', who ? String(who) : 'n/a', true),
        field('Server', clampString(raw.serverId, 20) ?? 'n/a', true),
        field('Detail', truncate(JSON.stringify(raw.data ?? {}), 900)),
      )
      .setTimestamp();

    await this.logs.server(guildId, embed);
  }

  // ------------------------------------------------------------- queries

  getStats(guildId, robloxId) {
    return PlayerStats.findOne({ guildId, robloxId: String(robloxId) }).lean();
  }

  findByUsername(guildId, username) {
    return PlayerStats.findOne({
      guildId,
      robloxUsername: new RegExp(`^${escapeRegex(username)}$`, 'i'),
    }).lean();
  }

  purchases(guildId, robloxId, limit = 10, { productType = null, status = null } = {}) {
    const query = { guildId, robloxId: String(robloxId) };
    if (productType) query.productType = productType;
    if (status) query.status = status;
    return Purchase.find(query).sort({ purchasedAt: -1 }).limit(limit).lean();
  }

  /**
   * Purchases per product type and outcome, in one grouped pass.
   * @returns {Promise<Record<string, { granted: number, failed: number, refunded: number, robux: number }>>}
   */
  async purchaseBreakdown(guildId, robloxId) {
    const rows = await Purchase.aggregate([
      { $match: { guildId, robloxId: String(robloxId) } },
      {
        $group: {
          _id: { type: '$productType', status: '$status' },
          count: { $sum: 1 },
          robux: { $sum: '$robuxAmount' },
        },
      },
    ]);

    const out = {};
    for (const { _id, count, robux } of rows) {
      const bucket = (out[_id.type] ??= { granted: 0, failed: 0, refunded: 0, robux: 0 });
      if (_id.status === PurchaseStatus.COMPLETED) {
        bucket.granted += count;
        bucket.robux += robux;
      } else if (_id.status === PurchaseStatus.FAILED) {
        bucket.failed += count;
      } else if (_id.status === PurchaseStatus.REFUNDED) {
        bucket.refunded += count;
      }
    }
    return out;
  }

  /** Individual anticheat flags, newest first — the evidence behind the totals. */
  anticheatFlags(guildId, robloxId, limit = 15) {
    return GameEvent.find({
      guildId,
      robloxId: String(robloxId),
      type: GameEventType.ANTICHEAT_FLAG,
    })
      .sort({ occurredAt: -1 })
      .limit(limit)
      .lean();
  }

  /** Top players by a stat, for leaderboards. `field` is whitelisted. */
  leaderboard(guildId, field, limit = 10) {
    const allowed = {
      kills: 'combat.kills',
      playtime: 'activity.playtimeMinutes',
      spend: 'economy.robuxSpent',
      flags: 'anticheat.flags',
    };
    const path = allowed[field];
    if (!path) throw new Error(`Unknown leaderboard field: ${field}`);
    return PlayerStats.find({ guildId, [path]: { $gt: 0 } })
      .sort({ [path]: -1 })
      .limit(limit)
      .lean();
  }

  /** Spend summary in one grouped pass rather than summing in JavaScript. */
  async economySummary(guildId, robloxId) {
    const rows = await Purchase.aggregate([
      { $match: { guildId, robloxId: String(robloxId) } },
      { $group: { _id: '$status', count: { $sum: 1 }, robux: { $sum: '$robuxAmount' } } },
    ]);

    const summary = { completed: 0, failed: 0, refunded: 0, robuxSpent: 0, robuxRefunded: 0 };
    for (const row of rows) {
      if (row._id === PurchaseStatus.COMPLETED) {
        summary.completed = row.count;
        summary.robuxSpent = row.robux;
      } else if (row._id === PurchaseStatus.FAILED) {
        summary.failed = row.count;
      } else if (row._id === PurchaseStatus.REFUNDED) {
        summary.refunded = row.count;
        summary.robuxRefunded = row.robux;
      }
    }
    return summary;
  }

  recentEvents(guildId, { robloxId = null, type = null, limit = 15 } = {}) {
    const query = { guildId };
    if (robloxId) query.robloxId = String(robloxId);
    if (type) query.type = type;

    return GameEvent.find(query).sort({ occurredAt: -1 }).limit(limit).lean();
  }

  /**
   * Live-ish server statistics.
   *
   * "Online" means the game reported a join and has not reported the matching
   * leave. A crashed server never sends its leaves, so this is an upper bound —
   * the 15-minute window keeps a crash from inflating it forever.
   */
  async serverStats(guildId) {
    const since = new Date(Date.now() - 15 * 60_000);
    const dayAgo = new Date(Date.now() - 86_400_000);

    const [online, servers, activeToday, purchasesToday, failuresToday, totals] = await Promise.all([
      PlayerStats.countDocuments({
        guildId,
        'activity.currentServerId': { $ne: null },
        'activity.lastSeenAt': { $gte: since },
      }),
      GameEvent.distinct('serverId', { guildId, occurredAt: { $gte: since }, serverId: { $ne: null } }),
      PlayerStats.countDocuments({ guildId, 'activity.lastSeenAt': { $gte: dayAgo } }),
      Purchase.countDocuments({ guildId, status: PurchaseStatus.COMPLETED, purchasedAt: { $gte: dayAgo } }),
      Purchase.countDocuments({ guildId, status: PurchaseStatus.FAILED, purchasedAt: { $gte: dayAgo } }),
      PlayerStats.aggregate([
        { $match: { guildId } },
        {
          $group: {
            _id: null,
            players: { $sum: 1 },
            playtime: { $sum: '$activity.playtimeMinutes' },
            robux: { $sum: '$economy.robuxSpent' },
          },
        },
      ]),
    ]);

    return {
      online,
      servers: servers.length,
      activeToday,
      purchasesToday,
      failuresToday,
      totalPlayers: totals[0]?.players ?? 0,
      totalPlaytimeMinutes: totals[0]?.playtime ?? 0,
      totalRobux: totals[0]?.robux ?? 0,
      /** True when nothing has ever been reported — the commands say so. */
      empty: (totals[0]?.players ?? 0) === 0,
    };
  }

  /** Has this guild ever received game data? Drives the "not connected" notice. */
  async hasData(guildId) {
    return (await GameEvent.countDocuments({ guildId }).limit(1)) > 0;
  }
}

function clampString(value, max) {
  if (value == null) return null;
  const str = String(value).trim();
  return str ? str.slice(0, max) : null;
}

function clampNumber(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.min(Math.max(n, min), max);
}

function parseDate(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  // A game clock skewed a year into the future would poison every "recent"
  // query, so anything implausible falls back to server time.
  const now = Date.now();
  if (date.getTime() > now + 300_000 || date.getTime() < now - 30 * 86_400_000) return null;
  return date;
}

/**
 * Anticheat check names become part of a Mongo field path
 * (`anticheat.byCheck.<name>`), so anything that could be read as an operator
 * or a nested path — `$`, `.` — must never reach the database.
 */
function normaliseCheckName(value) {
  const clean = String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
  return clean || 'unknown';
}

function normaliseSeverity(value) {
  const v = String(value ?? '').toLowerCase();
  return Object.values(AnticheatSeverity).includes(v) ? v : AnticheatSeverity.LOW;
}

/** Unknown product types are stored as developer products rather than rejected. */
function normaliseProductType(value) {
  const v = String(value ?? '').toLowerCase();
  return Object.values(ProductType).includes(v) ? v : ProductType.DEVELOPER_PRODUCT;
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
