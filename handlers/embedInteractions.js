const { MessageFlags } = require('discord.js');
const { getDraft, setDraft, resetDraft } = require('../utils/state');
const {
  normalizeColor,
  draftToEmbed,
  draftHasContent,
  renderDraftMessage,
} = require('../utils/embedRender');
const { buildFieldModal, buildMoveModal, FIELD_CONFIG } = require('../utils/modals');
const { parseMessageUrl } = require('../utils/parseMessageUrl');

function isValidHttpUrl(value) {
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

// Checks the gateway cache before hitting the REST API — a channel the bot
// already knows about (the common case) resolves instantly instead of
// paying a network round-trip on every embed-builder action.
async function getChannelCached(manager, channelId) {
  return manager.cache.get(channelId) ?? (await manager.fetch(channelId).catch(() => null));
}

// Edits the ephemeral builder message. Use when the interaction has NOT
// been deferred/replied yet (fast, synchronous branches).
async function refresh(interaction, draft, statusLine) {
  const { content, components } = renderDraftMessage(draft, statusLine);
  await interaction.update({ content, components });
}

// Edits the ephemeral builder message after interaction.deferUpdate() was
// already called. Use in any branch that does a network call first.
async function finalize(interaction, draft, statusLine) {
  const { content, components } = renderDraftMessage(draft, statusLine);
  await interaction.editReply({ content, components });
}

// ---- Buttons ----------------------------------------------------------------

async function handleButton(interaction) {
  const [, action, sub] = interaction.customId.split(':'); // ehb:action:sub
  const userId = interaction.user.id;
  const draft = getDraft(userId);

  if (action === 'field') {
    const modal = buildFieldModal(sub, draft);
    if (!modal) return interaction.reply({ content: 'Unknown field.', flags: MessageFlags.Ephemeral });
    return interaction.showModal(modal);
  }

  if (action === 'move') {
    return interaction.showModal(buildMoveModal(draft));
  }

  if (action === 'reset') {
    const fresh = resetDraft(userId);
    return refresh(interaction, fresh, 'Draft cleared. Choose an edit control to begin.');
  }

  if (action === 'preview') {
    return sendPreview(interaction, draft);
  }

  if (action === 'send') {
    return performSend(interaction, draft);
  }

  return interaction.reply({ content: 'Unknown action.', flags: MessageFlags.Ephemeral });
}

// ---- Channel select -----------------------------------------------------------

async function handleChannelSelect(interaction) {
  const userId = interaction.user.id;
  const draft = getDraft(userId);
  draft.channelId = interaction.values[0];
  setDraft(userId, draft);
  return refresh(interaction, draft, 'Target channel set.');
}

// ---- Modal submissions ----------------------------------------------------------

async function handleModalSubmit(interaction) {
  const [, , fieldKey] = interaction.customId.split(':'); // ehb:modal:<fieldKey>
  const userId = interaction.user.id;
  const draft = getDraft(userId);
  const rawValue = interaction.fields.getTextInputValue('value')?.trim() ?? '';

  if (fieldKey === 'move') {
    return handleMoveSubmit(interaction, draft, rawValue);
  }

  const config = FIELD_CONFIG[fieldKey];
  if (!config) {
    return interaction.reply({ content: 'Unknown field.', flags: MessageFlags.Ephemeral });
  }

  // Empty submission clears the field. No network calls in this branch — respond directly.
  if (!rawValue) {
    draft[config.draftKey] = fieldKey === 'color' ? '#5865F2' : null;
    setDraft(userId, draft);
    return refresh(interaction, draft, `${config.label} cleared.`);
  }

  if (fieldKey === 'color') {
    const color = normalizeColor(rawValue);
    if (!color) {
      return refresh(interaction, draft, 'Invalid color — use a 6-digit hex code like #5865F2. Nothing changed.');
    }
    draft.color = color;
    setDraft(userId, draft);
    return refresh(interaction, draft, 'Color updated.');
  }

  if (['footericon', 'image', 'thumbnail'].includes(fieldKey)) {
    if (!isValidHttpUrl(rawValue)) {
      return refresh(interaction, draft, `${config.label} must be a valid http(s) URL. Nothing changed.`);
    }
  }

  draft[config.draftKey] = rawValue;
  setDraft(userId, draft);
  return refresh(interaction, draft, `${config.label} updated.`);
}

// This branch fetches a message before it can respond, so it defers first.
async function handleMoveSubmit(interaction, draft, rawValue) {
  const userId = interaction.user.id;
  await interaction.deferUpdate();

  if (!rawValue) {
    draft.moveSourceUrl = null;
    setDraft(userId, draft);
    return finalize(interaction, draft, 'Move source cleared.');
  }

  const parsed = parseMessageUrl(rawValue);
  if (!parsed) {
    return finalize(
      interaction,
      draft,
      'That doesn’t look like a Discord message link. Right-click the message → Copy Message Link. Nothing changed.'
    );
  }

  if (parsed.guildId !== interaction.guildId) {
    return finalize(
      interaction,
      draft,
      'That message is from a different server — Move Existing only works within this server. Nothing changed.'
    );
  }

  const sourceChannel = await getChannelCached(interaction.client.channels, parsed.channelId);
  if (!sourceChannel || !sourceChannel.isTextBased()) {
    return finalize(interaction, draft, 'Could not find that channel. Nothing changed.');
  }

  try {
    const sourceMessage = await sourceChannel.messages.fetch(parsed.messageId);
    if (!sourceMessage.embeds.length) {
      return finalize(interaction, draft, 'That message has no embed to move. Nothing changed.');
    }

    draft.moveSourceUrl = rawValue;
    setDraft(userId, draft);
    return finalize(
      interaction,
      draft,
      'Move source set. Pick a target channel, then hit Send to repost the embed and delete the original.'
    );
  } catch {
    return finalize(
      interaction,
      draft,
      'Couldn’t load that message — check the link, and that I can see that channel. Nothing changed.'
    );
  }
}

// ---- Preview ------------------------------------------------------------------

async function sendPreview(interaction, draft) {
  if (draft.moveSourceUrl) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const parsed = parseMessageUrl(draft.moveSourceUrl);
    const channel = await getChannelCached(interaction.client.channels, parsed.channelId);
    if (!channel) {
      return interaction.editReply({ content: 'Couldn’t load the move-source message anymore.' });
    }
    try {
      const message = await channel.messages.fetch(parsed.messageId);
      if (!message.embeds.length) {
        return interaction.editReply({ content: 'The move-source message no longer has an embed to preview.' });
      }
      return interaction.editReply({
        content: 'Preview of the move-source embed — nothing has been sent yet.',
        embeds: message.embeds,
      });
    } catch {
      return interaction.editReply({ content: 'Couldn’t load the move-source message anymore.' });
    }
  }

  if (!draftHasContent(draft)) {
    return interaction.reply({
      content: 'Nothing to preview yet — set a title, description, image, thumbnail, or footer first.',
      flags: MessageFlags.Ephemeral,
    });
  }

  return interaction.reply({
    content: 'Preview — nothing has been sent yet.',
    embeds: [draftToEmbed(draft)],
    flags: MessageFlags.Ephemeral,
  });
}

