import { SlashCommandBuilder, PermissionFlagsBits, MessageFlags, EmbedBuilder } from 'discord.js';
import { Changelog } from '../../database/models/Changelog.js';
import { BugReport } from '../../database/models/BugReport.js';
import { getConfig } from '../../config/guildConfig.js';
import { Permission, Colors, Emojis, BugStatus } from '../../config/constants.js';
import { embeds, field, truncate } from '../../utils/embeds.js';
import { fullTimestamp } from '../../utils/time.js';
import { UserError } from '../../core/errors.js';
import { safeAction } from '../../utils/safeAction.js';

/**
 * Game update announcements.
 *
 * Stored as well as posted, for two reasons: the announcement can be corrected
 * and re-rendered from the record instead of being deleted and re-posted, and
 * `BugReport.fixedInVersion` can point at a version that actually exists.
 *
 * Bullet lists are entered as newline- or `|`-separated text in one option,
 * because Discord slash commands cannot take a repeating field and a modal
 * would cap out at five inputs.
 */
export const data = new SlashCommandBuilder()
  .setName('changelog')
  .setDescription('Publish and browse game updates')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addSubcommand((sub) =>
    sub
      .setName('publish')
      .setDescription('Announce a new game update')
      .addStringOption((o) =>
        o.setName('version').setDescription('e.g. 0.5.0').setRequired(true).setMaxLength(32),
      )
      .addStringOption((o) =>
        o.setName('new').setDescription('New features — separate with | or new lines').setMaxLength(1500),
      )
      .addStringOption((o) =>
        o.setName('fixed').setDescription('Fixes — separate with | or new lines').setMaxLength(1500),
      )
      .addStringOption((o) =>
        o.setName('changed').setDescription('Changes — separate with | or new lines').setMaxLength(1500),
      )
      .addStringOption((o) => o.setName('title').setDescription('Optional headline').setMaxLength(100))
      .addStringOption((o) => o.setName('credits').setDescription('Who worked on it').setMaxLength(300))
      .addStringOption((o) => o.setName('image').setDescription('Banner image URL').setMaxLength(500))
      .addStringOption((o) =>
        o
          .setName('closes-bugs')
          .setDescription('Bug numbers this fixes, comma separated — marks them FIXED')
          .setMaxLength(200),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('view')
      .setDescription('Show a published update')
      .addStringOption((o) => o.setName('version').setDescription('Defaults to the latest')),
  )
  .addSubcommand((sub) =>
    sub
      .setName('list')
      .setDescription('Recent updates')
      .addIntegerOption((o) => o.setName('limit').setDescription('Default 10').setMinValue(1).setMaxValue(25)),
  );

export const meta = {
  permission: Permission.CHANGELOG_PUBLISH,
  cooldown: 5,
};

export async function execute(interaction) {
  const sub = interaction.options.getSubcommand();

  if (sub === 'publish') return publish(interaction);
  if (sub === 'view') return view(interaction);
  return list(interaction);
}

/** Split a bullet option into lines, tolerating both separators. */
function bullets(value) {
  if (!value) return [];
  return value
    .split(/[\n|]+/)
    .map((line) => line.trim().replace(/^[-•*]\s*/, ''))
    .filter(Boolean)
    .slice(0, 25);
}

async function publish(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const version = interaction.options.getString('version').trim();
  const added = bullets(interaction.options.getString('new'));
  const fixed = bullets(interaction.options.getString('fixed'));
  const changed = bullets(interaction.options.getString('changed'));

  if (!added.length && !fixed.length && !changed.length) {
    throw new UserError('An update needs at least one entry in **new**, **fixed** or **changed**.');
  }

  const existing = await Changelog.findOne({ guildId: interaction.guildId, version });
  if (existing) {
    throw new UserError(
      `Version **${version}** has already been published. Pick a different version string.`,
    );
  }

  const config = await getConfig(interaction.guildId);
  const channelId = config.changelog?.channelId;
  if (!channelId) {
    throw new UserError('No changelog channel set. Use `/config changelog channel:#updates` first.');
  }

  const channel = await interaction.guild.channels.fetch(channelId).catch(() => null);
  if (!channel) throw new UserError('The configured changelog channel no longer exists.');

  // Resolve the bugs first: publishing an update that claims to fix bug #42
  // when #42 does not exist should fail before the announcement goes out.
  const bugIds = (interaction.options.getString('closes-bugs') ?? '')
    .split(/[,\s]+/)
    .map((v) => Number(v.replace('#', '')))
    .filter((n) => Number.isInteger(n) && n > 0);

  if (bugIds.length) {
    const found = await BugReport.countDocuments({ guildId: interaction.guildId, bugId: { $in: bugIds } });
    if (found !== bugIds.length) {
      throw new UserError(`Some of those bug numbers do not exist: ${bugIds.join(', ')}`);
    }
  }

  const entry = await Changelog.create({
    guildId: interaction.guildId,
    version,
    title: interaction.options.getString('title'),
    added,
    fixed,
    changed,
    credits: interaction.options.getString('credits') ?? config.changelog?.defaultCredits ?? null,
    imageUrl: interaction.options.getString('image'),
    authorId: interaction.user.id,
    authorTag: interaction.user.tag,
    channelId,
    closedBugIds: bugIds,
  });

  const ping = config.changelog?.pingRoleId ? `<@&${config.changelog.pingRoleId}>` : undefined;
  const result = await safeAction('publish-changelog', () =>
    channel.send({ content: ping, embeds: [changelogEmbed(entry)] }),
  );

  if (!result.ok) {
    // The record is useless without the announcement, so do not leave a ghost.
    await Changelog.deleteOne({ _id: entry._id });
    throw new UserError(`Could not post to ${channel} — check my permissions there.`);
  }

  entry.messageId = result.value.id;
  entry.publishedAt = new Date();
  await entry.save();

  if (bugIds.length) {
    await BugReport.updateMany(
      { guildId: interaction.guildId, bugId: { $in: bugIds } },
      {
        $set: {
          status: BugStatus.FIXED,
          fixedInVersion: version,
          resolvedBy: interaction.user.id,
          resolvedAt: new Date(),
          resolutionNote: `Shipped in ${version}`,
        },
        $push: {
          history: {
            from: 'TESTING',
            to: BugStatus.FIXED,
            byId: interaction.user.id,
            byTag: interaction.user.tag,
            note: `Shipped in ${version}`,
            at: new Date(),
          },
        },
      },
    );
  }

  await interaction.editReply({
    embeds: [
      embeds
        .success(`Update **${version}** published in ${channel}.`)
        .addFields(
          field('Entries', `${added.length} new · ${fixed.length} fixed · ${changed.length} changed`, true),
          field('Bugs closed', bugIds.length ? bugIds.map((b) => `#${b}`).join(', ') : 'none', true),
        ),
    ],
  });
}

async function view(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const version = interaction.options.getString('version');
  const entry = version
    ? await Changelog.findOne({ guildId: interaction.guildId, version })
    : await Changelog.findOne({ guildId: interaction.guildId }).sort({ createdAt: -1 });

  if (!entry) throw new UserError(version ? `No update **${version}** on record.` : 'No updates published yet.');

  await interaction.editReply({ embeds: [changelogEmbed(entry)] });
}

async function list(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const limit = interaction.options.getInteger('limit') ?? 10;
  const entries = await Changelog.find({ guildId: interaction.guildId })
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean();

  if (!entries.length) throw new UserError('No updates published yet.');

  await interaction.editReply({
    embeds: [
      embeds.brand(`${Emojis.PIZZA} Recent updates`).setDescription(
        entries
          .map(
            (e) =>
              `**${e.version}**${e.title ? ` — ${e.title}` : ''}\n` +
              `└ ${e.added.length} new · ${e.fixed.length} fixed · ${e.changed.length} changed · ${fullTimestamp(e.publishedAt ?? e.createdAt).split(' (')[1]?.replace(')', '') ?? ''}`,
          )
          .join('\n'),
      ),
    ],
  });
}

/** The public announcement embed. */
export function changelogEmbed(entry) {
  const embed = new EmbedBuilder()
    .setColor(Colors.BRAND)
    .setTitle(`${Emojis.PIZZA} Pizza Guy's Time — Update ${entry.version}`)
    .setTimestamp(entry.publishedAt ?? entry.createdAt ?? new Date());

  if (entry.title) embed.setDescription(`**${entry.title}**`);
  if (entry.imageUrl) embed.setImage(entry.imageUrl);

  const section = (emoji, name, items) => {
    if (!items?.length) return;
    embed.addFields(field(`${emoji} ${name}`, truncate(items.map((i) => `• ${i}`).join('\n'), 1000)));
  };

  section(Emojis.SPARKLE, 'NEW', entry.added);
  section(Emojis.WRENCH, 'FIXED', entry.fixed);
  section('🔁', 'CHANGED', entry.changed);

  if (entry.closedBugIds?.length) {
    embed.addFields(
      field(
        '🐛 Reported by you',
        `This update closes ${entry.closedBugIds.length} player-reported bug(s): ` +
          entry.closedBugIds.map((b) => `#${b}`).join(', '),
      ),
    );
  }

  if (entry.credits) embed.addFields(field('💛 Credits', entry.credits));

  embed.setFooter({ text: `Version ${entry.version}` });
  return embed;
}
