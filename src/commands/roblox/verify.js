import { SlashCommandBuilder, MessageFlags } from 'discord.js';
import { RobloxProfile } from '../../database/models/RobloxProfile.js';
import { getConfig } from '../../config/guildConfig.js';
import { Permission, Emojis } from '../../config/constants.js';
import { hasPermission } from '../../systems/staff/permissions.js';
import { embeds, field, userLabel } from '../../utils/embeds.js';
import { fullTimestamp } from '../../utils/time.js';
import { UserError, PermissionError } from '../../core/errors.js';
import { safeAction } from '../../utils/safeAction.js';

/**
 * Roblox account linking.
 *
 * **The API is not implemented.** `/verify link` records the username a player
 * claims and marks it `verified: false`. Nothing in the bot treats an
 * unverified link as identity — `/profile` and the ticket embed both label it.
 *
 * `/verify approve` lets staff vouch for a link manually, which is how this
 * gets used until the API lands. That is a deliberate stopgap, not the design:
 * the automated flow (profile code → Roblox API → verified role) is specified
 * in `systems/roblox/RobloxVerificationService.js` and slots in here without
 * changing the schema or the commands.
 */
export const data = new SlashCommandBuilder()
  .setName('verify')
  .setDescription('Link your Roblox account')
  .addSubcommand((sub) =>
    sub
      .setName('link')
      .setDescription('Tell us your Roblox username')
      .addStringOption((o) =>
        o
          .setName('username')
          .setDescription('Your exact Roblox username')
          .setRequired(true)
          .setMinLength(3)
          .setMaxLength(20),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('status')
      .setDescription('Show a linked Roblox account')
      .addUserOption((o) => o.setName('member').setDescription('Defaults to you')),
  )
  .addSubcommand((sub) =>
    sub
      .setName('approve')
      .setDescription('Staff: manually confirm a member’s Roblox link')
      .addUserOption((o) => o.setName('member').setDescription('Who').setRequired(true)),
  )
  .addSubcommand((sub) =>
    sub
      .setName('unlink')
      .setDescription('Remove a Roblox link')
      .addUserOption((o) => o.setName('member').setDescription('Staff only — defaults to you')),
  );

export const meta = {
  // Linking your own account is open to everyone.
  permission: null,
  cooldown: 10,
};

export async function execute(interaction, { staff }) {
  const sub = interaction.options.getSubcommand();
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  switch (sub) {
    case 'link':
      return link(interaction);
    case 'status':
      return status(interaction, staff);
    case 'approve':
      return approve(interaction, staff);
    case 'unlink':
      return unlink(interaction, staff);
  }
}

async function link(interaction) {
  const username = interaction.options.getString('username').trim();

  if (!/^[A-Za-z0-9_]{3,20}$/.test(username)) {
    throw new UserError(
      'Roblox usernames are 3–20 characters, letters, numbers and underscores only.',
    );
  }

  const existing = await RobloxProfile.findOne({ discordId: interaction.user.id });
  if (existing?.verified) {
    throw new UserError(
      `Your account is already verified as **${existing.username}**. ` +
        'Ask staff to unlink it first if that is wrong.',
    );
  }

  // Someone else already claiming this username is worth flagging, but not
  // blocking — until the API confirms ownership, neither claim is proven.
  const clash = await RobloxProfile.findOne({
    username: new RegExp(`^${username}$`, 'i'),
    discordId: { $ne: interaction.user.id },
  });

  await RobloxProfile.findOneAndUpdate(
    { discordId: interaction.user.id },
    {
      $set: {
        username,
        verified: false,
        verificationMethod: null,
      },
      $setOnInsert: { discordId: interaction.user.id },
    },
    { upsert: true, setDefaultsOnInsert: true },
  );

  const embed = embeds
    .success(`Recorded your Roblox username as **${username}**.`)
    .addFields(
      field(
        'Not verified yet',
        'Automatic verification is not live yet, so this is unconfirmed. ' +
          'Staff can confirm it manually with `/verify approve`.',
      ),
    );

  if (clash) {
    embed.addFields(
      field(
        `${Emojis.ALERT} Heads up`,
        'Another member has also claimed this username. Staff have been able to see both.',
      ),
    );
  }

  await interaction.editReply({ embeds: [embed] });
}

async function status(interaction, staff) {
  const member = interaction.options.getMember('member') ?? interaction.member;
  const isSelf = member.id === interaction.user.id;

  if (!isSelf && !hasPermission(staff, Permission.STAFF_INFO)) {
    throw new PermissionError("You can check your own link, but not another member's.");
  }

  const profile = await RobloxProfile.findOne({ discordId: member.id }).lean();
  if (!profile) {
    throw new UserError(
      isSelf ? 'You have not linked a Roblox account. Use `/verify link`.' : 'No Roblox link on record.',
    );
  }

  await interaction.editReply({
    embeds: [
      embeds
        .brand(`${Emojis.LINK} Roblox link`)
        .addFields(
          field('Discord', userLabel(member.user), true),
          field('Roblox', profile.username ? `\`${profile.username}\`` : '*unknown*', true),
          field(
            'Status',
            profile.verified ? `${Emojis.CHECK} Verified` : `${Emojis.ALERT} Unverified (self-reported)`,
            true,
          ),
          field('Roblox ID', profile.robloxId ?? '*not resolved — API not implemented*', true),
          field('Verified', profile.verifiedAt ? fullTimestamp(profile.verifiedAt) : '—', true),
          field('Method', profile.verificationMethod ?? '—', true),
        ),
    ],
  });
}

async function approve(interaction, staff) {
  if (!hasPermission(staff, Permission.STAFF_INFO)) {
    throw new PermissionError('Only staff can approve a Roblox link.');
  }

  const member = interaction.options.getMember('member');
  if (!member) throw new UserError('That member is not in the server.');

  const profile = await RobloxProfile.findOne({ discordId: member.id });
  if (!profile?.username) {
    throw new UserError(`${member} has not submitted a username yet — ask them to run \`/verify link\`.`);
  }

  profile.verified = true;
  profile.verifiedAt = new Date();
  profile.verificationMethod = 'manual';
  profile.verifiedBy = interaction.user.id;
  await profile.save();

  // Grant the verified role when one is configured.
  const config = await getConfig(interaction.guildId);
  let roleNote = 'No verified role is configured.';
  if (config.roblox?.verifiedRoleId) {
    const result = await safeAction('grant-verified-role', () =>
      member.roles.add(config.roblox.verifiedRoleId, `Roblox verified by ${interaction.user.tag}`),
    );
    roleNote = result.ok ? 'Verified role granted.' : 'Could not grant the verified role — check my role position.';
  }

  await interaction.editReply({
    embeds: [
      embeds
        .success(`${member} is now verified as **${profile.username}**.`)
        .addFields(
          field('Role', roleNote, true),
          field(
            'Note',
            'This is a manual vouch, not an API check. It records *your* judgement that the link is real.',
          ),
        ),
    ],
  });
}

async function unlink(interaction, staff) {
  const target = interaction.options.getMember('member');
  const isSelf = !target || target.id === interaction.user.id;

  if (!isSelf && !hasPermission(staff, Permission.STAFF_INFO)) {
    throw new PermissionError("You can unlink your own account, but not another member's.");
  }

  const member = target ?? interaction.member;
  const profile = await RobloxProfile.findOne({ discordId: member.id });
  if (!profile) throw new UserError('No Roblox link on record.');

  const previous = profile.username;
  await RobloxProfile.deleteOne({ discordId: member.id });

  const config = await getConfig(interaction.guildId);
  if (config.roblox?.verifiedRoleId) {
    await safeAction('remove-verified-role', () =>
      member.roles.remove(config.roblox.verifiedRoleId, 'Roblox link removed'),
    );
  }

  await interaction.editReply({
    embeds: [embeds.success(`Unlinked **${previous ?? 'unknown'}** from ${member}.`)],
  });
}
