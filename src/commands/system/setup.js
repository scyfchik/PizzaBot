import { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } from 'discord.js';
import { getConfig, saveConfig } from '../../config/guildConfig.js';
import { DEFAULT_RANKS, Permission, Emojis } from '../../config/constants.js';
import { enabledCategories } from '../../systems/tickets/categories.js';
import { embeds, field } from '../../utils/embeds.js';

/**
 * First-run setup and readiness check.
 *
 * Deliberately not a multi-step wizard. A wizard that times out halfway leaves
 * a half-configured security system, which is the one state we never want.
 * Instead: seed sane defaults immediately, then show a checklist of exactly
 * what is still missing and which command fixes it. Safe to run repeatedly.
 */
export const data = new SlashCommandBuilder()
  .setName('setup')
  .setDescription('Initialise the bot and check what still needs configuring')
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator);

export const meta = { permission: Permission.SETUP, cooldown: 10 };

/** Discord permissions the bot cannot work without. */
const REQUIRED_BOT_PERMISSIONS = [
  ['Manage Roles', PermissionFlagsBits.ManageRoles],
  ['Manage Channels', PermissionFlagsBits.ManageChannels],
  ['Kick Members', PermissionFlagsBits.KickMembers],
  ['Ban Members', PermissionFlagsBits.BanMembers],
  ['Moderate Members', PermissionFlagsBits.ModerateMembers],
  ['Manage Messages', PermissionFlagsBits.ManageMessages],
  ['View Audit Log', PermissionFlagsBits.ViewAuditLog],
  ['Embed Links', PermissionFlagsBits.EmbedLinks],
  ['Attach Files', PermissionFlagsBits.AttachFiles],
  ['Read Message History', PermissionFlagsBits.ReadMessageHistory],
];

