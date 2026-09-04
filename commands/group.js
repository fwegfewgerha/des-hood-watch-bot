const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags, EmbedBuilder } = require('discord.js');
const roblox = require('../utils/roblox');
const { logEvent } = require('../handlers/modLog');

const PROFILE = (id) => `https://www.roblox.com/users/${id}/profile`;

const targetOption = (option, verb) =>
  option
    .setName('user')
    .setDescription(`Roblox username or user ID to ${verb}.`)
    .setRequired(true)
    .setMaxLength(50);

// The role the operator typed. Autocomplete hands back a role ID, but they
// can also submit free text without picking a suggestion, so a rank number
// and a role name both resolve too.
function resolveRole(input, roles) {
  const query = String(input ?? '').trim();
  const lower = query.toLowerCase();

  const byId = roles.find((role) => String(role.id) === query);
  if (byId) return byId;

  if (/^\d+$/.test(query)) {
    const byRank = roles.find((role) => role.rank === Number(query));
    if (byRank) return byRank;
  }

  const byName =
    roles.find((role) => role.name.toLowerCase() === lower) ??
    roles.find((role) => role.name.toLowerCase().startsWith(lower)) ??
    roles.find((role) => role.name.toLowerCase().includes(lower));
  if (byName) return byName;

  throw new roblox.RobloxError(
    `No role matches \`${query}\`. Roles in this group: ${roles.map((r) => `**${r.name}** (${r.rank})`).join(', ')}.`
  );
}

