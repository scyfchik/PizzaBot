--!strict
--[[
	PizzaBotReporter
	================
	Sends game events to Pizza Bot's ingest endpoint.

	INSTALL
	  1. Put this ModuleScript in ServerScriptService (NOT anywhere a
	     LocalScript can reach it — it holds the shared secret).
	  2. Game Settings → Security → enable "Allow HTTP Requests".
	  3. Store the key with DataStoreService or, simpler, paste it below.
	     It must match GAME_API_KEY in the bot's .env.
	  4. require() it from a Script and call the helpers.

	WHY THIS EXISTS
	  Roblox exposes no API for playtime, level, Robux spent or in-game
	  events. That data lives only on your servers, so the game has to report
	  it. Nothing here is optional decoration — it is the only path by which
	  /player, /game stats and purchase support get any data at all.

	DESIGN NOTES
	  * Events are queued and flushed in batches. One HTTP request per player
	    death would burn your HttpService budget within minutes.
	  * Requests are HMAC-signed. The key never travels, so it cannot be read
	    from a proxy log, and a captured request goes stale in five minutes.
	  * Failed flushes retry with backoff and then drop. Analytics must never
	    be able to hang a game server.
	  * BindToClose flushes the queue on shutdown, which is the only reason
	    session lengths are accurate.
]]

local HttpService = game:GetService("HttpService")
local Players = game:GetService("Players")
local RunService = game:GetService("RunService")

local PizzaBotReporter = {}

-- ===== CONFIGURE ME =========================================================

--- Base URL of the bot's web server, no trailing slash.
local ENDPOINT = "https://tickets.yourdomain.com"

--- Must equal GAME_API_KEY in the bot's .env. Keep it server-side only.
local API_KEY = "replace-me-with-at-least-32-random-characters"

--- Set false to disable reporting without removing the module.
local ENABLED = true

-- ============================================================================

local FLUSH_INTERVAL = 10 -- seconds
local MAX_BATCH = 50 -- must not exceed the bot's limit
local MAX_QUEUE = 500 -- hard cap so a broken endpoint cannot eat memory
local MAX_RETRIES = 3

local queue: { any } = {}
local sessionStart: { [number]: number } = {}

