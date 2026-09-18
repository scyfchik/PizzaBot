import { SlashCommandBuilder, MessageFlags } from 'discord.js';
import { Permission, BugStatus, Platform } from '../../config/constants.js';
import { bugEmbed, bugLine } from '../../systems/qa/BugReportService.js';
import { hasPermission } from '../../systems/staff/permissions.js';
import { embeds, field, padNumber } from '../../utils/embeds.js';
import { fullTimestamp } from '../../utils/time.js';
import { UserError, PermissionError } from '../../core/errors.js';

/**
 * QA workflow.
 *
 * `/bug report` is open to everyone — players find bugs. Everything that
 * changes a report's state requires `qa.manage`, so the board reflects the
 * testing team's judgement rather than whoever shouted loudest.
 */
export const data = new SlashCommandBuilder()
  .setName('bug')
  .setDescription('Report and track game bugs')
  .addSubcommand((sub) =>
    sub
      .setName('report')
      .setDescription('Report a bug in the game')
      .addStringOption((o) =>
        o
          .setName('description')
          .setDescription('What went wrong?')
          .setRequired(true)
          .setMaxLength(1000),
      )
      .addStringOption((o) =>
        o
          .setName('platform')
          .setDescription('What are you playing on?')
          .setRequired(true)
          .addChoices(
            { name: 'PC', value: Platform.PC },
            { name: 'Mobile', value: Platform.MOBILE },
            { name: 'Tablet', value: Platform.TABLET },
            { name: 'Console', value: Platform.CONSOLE },
            { name: 'VR', value: Platform.VR },
          ),
      )
      .addStringOption((o) =>
        o
          .setName('steps')
          .setDescription('How do we reproduce it?')
          .setRequired(true)
          .setMaxLength(1000),
      )
      .addStringOption((o) =>
        o.setName('roblox-username').setDescription('Your Roblox username').setMaxLength(32),
      )
      .addStringOption((o) =>
        o.setName('version').setDescription('Game version, if you know it').setMaxLength(32),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('view')
      .setDescription('Show a bug report')
      .addIntegerOption((o) =>
        o.setName('id').setDescription('Bug number').setRequired(true).setMinValue(1),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('list')
      .setDescription('List bug reports')
      .addStringOption((o) =>
        o
          .setName('status')
          .setDescription('Filter by status')
          .addChoices(
            { name: 'Open', value: BugStatus.OPEN },
            { name: 'Testing', value: BugStatus.TESTING },
            { name: 'Fixed', value: BugStatus.FIXED },
            { name: 'Rejected', value: BugStatus.REJECTED },
          ),
      )
      .addUserOption((o) => o.setName('tester').setDescription('Filter by assigned tester'))
      .addIntegerOption((o) => o.setName('page').setDescription('Page number').setMinValue(1)),
  )
  .addSubcommand((sub) =>
    sub
      .setName('assign')
      .setDescription('Assign a tester and move the report to TESTING')
      .addIntegerOption((o) => o.setName('id').setDescription('Bug number').setRequired(true))
      .addUserOption((o) =>
        o.setName('tester').setDescription('Defaults to you').setRequired(false),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('status')
      .setDescription('Change a bug report’s status')
      .addIntegerOption((o) => o.setName('id').setDescription('Bug number').setRequired(true))
      .addStringOption((o) =>
        o
          .setName('status')
          .setDescription('New status')
          .setRequired(true)
          .addChoices(
            { name: 'OPEN — not started', value: BugStatus.OPEN },
            { name: 'TESTING — being investigated', value: BugStatus.TESTING },
            { name: 'FIXED — resolved', value: BugStatus.FIXED },
            { name: 'REJECTED — not a bug / wont fix', value: BugStatus.REJECTED },
          ),
      )
      .addStringOption((o) => o.setName('note').setDescription('Reason or detail').setMaxLength(500)),
  )
  .addSubcommand((sub) => sub.setName('stats').setDescription('Bug counts by status'));

export const meta = {
  // Reporting is open to everyone; the gate is applied per subcommand below.
  permission: null,
  cooldown: 5,
};

export async function execute(interaction, { client, staff }) {
  const sub = interaction.options.getSubcommand();
  const qa = client.getSystem('qa');

  switch (sub) {
    case 'report':
      return report(interaction, qa);
    case 'view':
      return view(interaction, qa, staff);
    case 'list':
      return list(interaction, qa, staff);
    case 'assign':
      return assign(interaction, qa, staff);
    case 'status':
      return setStatus(interaction, qa, staff);
    case 'stats':
      return stats(interaction, qa, staff);
  }
}

async function report(interaction, qa) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const bug = await qa.create(interaction.guild, interaction.user, {
    description: interaction.options.getString('description'),
    platform: interaction.options.getString('platform'),
    reproduction: interaction.options.getString('steps'),
    robloxUsername: interaction.options.getString('roblox-username'),
    gameVersion: interaction.options.getString('version'),
  });

  await interaction.editReply({
    embeds: [
      embeds
        .success(`Thanks — filed as bug **#${padNumber(bug.bugId)}**.`)
        .addFields(
          field(
            'Screenshots or video?',
            'Reply to this channel with them, or open a 🐛 Bug Report ticket from the support panel if you need to talk it through with a developer.',
          ),
        ),
    ],
  });
}

function requireQa(staff, node) {
  if (!hasPermission(staff, node)) {
    throw new PermissionError('That is for the QA team.');
  }
}

async function view(interaction, qa, staff) {
  requireQa(staff, Permission.QA_VIEW);
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const bug = await qa.get(interaction.guildId, interaction.options.getInteger('id'));
  if (!bug) throw new UserError('No bug report with that number.');

  const embed = bugEmbed(bug);
  if (bug.ticketId) embed.addFields(field('From ticket', `#${padNumber(bug.ticketId)}`, true));
  if (bug.history?.length) {
    embed.addFields(
      field(
        'History',
        bug.history
          .slice(-5)
          .map((h) => `${h.from} → **${h.to}** by ${h.byTag ?? h.byId} · ${fullTimestamp(h.at).split(' (')[1]?.replace(')', '') ?? ''}`)
          .join('\n'),
      ),
    );
  }

  await interaction.editReply({ embeds: [embed] });
}

async function list(interaction, qa, staff) {
  requireQa(staff, Permission.QA_VIEW);
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const page = interaction.options.getInteger('page') ?? 1;
  const result = await qa.list(interaction.guildId, {
    status: interaction.options.getString('status'),
    tester: interaction.options.getUser('tester')?.id ?? null,
    page,
  });

  if (!result.items.length) throw new UserError('No bug reports match that filter.');

  await interaction.editReply({
    embeds: [
      embeds
        .brand(`🐛 Bug reports — ${result.total} total`)
        .setDescription(result.items.map(bugLine).join('\n\n'))
        .setFooter({ text: `Page ${result.page} of ${result.pages}` }),
    ],
  });
}

async function assign(interaction, qa, staff) {
  requireQa(staff, Permission.QA_MANAGE);
  await interaction.deferReply();

  const tester = interaction.options.getMember('tester') ?? interaction.member;
  const bug = await qa.assign(
    interaction.guildId,
    interaction.options.getInteger('id'),
    tester,
  );

  await interaction.editReply({
    embeds: [
      embeds.success(`Bug **#${padNumber(bug.bugId)}** assigned to ${tester} — now **TESTING**.`),
    ],
  });
}

async function setStatus(interaction, qa, staff) {
  requireQa(staff, Permission.QA_MANAGE);
  await interaction.deferReply();

  const bug = await qa.setStatus(
    interaction.guildId,
    interaction.options.getInteger('id'),
    interaction.options.getString('status'),
    interaction.user,
    interaction.options.getString('note'),
  );

  await interaction.editReply({
    embeds: [
      embeds.success(`Bug **#${padNumber(bug.bugId)}** is now **${bug.status}**.`),
    ],
  });
}

async function stats(interaction, qa, staff) {
  requireQa(staff, Permission.QA_VIEW);
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const counts = await qa.counts(interaction.guildId);
  const total = Object.values(counts).reduce((sum, n) => sum + n, 0);

  await interaction.editReply({
    embeds: [
      embeds
        .brand('🐛 QA summary')
        .addFields(
          field('🔴 Open', String(counts.OPEN), true),
          field('🟡 Testing', String(counts.TESTING), true),
          field('🟢 Fixed', String(counts.FIXED), true),
          field('⚫ Rejected', String(counts.REJECTED), true),
          field('Total', String(total), true),
        ),
    ],
  });
}
