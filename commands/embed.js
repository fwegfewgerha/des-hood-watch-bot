const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');
const { resetDraft } = require('../utils/state');
const { renderDraftMessage } = require('../utils/embedRender');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('embed')
    .setDescription('Open the embed builder to create or move an embed in this server.')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setDMPermission(false),

  async execute(interaction) {
    const draft = resetDraft(interaction.user.id);
    const { content, components } = renderDraftMessage(
      draft,
      'Draft ready. Choose an edit control to begin.'
    );
    await interaction.reply({
      content,
      components,
      flags: MessageFlags.Ephemeral,
    });
  },
};
