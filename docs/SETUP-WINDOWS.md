# Running the bot on Windows — step by step

Written for a clean Windows 11 machine. Every command goes in **PowerShell**,
run from the project folder (`C:\PizzaBot`) unless stated otherwise.

If anything fails, jump to [Troubleshooting](#troubleshooting) at the bottom —
most first-run problems are one of five things.

---

## 1. Install Node.js

```powershell
winget install OpenJS.NodeJS.LTS
```

**Close and reopen PowerShell** afterwards, or `node` will not be on your PATH
yet. Then check:

```powershell
node --version
npm --version
```

You need **Node 20.10 or newer**. If `node` is still "not recognized" after
reopening the terminal, install manually from <https://nodejs.org> and tick
*Add to PATH* during installation.

---

## 2. Install the project dependencies

```powershell
cd C:\PizzaBot
npm install
```

This takes about a minute and creates `node_modules\`. You only repeat it when
`package.json` changes.

---

## 3. Create the Discord application

1. Go to <https://discord.com/developers/applications> → **New Application**.
   Name it whatever you like; this is not the bot's display name in the server.
2. **Bot** tab → **Reset Token** → **Copy**. You see this value once.
   Keep it out of screenshots, chat messages and commits.
3. Still on the **Bot** tab, scroll to **Privileged Gateway Intents** and enable:
   - **Server Members Intent** — anti-raid and join/leave logging
   - **Message Content Intent** — anti-spam
   
   The bot will not start without these. Discord returns a "disallowed intents"
   error on login.
4. **General Information** tab → copy the **Application ID**.
5. **Installation** (or **OAuth2 → URL Generator**):
   - Scopes: `bot` and `applications.commands`
   - Permissions: `Manage Roles`, `Manage Channels`, `Kick Members`,
     `Ban Members`, `Moderate Members`, `Manage Messages`,
     `Read Message History`, `View Channels`, `Send Messages`, `Embed Links`,
     `Attach Files`, `Manage Webhooks`, `View Audit Log`
   - Open the generated URL and invite the bot to your server.

### Get your own user ID and the server ID

In Discord: **User Settings → Advanced → Developer Mode → On**.
Then right-click your name → **Copy User ID**, and right-click the server icon →
**Copy Server ID**.

---

## 4. Set up MongoDB

Use **MongoDB Atlas** — the free M0 tier is plenty, and it means no database
service running on your PC.

1. <https://www.mongodb.com/cloud/atlas/register> → create a free **M0** cluster.
2. **Database Access** → *Add New Database User*. Username and password, with
   the **Read and write to any database** role. Avoid `@ : / ?` in the
   password — those characters have to be URL-encoded in the connection string.
3. **Network Access** → *Add IP Address*. Use **Add Current IP Address** for
   your own machine. When you deploy to a server later, add that server's IP too.
4. **Database → Connect → Drivers** → copy the connection string. It looks like:

   ```
   mongodb+srv://USER:PASSWORD@cluster0.xxxxx.mongodb.net/?retryWrites=true&w=majority
   ```

5. **Add a database name** before the `?`:

   ```
   mongodb+srv://USER:PASSWORD@cluster0.xxxxx.mongodb.net/pizzabot?retryWrites=true&w=majority
   ```

   Without a database name, Mongo uses `test` and your data ends up somewhere
   confusing.

---

## 5. Create your `.env`

```powershell
Copy-Item .env.example .env
notepad .env
```

Fill in the five values that matter:

```ini
BOT_TOKEN=the token you copied in step 3
CLIENT_ID=the Application ID
GUILD_ID=your server ID
MONGO_URI=the Atlas string with /pizzabot in it
OWNER_IDS=your Discord user ID
```

`OWNER_IDS` is important. It bypasses every permission check and is what lets
you run `/setup` before any staff roles exist. Keep it to one or two people.

> `.env` is in `.gitignore`. Never commit it, paste it, or screenshot it. If the
> token leaks, reset it in the Developer Portal immediately — a leaked bot token
> is a full takeover of the bot.

---

## 6. Check everything before starting

```powershell
npm run doctor
```

This verifies your environment, loads every command and event handler, connects
to MongoDB, logs into Discord briefly, and checks the bot's permissions and role
position. Expect failures on the first run — that is the point.

```powershell
npm run doctor:offline   # skip the Discord login (useful with no internet)
```

Read the report top to bottom and fix every `[ FAIL ]`. Warnings are fine for
now; most of them disappear after step 8.

---

## 7. Register the slash commands

```powershell
npm run deploy
```

Commands are registered to your one guild, so they appear in Discord instantly.
Re-run this whenever a command's name, description or options change — editing
the code alone is not enough.

---

## 8. First start

```powershell
npm start
```

You should see, in order:

```
Starting Pizza Guy's Time bot
MongoDB connected
Commands loaded          count: 14
Interaction handlers loaded
Event handlers bound
Bot is ready             tag: YourBot#1234
```

If you get that far, the bot is online. Stop it with **Ctrl+C** — you should see
`Shutdown complete`.

For development, use `npm run dev` instead: it restarts automatically when you
save a file.

---

## 9. Set it up in Discord

Create these channels first (names are yours to choose):

```
#moderation-logs     warns, kicks, bans, case edits
#security-logs       raid, spam and nuke detections
#ticket-logs         ticket opened / claimed / closed + transcripts
#staff-logs          case edits, voids, appeal decisions
#server-logs         joins, leaves, role and channel changes
#security-alerts     high-severity alerts that need someone now
#support             where the ticket panel lives
```

Also create:
- a **Tickets** category — ticket channels are created inside it
- a **Quarantine** role with *no* permission to send messages or speak

> Closed tickets are **deleted**, not archived — the transcript goes to
> `#ticket-logs` and to the opener's DMs, and the full record stays in MongoDB.
> So there is no archive category to create.

Then, in Discord:

```
/setup
```

It seeds the ten staff ranks, checks the bot's permissions and role position,
and prints a **first-run checklist** with a progress bar. Work through it:

```
/config rank set rank:Moderator role:@Moderator
/config channel set type:Moderation channel:#moderation-logs
/config channel set type:Security channel:#security-logs
/config channel set type:Tickets channel:#ticket-logs
/config channel set type:Staff channel:#staff-logs
/config tickets category:Tickets
/config security alert-channel:#security-alerts quarantine-role:@Quarantine
/panel post channel:#support
```

Re-run `/setup` any time to see what is left. It never overwrites anything.

### Move the bot's role to the top

**Server Settings → Roles** → drag the bot's role above every role it should
moderate, and above the Quarantine role. Discord ignores permissions when role
position says no — this is the single most common cause of "the bot randomly
can't ban people". `npm run doctor` and `/setup` both check for it.

---

## 10. Verify it actually works

1. Open a ticket yourself from the panel in `#support`.
2. Check a channel appeared under the Tickets category and `#ticket-logs` got
   an entry.
3. Click **Claim**, then **Close**, and confirm you receive the transcript by DM.
4. Run `/warn` on an alt account, then `/history` on it.
5. Run `/config view` to confirm everything reads back correctly.

---

## Troubleshooting

**`node` is not recognized**
Reopen PowerShell. PATH changes only apply to new terminals.

**`Used disallowed intents`**
Privileged intents are not enabled. Developer Portal → Bot → turn on **Server
Members Intent** and **Message Content Intent**.

**`An invalid token was provided`**
`BOT_TOKEN` is wrong, has a space or quotes around it, or was reset. Copy it
again from the Developer Portal. It is not the Application ID and not the
client secret.

**`MongoServerSelectionError` / `ECONNREFUSED`**
Your IP is not allowlisted in Atlas (**Network Access**), the password in the
connection string is wrong, or a special character in it needs URL-encoding.

**Slash commands do not appear in Discord**
Run `npm run deploy`. If it succeeds and they still do not show, the bot was
invited without the `applications.commands` scope — re-invite it with both
scopes. Fully restarting the Discord client also helps.

**The bot replies "I cannot take this action against that member"**
Role position. The bot's role must sit above the target's highest role.

**`/setup` says a permission is missing**
Re-invite with the full permission list in step 3, or grant the missing
permission to the bot's role in Server Settings.

**Everything looks fine but nothing gets logged**
Log channels are not configured, or the bot cannot see them. `npm run doctor`
checks both, including per-channel Send Messages and Embed Links.
