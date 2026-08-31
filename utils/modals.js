const { ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder } = require('discord.js');

// One entry per field button. `key` matches the customId suffix used
// in embedRender.js (ehb:field:<key>) and modal customId (ehb:modal:<key>).
const FIELD_CONFIG = {
  title: {
    label: 'Title',
    style: TextInputStyle.Short,
    maxLength: 256,
    placeholder: 'Embed title',
    draftKey: 'title',
  },
  description: {
    label: 'Description',
    style: TextInputStyle.Paragraph,
    maxLength: 4000,
    placeholder: 'Embed description (supports normal Discord text formatting)',
    draftKey: 'description',
  },
  color: {
    label: 'Color (hex)',
    style: TextInputStyle.Short,
    maxLength: 7,
    placeholder: '#5865F2',
    draftKey: 'color',
  },
  footer: {
    label: 'Footer text',
    style: TextInputStyle.Short,
    maxLength: 256,
    placeholder: 'Footer text',
    draftKey: 'footerText',
  },
  footericon: {
    label: 'Footer icon URL',
    style: TextInputStyle.Short,
    maxLength: 300,
    placeholder: 'https://...',
    draftKey: 'footerIcon',
  },
  image: {
    label: 'Image URL',
    style: TextInputStyle.Short,
    maxLength: 300,
    placeholder: 'https://...',
    draftKey: 'image',
  },
  thumbnail: {
    label: 'Thumbnail URL',
    style: TextInputStyle.Short,
    maxLength: 300,
    placeholder: 'https://...',
    draftKey: 'thumbnail',
  },
};

function buildFieldModal(fieldKey, currentDraft) {
  const config = FIELD_CONFIG[fieldKey];
  if (!config) return null;

  const input = new TextInputBuilder()
    .setCustomId('value')
    .setLabel(config.label)
    .setStyle(config.style)
    .setMaxLength(config.maxLength)
    .setPlaceholder(config.placeholder)
    .setRequired(false);

  const currentValue = currentDraft[config.draftKey];
  if (currentValue) input.setValue(String(currentValue).slice(0, config.maxLength));

  const modal = new ModalBuilder()
    .setCustomId(`ehb:modal:${fieldKey}`)
    .setTitle(`Edit: ${config.label}`)
    .addComponents(new ActionRowBuilder().addComponents(input));

  return modal;
}

function buildMoveModal(currentDraft) {
  const input = new TextInputBuilder()
    .setCustomId('value')
    .setLabel('Discord message URL')
    .setStyle(TextInputStyle.Short)
    .setMaxLength(300)
    .setPlaceholder('https://discord.com/channels/.../.../...')
    .setRequired(false);

  if (currentDraft.moveSourceUrl) input.setValue(currentDraft.moveSourceUrl);

  return new ModalBuilder()
    .setCustomId('ehb:modal:move')
    .setTitle('Move an existing embed')
    .addComponents(new ActionRowBuilder().addComponents(input));
}

module.exports = { FIELD_CONFIG, buildFieldModal, buildMoveModal };