// promote/demote are the same walk in opposite directions: one step along
// the group's rank ladder.
//
// This steps to the next *strictly different* rank rather than the next
// entry in the list, because a group can hold several roles at the same
// rank number (Des Staff Group has both "Member" and "member" at rank 1).
// Walking by list position would shuffle someone sideways between two
// equal roles and call it a promotion.
async function step(interaction, target, direction) {
  const roles = await roblox.listRoles();
  const current = await roblox.getMemberRole(target.id);
  if (!current) throw new roblox.RobloxError(`**${target.name}** is not a member of the group.`);

  if (current.role.rank === null || current.role.rank === undefined) {
    throw new roblox.RobloxError(
      `**${target.name}** holds a role this bot can't see (\`${current.role.name}\`), so it can't step them up or down. Use \`/group rank\` to set a role directly.`
    );
  }

  // roles is sorted by rank ascending, so the first strictly-higher entry
  // is the next rank up, and the last strictly-lower one is the next down.
  const next =
    direction > 0
      ? roles.find((role) => role.rank > current.role.rank)
      : [...roles].reverse().find((role) => role.rank < current.role.rank);

  if (!next) {
    throw new roblox.RobloxError(
      `**${target.name}** is already at the ${direction > 0 ? 'highest' : 'lowest'} rank (**${current.role.name}**).`
    );
  }

  await roblox.setRank(target.id, next.id);
  return { from: current.role, to: next };
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('group')
    .setDescription('Control the Roblox group — ranking, kicks and bans.')
    .addSubcommand((sub) =>
      sub
        .setName('rank')
        .setDescription('Set a member to a specific role.')
        .addStringOption((option) => targetOption(option, 'rank'))
        .addStringOption((option) =>
          option
            .setName('role')
            .setDescription('Role name, rank number, or pick from the list.')
            .setRequired(true)
            .setAutocomplete(true)
            .setMaxLength(100)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName('promote')
        .setDescription('Move a member up one role.')
        .addStringOption((option) => targetOption(option, 'promote'))
    )
    .addSubcommand((sub) =>
      sub
        .setName('demote')
        .setDescription('Move a member down one role.')
        .addStringOption((option) => targetOption(option, 'demote'))
    )
    .addSubcommand((sub) =>
      sub
        .setName('accept')
        .setDescription('Approve a pending join request.')
        .addStringOption((option) => targetOption(option, 'accept into the group'))
    )
    .addSubcommand((sub) =>
      sub
        .setName('decline')
        .setDescription('Reject a pending join request.')
        .addStringOption((option) => targetOption(option, 'decline'))
    )
    .addSubcommand((sub) =>
      sub
        .setName('kick')
        .setDescription('Remove a member from the group (they can rejoin).')
        .addStringOption((option) => targetOption(option, 'kick'))
    )
    .addSubcommand((sub) =>
      sub
        .setName('ban')
        .setDescription('Ban a user from the group (removes them and blocks rejoining).')
        .addStringOption((option) => targetOption(option, 'ban'))
    )
    .addSubcommand((sub) =>
      sub
        .setName('unban')
        .setDescription('Lift a group ban.')
        .addStringOption((option) => targetOption(option, 'unban'))
    )
    .addSubcommand((sub) =>
      sub
        .setName('info')
        .setDescription("Show a user's current role in the group.")
        .addStringOption((option) => targetOption(option, 'look up'))
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setDMPermission(false),

  // Suggests the group's roles as you type. Failures here are silent by
  // design — an unconfigured or unreachable Roblox just means no
  // suggestions, and the real error comes from running the command.
  async autocomplete(interaction) {
    const focused = interaction.options.getFocused(true);
    if (focused.name !== 'role') return interaction.respond([]);

    try {
      const roles = await roblox.listRoles();
      const query = focused.value.trim().toLowerCase();
      const matches = roles
        .filter((role) => !query || role.name.toLowerCase().includes(query) || String(role.rank).startsWith(query))
        .slice(0, 25)
        .map((role) => ({ name: `${role.name} — rank ${role.rank}`, value: String(role.id) }));
      return interaction.respond(matches);
    } catch {
      return interaction.respond([]);
    }
  },

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    // Every path here makes at least one Roblox round-trip, which can
    // outrun Discord's 3-second reply window on its own.
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
      const target = await roblox.resolveUser(interaction.options.getString('user'));
      const who = `[${target.name}](${PROFILE(target.id)})`;

      if (sub === 'info') {
        const current = await roblox.getMemberRole(target.id);
        const embed = new EmbedBuilder()
          .setColor(current ? '#6fcbd9' : '#8b8b8b')
          .setTitle(target.displayName === target.name ? target.name : `${target.displayName} (@${target.name})`)
          .setURL(PROFILE(target.id))
          .addFields(
            { name: 'User ID', value: String(target.id), inline: true },
            {
              name: 'Group role',
              value: current ? `${current.role.name}${current.role.rank === null ? '' : ` (rank ${current.role.rank})`}` : 'Not a member',
              inline: true,
            }
          );
        return interaction.editReply({ embeds: [embed] });
      }

      if (sub === 'rank') {
        const roles = await roblox.listRoles();
        const role = resolveRole(interaction.options.getString('role'), roles);
        const current = await roblox.getMemberRole(target.id);
        if (!current) throw new roblox.RobloxError(`**${target.name}** is not a member of the group.`);

        await roblox.setRank(target.id, role.id);

        await interaction.editReply(
          `✅ Ranked **${target.name}** ${current.role.name} → **${role.name}** (rank ${role.rank}).`
        );
        return logEvent(
          interaction.guild,
          `🎖️ **Group rank changed** by ${interaction.user} — ${who} ${current.role.name} → **${role.name}** (rank ${role.rank}).`
        );
      }

      if (sub === 'promote' || sub === 'demote') {
        const { from, to } = await step(interaction, target, sub === 'promote' ? 1 : -1);

        await interaction.editReply(
          `✅ ${sub === 'promote' ? 'Promoted' : 'Demoted'} **${target.name}** ${from.name} → **${to.name}** (rank ${to.rank}).`
        );
        return logEvent(
          interaction.guild,
          `${sub === 'promote' ? '⬆️' : '⬇️'} **Group ${sub}** by ${interaction.user} — ${who} ${from.name} → **${to.name}** (rank ${to.rank}).`
        );
      }

      if (sub === 'accept' || sub === 'decline') {
        if (sub === 'accept') await roblox.acceptJoinRequest(target.id);
        else await roblox.declineJoinRequest(target.id);

        await interaction.editReply(
          sub === 'accept'
            ? `✅ Accepted **${target.name}** into the group. They join at the lowest role — use \`/group rank\` to place them.`
            : `✅ Declined **${target.name}**’s join request.`
        );
        return logEvent(
          interaction.guild,
          `${sub === 'accept' ? '📥' : '🚪'} **Join request ${sub === 'accept' ? 'accepted' : 'declined'}** by ${interaction.user} — ${who}.`
        );
      }

      if (sub === 'kick' || sub === 'ban') {
        // Read the rank first: once they're out of the group it's gone,
        // and it's the detail that makes the log entry worth having.
        const current = await roblox.getMemberRole(target.id).catch(() => null);
        const held = current ? ` (was **${current.role.name}**)` : '';

        if (sub === 'kick') await roblox.kickFromGroup(target.id);
        else await roblox.banFromGroup(target.id);

        await interaction.editReply(
          sub === 'kick'
            ? `✅ Kicked **${target.name}** from the group${held}. They can rejoin unless you ban them.`
            : `✅ Banned **${target.name}** from the group${held}. They are removed and cannot rejoin.`
        );
        return logEvent(
          interaction.guild,
          `${sub === 'kick' ? '👢' : '🔨'} **Group ${sub}** by ${interaction.user} — ${who}${held}.`
        );
      }

      if (sub === 'unban') {
        await roblox.unbanFromGroup(target.id);
        await interaction.editReply(`✅ Lifted the group ban on **${target.name}**. They can rejoin now.`);
        return logEvent(interaction.guild, `♻️ **Group unban** by ${interaction.user} — ${who}.`);
      }
    } catch (err) {
      // Roblox-side refusals are the operator's to act on, so they're shown
      // as written. Anything else is a bug and goes up to index.js, which
      // logs it and replies generically.
      if (err?.expected) return interaction.editReply(`⚠️ ${err.message}`);
      throw err;
    }
  },
};