// ---- Send / Move ------------------------------------------------------------------

async function performSend(interaction, draft) {
  const userId = interaction.user.id;
  await interaction.deferUpdate();

  if (!draft.channelId) {
    return finalize(interaction, draft, 'Pick a target channel before sending.');
  }

  const targetChannel = await getChannelCached(interaction.guild.channels, draft.channelId);
  if (!targetChannel || !targetChannel.isTextBased()) {
    return finalize(interaction, draft, 'That target channel is no longer available. Pick another one.');
  }

  // Move Existing takes priority: repost the source embed(s), then delete the original.
  if (draft.moveSourceUrl) {
    const parsed = parseMessageUrl(draft.moveSourceUrl);
    const sourceChannel = await getChannelCached(interaction.client.channels, parsed.channelId);
    if (!sourceChannel) {
      return finalize(interaction, draft, 'Couldn’t reload the move-source message. Set it again.');
    }
    let sourceMessage;
    try {
      sourceMessage = await sourceChannel.messages.fetch(parsed.messageId);
    } catch {
      return finalize(interaction, draft, 'Couldn’t reload the move-source message. Set it again.');
    }
    if (!sourceMessage.embeds.length) {
      return finalize(interaction, draft, 'The move-source message no longer has an embed.');
    }

    let sent;
    try {
      sent = await targetChannel.send({ embeds: sourceMessage.embeds });
    } catch {
      return finalize(interaction, draft, `Couldn’t post to <#${draft.channelId}> — check my permissions there.`);
    }

    let deleteNote = 'Original deleted.';
    try {
      await sourceMessage.delete();
    } catch {
      deleteNote = 'Couldn’t delete the original (missing permissions there) — the repost was still sent.';
    }

    const link = `https://discord.com/channels/${interaction.guildId}/${targetChannel.id}/${sent.id}`;
    resetDraft(userId);
    return finalize(interaction, getDraft(userId), `Moved to <#${draft.channelId}>: ${link}
${deleteNote}`);
  }

  // Otherwise send the manually-built embed.
  if (!draftHasContent(draft)) {
    return finalize(interaction, draft, 'Add a title, description, image, thumbnail, or footer before sending.');
  }

  let sent;
  try {
    sent = await targetChannel.send({ embeds: [draftToEmbed(draft)] });
  } catch {
    return finalize(interaction, draft, `Couldn’t post to <#${draft.channelId}> — check my permissions there.`);
  }

  const link = `https://discord.com/channels/${interaction.guildId}/${targetChannel.id}/${sent.id}`;
  resetDraft(userId);
  return finalize(interaction, getDraft(userId), `Sent to <#${draft.channelId}>: ${link}`);
}

module.exports = { handleButton, handleChannelSelect, handleModalSubmit };
