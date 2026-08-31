const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  ChannelType,
} = require('discord.js');

const HEX_RE = /^#?[0-9a-fA-F]{6}$/;

function normalizeColor(input) {
  if (!input) return '#5865F2';
  const trimmed = input.trim();
  if (!HEX_RE.test(trimmed)) return null;
  return trimmed.startsWith('#') ? trimmed : `#${trimmed}`;
}

function truncate(str, max) {
  if (!str) return str;
  return str.length > max ? `${str.slice(0, max - 1)}…` : str;
}

// Turns a draft object into a real embed. Used for Preview and for Send.
function draftToEmbed(draft) {
  const embed = new EmbedBuilder().setColor(draft.color || '#5865F2');
  if (draft.title) embed.setTitle(truncate(draft.title, 256));
  if (draft.description) embed.setDescription(truncate(draft.description, 4096));
  if (draft.image) embed.setImage(draft.image);
  if (draft.thumbnail) embed.setThumbnail(draft.thumbnail);
  if (draft.footerText || draft.footerIcon) {
    embed.setFooter({
      text: truncate(draft.footerText || '​', 2048),
      iconURL: draft.footerIcon || undefined,
    });
  }
  return embed;
}

// True if the draft has enough content to actually send.
function draftHasContent(draft) {
  return Boolean(
    draft.title || draft.description || draft.image || draft.thumbnail || draft.footerText
  );
}

function fieldLine(label, value) {
  return `**${label}:** ${value ?? 'Not set'}`;
}

// The status/summary text shown above the edit controls.
function draftSummaryText(draft, statusLine) {
  const lines = [
    fieldLine('Target channel', draft.channelId ? `<#${draft.channelId}>` : 'Not selected'),
    fieldLine('Color', `\`${draft.color || '#5865F2'}\``),
    fieldLine('Title', draft.title ? truncate(draft.title, 60) : 'Not set'),
    fieldLine('Description', draft.description ? truncate(draft.description, 80) : 'Not set'),
    fieldLine('Footer', draft.footerText ? truncate(draft.footerText, 60) : 'Not set'),
    fieldLine('Footer icon', draft.footerIcon ? 'Set' : 'Not set'),
    fieldLine('Image', draft.image ? 'Set' : 'Not set'),
    fieldLine('Thumbnail', draft.thumbnail ? 'Set' : 'Not set'),
    fieldLine('Move source', draft.moveSourceUrl ? 'Set (message URL saved)' : 'Not selected'),
  ];
  let text = `### Embed builder\n\n${lines.join('\n')}`;
  if (statusLine) text += `\n\n> ${statusLine}`;
  return text;
}

function buildRows(draft) {
  const fieldRow1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('ehb:field:title').setLabel('Title').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('ehb:field:description').setLabel('Description').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('ehb:field:color').setLabel('Color').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('ehb:field:footer').setLabel('Footer').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('ehb:field:footericon').setLabel('Footer icon').setStyle(ButtonStyle.Secondary)
  );

  const fieldRow2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('ehb:field:image').setLabel('Image').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('ehb:field:thumbnail').setLabel('Thumbnail').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('ehb:move').setLabel('Move Existing').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('ehb:reset').setLabel('Reset').setStyle(ButtonStyle.Danger)
  );

  const channelRow = new ActionRowBuilder().addComponents(
    new ChannelSelectMenuBuilder()
      .setCustomId('ehb:channel')
      .setPlaceholder('Choose a target text channel')
      .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
  );

  const actionRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('ehb:preview')
      .setLabel('Preview')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId('ehb:send')
      .setLabel('Send')
      .setStyle(ButtonStyle.Success)
      .setDisabled(!draft.channelId || (!draftHasContent(draft) && !draft.moveSourceUrl))
  );

  return [fieldRow1, fieldRow2, channelRow, actionRow];
}

function renderDraftMessage(draft, statusLine) {
  return {
    content: draftSummaryText(draft, statusLine),
    components: buildRows(draft),
  };
}

module.exports = {
  normalizeColor,
  draftToEmbed,
  draftHasContent,
  draftSummaryText,
  buildRows,
  renderDraftMessage,
  truncate,
};