--[[
	HMAC-SHA256.

	Roblox has no built-in HMAC, so this is a compact implementation over
	Luau's string library. If you already have a crypto module, replace this
	and keep the signature format: hex(HMAC(key, timestamp .. "." .. body)).

	Prefer this over the bearer fallback: with a signature the key itself
	never leaves the server.
]]
local function sha256(message: string): string
	local k = {
		0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
		0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
		0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
		0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
		0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
		0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
		0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
		0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
	}

	local h = {
		0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
		0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
	}

	local function rrotate(x: number, n: number): number
		return bit32.bor(bit32.rshift(x, n), bit32.lshift(x, 32 - n))
	end

	local len = #message
	local bitLen = len * 8
	message ..= "\128"
	while (#message % 64) ~= 56 do
		message ..= "\0"
	end
	for i = 7, 0, -1 do
		message ..= string.char(bit32.band(bit32.rshift(bitLen, i * 8), 0xff))
	end

	for chunk = 1, #message, 64 do
		local w = {}
		for i = 0, 15 do
			local o = chunk + i * 4
			w[i] = bit32.bor(
				bit32.lshift(string.byte(message, o), 24),
				bit32.lshift(string.byte(message, o + 1), 16),
				bit32.lshift(string.byte(message, o + 2), 8),
				string.byte(message, o + 3)
			)
		end
		for i = 16, 63 do
			local s0 = bit32.bxor(rrotate(w[i - 15], 7), rrotate(w[i - 15], 18), bit32.rshift(w[i - 15], 3))
			local s1 = bit32.bxor(rrotate(w[i - 2], 17), rrotate(w[i - 2], 19), bit32.rshift(w[i - 2], 10))
			w[i] = bit32.band(w[i - 16] + s0 + w[i - 7] + s1, 0xffffffff)
		end

		local a, b, c, d, e, f, g, hh = h[1], h[2], h[3], h[4], h[5], h[6], h[7], h[8]
		for i = 0, 63 do
			local S1 = bit32.bxor(rrotate(e, 6), rrotate(e, 11), rrotate(e, 25))
			local ch = bit32.bxor(bit32.band(e, f), bit32.band(bit32.bnot(e), g))
			local t1 = bit32.band(hh + S1 + ch + k[i + 1] + w[i], 0xffffffff)
			local S0 = bit32.bxor(rrotate(a, 2), rrotate(a, 13), rrotate(a, 22))
			local maj = bit32.bxor(bit32.band(a, b), bit32.band(a, c), bit32.band(b, c))
			local t2 = bit32.band(S0 + maj, 0xffffffff)

			hh, g, f, e = g, f, e, bit32.band(d + t1, 0xffffffff)
			d, c, b, a = c, b, a, bit32.band(t1 + t2, 0xffffffff)
		end

		h[1] = bit32.band(h[1] + a, 0xffffffff)
		h[2] = bit32.band(h[2] + b, 0xffffffff)
		h[3] = bit32.band(h[3] + c, 0xffffffff)
		h[4] = bit32.band(h[4] + d, 0xffffffff)
		h[5] = bit32.band(h[5] + e, 0xffffffff)
		h[6] = bit32.band(h[6] + f, 0xffffffff)
		h[7] = bit32.band(h[7] + g, 0xffffffff)
		h[8] = bit32.band(h[8] + hh, 0xffffffff)
	end

	local out = ""
	for i = 1, 8 do
		out ..= string.format("%08x", h[i])
	end
	return out
end

local function hmacSha256(key: string, message: string): string
	local blockSize = 64
	if #key > blockSize then
		-- Hash long keys down to 32 bytes, then pad as normal.
		local hashed = sha256(key)
		key = (string.gsub(hashed, "%x%x", function(byte)
			return string.char(tonumber(byte, 16) :: number)
		end))
	end
	key ..= string.rep("\0", blockSize - #key)

	local outer, inner = "", ""
	for i = 1, blockSize do
		local byte = string.byte(key, i)
		outer ..= string.char(bit32.bxor(byte, 0x5c))
		inner ..= string.char(bit32.bxor(byte, 0x36))
	end

	local innerHash = (string.gsub(sha256(inner .. message), "%x%x", function(byte)
		return string.char(tonumber(byte, 16) :: number)
	end))
	return sha256(outer .. innerHash)
end

--- Queue an event. Never yields, never throws — safe to call from anywhere.
function PizzaBotReporter.report(eventType: string, player: Player?, data: { [string]: any }?)
	if not ENABLED or RunService:IsStudio() then
		return
	end

	if #queue >= MAX_QUEUE then
		-- Drop the oldest rather than the newest: recent events are the ones
		-- someone is most likely to be looking for right now.
		table.remove(queue, 1)
	end

	table.insert(queue, {
		type = eventType,
		robloxId = player and tostring(player.UserId) or nil,
		robloxUsername = player and player.Name or nil,
		serverId = game.JobId ~= "" and game.JobId or "studio",
		placeId = tostring(game.PlaceId),
		gameVersion = tostring(game.PlaceVersion),
		occurredAt = DateTime.now():ToIsoDate(),
		data = data or {},
	})
end

local function flush()
	if #queue == 0 then
		return
	end

	local batch = {}
	for _ = 1, math.min(MAX_BATCH, #queue) do
		table.insert(batch, table.remove(queue, 1))
	end

	local body = HttpService:JSONEncode(batch)
	local timestamp = tostring(os.time())
	local signature = hmacSha256(API_KEY, timestamp .. "." .. body)

	for attempt = 1, MAX_RETRIES do
		local ok, response = pcall(function()
			return HttpService:RequestAsync({
				Url = ENDPOINT .. "/api/v1/events",
				Method = "POST",
				Headers = {
					["Content-Type"] = "application/json",
					["X-Timestamp"] = timestamp,
					["X-Signature"] = "sha256=" .. signature,
				},
				Body = body,
			})
		end)

		if ok and response.Success then
			return
		end

		-- A 4xx will not succeed on retry: the key, clock or payload is wrong.
		if ok and response.StatusCode >= 400 and response.StatusCode < 500 then
			warn(("[PizzaBot] ingest rejected (%d): %s"):format(response.StatusCode, response.Body))
			return
		end

		if attempt < MAX_RETRIES then
			task.wait(2 ^ attempt)
		else
			warn("[PizzaBot] ingest failed after retries; dropping " .. #batch .. " event(s)")
		end
	end
end

-- ===== Convenience wrappers =================================================

function PizzaBotReporter.playerJoined(player: Player)
	sessionStart[player.UserId] = os.time()
	PizzaBotReporter.report("player_join", player)
end

function PizzaBotReporter.playerLeft(player: Player, extra: { [string]: any }?)
	local started = sessionStart[player.UserId]
	local minutes = started and math.floor((os.time() - started) / 60) or 0
	sessionStart[player.UserId] = nil

	local data: { [string]: any } = extra or {}
	data.sessionMinutes = minutes
	PizzaBotReporter.report("player_leave", player, data)
end

function PizzaBotReporter.playerDied(player: Player, cause: string?)
	PizzaBotReporter.report("player_death", player, { cause = cause })
end

--- `level` is absolute, not a delta — a replayed event must not ratchet it up.
function PizzaBotReporter.levelUp(player: Player, level: number, xp: number?)
	PizzaBotReporter.report("level_up", player, { level = level, xp = xp })
end

--[[
	Call from ProcessReceipt AFTER granting the product.

	`transactionId` must be receiptInfo.PurchaseId. Roblox retries
	ProcessReceipt until the game returns PurchaseGranted, so the same receipt
	will arrive more than once — the bot deduplicates on this id, which is why
	passing anything else would double-count the Robux.
]]
function PizzaBotReporter.purchaseCompleted(
	player: Player,
	transactionId: string,
	productId: string | number,
	productName: string,
	robuxAmount: number
)
	PizzaBotReporter.report("purchase_completed", player, {
		transactionId = transactionId,
		productId = tostring(productId),
		productName = productName,
		robuxAmount = robuxAmount,
	})
end

function PizzaBotReporter.purchaseFailed(
	player: Player,
	transactionId: string,
	productId: string | number,
	reason: string
)
	PizzaBotReporter.report("purchase_failed", player, {
		transactionId = transactionId,
		productId = tostring(productId),
		failureReason = reason,
	})
end

function PizzaBotReporter.rareItem(player: Player, itemName: string, rarity: string?)
	PizzaBotReporter.report("rare_item", player, { item = itemName, rarity = rarity })
end

function PizzaBotReporter.adminCommand(player: Player, command: string, target: string?)
	PizzaBotReporter.report("admin_command", player, { command = command, target = target })
end

function PizzaBotReporter.error(message: string, context: { [string]: any }?)
	PizzaBotReporter.report("error", nil, { message = message, context = context })
end

-- ===== Lifecycle ============================================================

--- Wire up automatic join/leave/death reporting and the flush loop.
function PizzaBotReporter.start()
	if not ENABLED then
		return
	end

	Players.PlayerAdded:Connect(function(player)
		PizzaBotReporter.playerJoined(player)
		player.CharacterAdded:Connect(function(character)
			local humanoid = character:WaitForChild("Humanoid", 10)
			if humanoid and humanoid:IsA("Humanoid") then
				humanoid.Died:Connect(function()
					PizzaBotReporter.playerDied(player)
				end)
			end
		end)
	end)

	Players.PlayerRemoving:Connect(function(player)
		PizzaBotReporter.playerLeft(player)
	end)

	PizzaBotReporter.report("server_start")

	task.spawn(function()
		while true do
			task.wait(FLUSH_INTERVAL)
			pcall(flush)
		end
	end)

	-- Without this, every session in progress at shutdown loses its playtime.
	game:BindToClose(function()
		for _, player in Players:GetPlayers() do
			PizzaBotReporter.playerLeft(player)
		end
		PizzaBotReporter.report("server_shutdown")
		pcall(flush)
		task.wait(1)
	end)
end

return PizzaBotReporter
