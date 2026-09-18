# Connecting your Roblox game to Pizza Bot

## Why this is necessary

**Roblox has no API for the data Pizza Bot's player analytics need.** Playtime,
level, Robux spent, purchase history, deaths, in-game bans — none of it is
queryable from outside your experience. It exists only on your game servers.

What Roblox *does* expose publicly is username → ID, account creation date,
avatar and group rank. Everything else in `/player profile`, `/player economy`,
`/player purchases` and `/game stats` arrives because **your game sends it**.

So the integration is a push, not a pull:

```
  Roblox game server
        │  HttpService:RequestAsync, batched every 10s, HMAC-signed
        ▼
  POST https://your-bot-host/api/v1/events
        │
        ▼
  Pizza Bot  ──►  GameEvent   (raw audit trail, expires after 30 days)
                  PlayerStats (running totals: playtime, level, spend)
                  Purchase    (one row per transaction, deduplicated)
```

Until this is set up, those commands honestly report "no game data" rather than
showing zeroes.

---

## 1. Bot side

Generate a key. It must be at least 32 characters:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

Add to `.env`:

```ini
WEB_ENABLED=true
WEB_PORT=3000
WEB_HOST=127.0.0.1
WEB_BASE_URL=https://tickets.yourdomain.com
GAME_API_KEY=<the key you just generated>
```

Restart the bot, then check in Discord:

```
/game connection
```

It reports whether the web server is running, whether a key is configured, and
whether anything has ever arrived.

> **The endpoint must be reachable from Roblox.** `WEB_HOST=127.0.0.1` means
> loopback only — correct when nginx or Caddy sits in front terminating TLS,
> which is what you want. Roblox refuses plain-HTTP requests to some hosts and
> your transcripts and game data both deserve TLS regardless.

---

## 2. Game side

1. Copy [`roblox/PizzaBotReporter.lua`](../roblox/PizzaBotReporter.lua) into
   **ServerScriptService** as a ModuleScript.
2. **Game Settings → Security → Allow HTTP Requests: on.**
3. Edit the three values at the top: `ENDPOINT`, `API_KEY`, `ENABLED`.
4. From a Script in ServerScriptService:

```lua
local PizzaBot = require(game.ServerScriptService.PizzaBotReporter)
PizzaBot.start()
```

That alone gives you joins, leaves, playtime, deaths and server lifecycle.

> **The key is a server secret.** Anything a LocalScript can read, a player can
> read. Keep the module in ServerScriptService and never require it from the
> client.

### Reporting purchases

This is the part that makes purchase-support tickets answerable, so it is worth
doing properly. Call it from `ProcessReceipt` **after** granting the product:

```lua
local MarketplaceService = game:GetService("MarketplaceService")
local PizzaBot = require(game.ServerScriptService.PizzaBotReporter)

MarketplaceService.ProcessReceipt = function(receiptInfo)
    local player = game.Players:GetPlayerByUserId(receiptInfo.PlayerId)
    if not player then
        return Enum.ProductPurchaseDecision.NotProcessedYet
    end

    local ok, err = pcall(function()
        grantProduct(player, receiptInfo.ProductId)   -- your own function
    end)

    if not ok then
        PizzaBot.purchaseFailed(
            player,
            tostring(receiptInfo.PurchaseId),
            receiptInfo.ProductId,
            tostring(err)
        )
        return Enum.ProductPurchaseDecision.NotProcessedYet
    end

    PizzaBot.purchaseCompleted(
        player,
        tostring(receiptInfo.PurchaseId),   -- the deduplication key
        receiptInfo.ProductId,
        productNameFor(receiptInfo.ProductId),
        receiptInfo.CurrencySpent
    )

    return Enum.ProductPurchaseDecision.PurchaseGranted
end
```

**`receiptInfo.PurchaseId` matters.** Roblox calls `ProcessReceipt` repeatedly
until the game returns `PurchaseGranted`, so the same receipt *will* arrive more
than once. The bot deduplicates on that id — pass anything else and you will
double-count the Robux.

### Other events

```lua
PizzaBot.levelUp(player, 12, 3400)          -- level is absolute, not a delta
PizzaBot.rareItem(player, "Golden Oven", "legendary")
PizzaBot.adminCommand(admin, ":kill", target.Name)
PizzaBot.error("DataStore write failed", { key = "player_123" })
```

Anything else:

```lua
PizzaBot.report("player_death", player, { cause = "lava" })
```

Only the event types the bot knows are accepted; anything else is rejected at
the boundary rather than stored.

---

## 3. Verify it

```
/game connection     is the pipe open, and when did something last arrive
/game events         the raw feed
/game stats          aggregates
/player profile roblox:SomeUsername
```

A player who has been reported shows playtime, level and spend. One who has not
shows *"No game data"* — which is the honest answer, not a bug.

---

## Security

| Control | Why |
|---|---|
| HMAC-SHA256 over `timestamp . body` | The key never travels, so a proxy log cannot leak it, and the body cannot be altered in flight. |
| 5-minute timestamp window | A captured request cannot be replayed tomorrow. |
| 32-character minimum key | Refused at startup otherwise. |
| 120 requests/min per IP | A runaway game loop cannot flood the database. |
| 256KB body, 50 events per batch | Bounded memory on the receiving side. |
| Every field coerced and clamped | A leaked key must not become arbitrary writes. Unknown event types are rejected; numbers are range-limited; oversized payloads are trimmed. |
| Purchases deduplicated on `transactionId` | Retries and replays cannot inflate revenue figures. |

A bearer-token fallback exists (`GAME_ALLOW_BEARER=true`) because signing in
Luau is fiddly. It is **strictly weaker** — anything that observes the request
observes the key — and it is off by default. Use it only over HTTPS, and prefer
the signature.

### If the key leaks

An attacker can write plausible-looking game events. They **cannot** read
anything, reach Discord, or touch tickets, moderation or transcripts — the
endpoint is write-only and validates every field. Rotate `GAME_API_KEY`,
restart, update the module. Bogus events expire from `GameEvent` after 30 days,
but corrupted `PlayerStats` totals do not self-heal; tell me and I will add a
recompute command.

---

## Cost and limits

Roblox allows roughly **500 HTTP requests per minute per server**. The module
batches every 10 seconds, so a normal server uses ~6 requests/minute regardless
of player count. You have plenty of headroom; do not call `flush()` yourself in
a loop.

`GameEvent` expires after 30 days by design — it is an audit trail, not the
source of the aggregates. `PlayerStats` and `Purchase` are permanent.
