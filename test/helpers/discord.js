/**
 * Minimal stand-ins for the Discord objects TicketManager touches.
 *
 * Only the methods the ticket flow actually calls are implemented, and every
 * outgoing message is captured so tests can assert on exactly what would have
 * been posted.
 */
export function makeDiscord({ guildId = '100000000000000002', roblox = null, web = null } = {}) {
  const sent = { channel: [], dms: [], logs: [] };

  const channel = {
    id: 'chan1',
    name: 'bug-000001',
    guild: null,
    async send(payload) {
      sent.channel.push(payload);
      return { id: `msg${sent.channel.length}`, pin: async () => {}, edit: async () => {} };
    },
    delete: async () => {},
    messages: {
      async fetch(arg) {
        // Transcript paging asks for history with an options object.
        if (arg && typeof arg === 'object') return new Map();
        return { edit: async () => {} };
      },
    },
    permissionOverwrites: { edit: async () => {} },
  };

  const guild = {
    id: guildId,
    name: "Pizza Guy's Time",
    roles: { everyone: { id: guildId }, cache: new Map() },
    channels: {
      cache: new Map([['chan1', channel]]),
      create: async (opts) => Object.assign(channel, { name: opts.name }),
    },
  };
  channel.guild = guild;

  const opener = {
    id: '300000000000000001',
    tag: 'Taenny#0001',
    createdAt: new Date('2020-01-01T00:00:00Z'),
    displayAvatarURL: () => 'https://cdn.discordapp.com/avatars/discord.png',
    async send(payload) {
      sent.dms.push(payload);
    },
  };

  const systems = new Map();
  if (roblox) systems.set('roblox', roblox);
  if (web) systems.set('web', web);

  const client = {
    user: { id: '100000000000000001' },
    users: { fetch: async () => opener },
    guilds: { fetch: async () => guild },
    channels: { cache: new Map() },
    systems,
    getSystem: (name) => systems.get(name),
  };

  const logs = {
    async tickets(_guildId, embed, options) {
      sent.logs.push({ embed, options });
      return { id: `log${sent.logs.length}`, url: 'https://discord.com/channels/x/y/z' };
    },
    moderation: async () => null,
    staff: async () => null,
    security: async () => null,
    server: async () => null,
  };

  return { client, guild, channel, opener, logs, sent };
}

/** A fake Roblox service whose players.tryGetProfile returns what you give it. */
export function fakeRoblox(result) {
  const calls = [];
  return {
    calls,
    players: {
      async tryGetProfile(name) {
        calls.push(name);
        return typeof result === 'function' ? result(name) : result;
      },
    },
    game: { configured: false, getStats: async () => null },
  };
}