export async function execute(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const config = await getConfig(interaction.guildId);

  // Seed any rank that does not exist yet, without touching existing ones —
  // re-running setup must never wipe configured role IDs.
  const existing = new Set(config.staffRanks.map((r) => r.key));
  let seeded = 0;
  for (const rank of DEFAULT_RANKS) {
    if (existing.has(rank.key)) continue;
    config.staffRanks.push({ ...rank, roleIds: [] });
    seeded += 1;
  }
  if (seeded) config.staffRanks.sort((a, b) => b.position - a.position);

  config.setupComplete = true;
  await saveConfig(config);

  const embed = embeds
    .brand(`${Emojis.SHIELD} Setup status`)
    .setDescription(
      seeded
        ? `Seeded **${seeded}** staff rank(s) with default permissions. Nothing existing was changed.`
        : 'Configuration already exists — nothing was overwritten.',
    );

  // --- Bot permissions ---------------------------------------------------
  const me = await interaction.guild.members.fetchMe();
  const missingPerms = REQUIRED_BOT_PERMISSIONS.filter(([, bit]) => !me.permissions.has(bit)).map(
    ([label]) => label,
  );

  embed.addFields(
    field(
      'Bot permissions',
      missingPerms.length
        ? `${Emojis.CROSS} Missing: ${missingPerms.map((p) => `\`${p}\``).join(', ')}\n` +
          'Re-invite the bot or grant these in Server Settings → Roles.'
        : `${Emojis.CHECK} All required permissions granted.`,
    ),
  );

  // Role position is the single most common reason moderation "randomly" fails.
  const highestOther = interaction.guild.roles.cache
    .filter((r) => r.id !== interaction.guild.id && !r.managed)
    .sort((a, b) => b.position - a.position)
    .first();

  if (highestOther && me.roles.highest.position < highestOther.position) {
    embed.addFields(
      field(
        'Role position',
        `${Emojis.ALERT} My highest role (${me.roles.highest}) sits below **${highestOther.name}**. ` +
          'Discord will refuse any action against members holding roles above mine — ' +
          'drag my role near the top of the role list.',
      ),
    );
  }

  // --- Staff ranks -------------------------------------------------------
  const configured = config.staffRanks.filter((r) => r.roleIds?.length);
  embed.addFields(
    field(
      `Staff ranks (${configured.length}/${config.staffRanks.length} mapped)`,
      config.staffRanks
        .map(
          (r) =>
            `${r.roleIds?.length ? Emojis.CHECK : '▫️'} **${r.name}** — ` +
            (r.roleIds?.length ? r.roleIds.map((id) => `<@&${id}>`).join(', ') : '*no role set*'),
        )
        .join('\n'),
    ),
  );

  // --- First-run checklist -----------------------------------------------
  //
  // Every step is shown, done or not, in the order it should be completed.
  // Showing only what is missing hides how much is left and gives no sense of
  // progress — and someone setting this up for the first time needs both.
  const steps = [
    {
      label: 'Map staff ranks to roles',
      done: configured.length > 0,
      how: '`/config rank set rank:Moderator role:@Mod` — repeat per rank',
      required: true,
    },
    {
      label: 'Moderation log channel',
      done: Boolean(config.logChannels.moderation),
      how: '`/config channel set type:Moderation channel:#moderation-logs`',
      required: true,
    },
    {
      label: 'Security log channel',
      done: Boolean(config.logChannels.security),
      how: '`/config channel set type:Security channel:#security-logs`',
      required: true,
    },
    {
      label: 'Ticket log channel',
      done: Boolean(config.logChannels.tickets),
      how: '`/config channel set type:Tickets channel:#ticket-logs`',
      required: true,
    },
    {
      label: 'Staff log channel',
      done: Boolean(config.logChannels.staff),
      how: '`/config channel set type:Staff channel:#staff-logs`',
      required: false,
    },
    {
      label: 'Ticket category',
      done: Boolean(config.tickets.categoryId),
      how: '`/config tickets category:<a Discord category>` — tickets are created here',
      required: true,
    },
    {
      label: 'Ticket panel posted',
      done: Boolean(config.tickets.panelMessageId),
      how: '`/panel post channel:#support`',
      required: true,
    },
    {
      label: 'Security alert channel',
      done: Boolean(config.security.alertChannelId),
      how: '`/config security alert-channel:#security-alerts`',
      required: false,
    },
    {
      label: 'Quarantine role',
      done: Boolean(config.security.quarantineRoleId),
      how:
        'Create a role with **no** send/speak permissions, place it below mine, then ' +
        '`/config security quarantine-role:@Quarantine`',
      required: false,
    },
    {
      label: 'QA bug board',
      done: Boolean(config.qa?.boardChannelId),
      how: '`/config qa board-channel:#bug-reports tester-role:@QA Tester`',
      required: false,
    },
    {
      label: 'Changelog channel',
      done: Boolean(config.changelog?.channelId),
      how: '`/config changelog channel:#updates`',
      required: false,
    },
  ];

  const completed = steps.filter((s) => s.done).length;
  const blocking = steps.filter((s) => !s.done && s.required);

  // A ten-segment bar reads faster than a fraction when you run this repeatedly.
  const filled = Math.round((completed / steps.length) * 10);
  const bar = '█'.repeat(filled) + '░'.repeat(10 - filled);

  const rendered = steps.map((step, i) => {
    const mark = step.done ? Emojis.CHECK : step.required ? '🔴' : '⬜';
    const suffix = step.done ? '' : `\n└ ${step.how}`;
    return `${mark} **${i + 1}. ${step.label}**${step.required ? '' : ' *(optional)*'}${suffix}`;
  });

  // Discord caps a field value at 1024 characters and the full checklist can
  // exceed that when nothing is done yet, so split it across fields rather
  // than letting the last few steps get silently truncated away.
  const CHUNK = 4;
  for (let i = 0; i < rendered.length; i += CHUNK) {
    const isFirst = i === 0;
    embed.addFields(
      field(
        isFirst
          ? `First-run checklist — ${completed}/${steps.length}  ${bar}`
          : `… continued (${i + 1}–${Math.min(i + CHUNK, rendered.length)})`,
        rendered.slice(i, i + CHUNK).join('\n'),
      ),
    );
  }

  if (blocking.length) {
    embed.addFields(
      field(
        `${Emojis.ALERT} Not ready yet`,
        `**${blocking.length}** required step(s) remaining: ${blocking
          .map((s) => s.label)
          .join(', ')}.\nThe bot will run, but those features stay inactive until configured.`,
      ),
    );
  } else {
    embed.addFields(
      field(
        `${Emojis.CHECK} Ready`,
        'Every required step is done. Review with `/config view`, then test by opening a ticket yourself.',
      ),
    );
  }

  embed.addFields(
    field(
      'Ticket categories',
      enabledCategories(config)
        .map((c) => `${c.emoji} ${c.label}`)
        .join(' · '),
    ),
  );

  embed.setFooter({ text: 'Safe to run again at any time — it never overwrites existing settings.' });

  await interaction.editReply({ embeds: [embed] });
}
