require('dotenv').config();
const { Client, GatewayIntentBits, Collection, Events, MessageFlags } = require('discord.js');

const embedCommand = require('./commands/embed');
const { handleButton, handleChannelSelect, handleModalSubmit } = require('./handlers/embedInteractions');

if (!process.env.DISCORD_TOKEN) {
  console.error('Missing DISCORD_TOKEN. Copy .env.example to .env and fill it in.');
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    // Required so "Move Existing" can read the embed on an arbitrary
    // message. Enable "Message Content Intent" for this bot at
    // https://discord.com/developers/applications -> your app -> Bot.
    GatewayIntentBits.MessageContent,
  ],
});

client.commands = new Collection();
client.commands.set(embedCommand.data.name, embedCommand);

client.once(Events.ClientReady, (c) => {
  console.log(`Des Hood Watch is online as ${c.user.tag}`);
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      const command = client.commands.get(interaction.commandName);
      if (!command) return;
      return await command.execute(interaction);
    }

    if (interaction.isButton() && interaction.customId.startsWith('ehb:')) {
      return await handleButton(interaction);
    }

    if (interaction.isChannelSelectMenu() && interaction.customId === 'ehb:channel') {
      return await handleChannelSelect(interaction);
    }

    if (interaction.isModalSubmit() && interaction.customId.startsWith('ehb:modal:')) {
      return await handleModalSubmit(interaction);
    }
  } catch (err) {
    console.error('Interaction error:', err);
    const payload = { content: 'Something went wrong handling that. Try again.', flags: MessageFlags.Ephemeral };
    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.followUp(payload);
      } else {
        await interaction.reply(payload);
      }
    } catch (followUpErr) {
      console.error('Failed to report error to user:', followUpErr);
    }
  }
});

client.login(process.env.DISCORD_TOKEN);
