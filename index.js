require('dotenv').config();
const { Client, GatewayIntentBits, Collection, Events, MessageFlags } = require('discord.js');

const commandList = require('./commands');
const { handleButton, handleChannelSelect, handleModalSubmit } = require('./handlers/embedInteractions');
const { handleMessageCreate } = require('./handlers/messageTracking');
const { handleVoiceStateUpdate, primeVoiceSessions } = require('./handlers/voiceTracking');
const { handleGuildMemberAdd } = require('./handlers/memberJoin');

if (!process.env.DISCORD_TOKEN) {
  console.error('Missing DISCORD_TOKEN. Copy .env.example to .env and fill it in.');
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    // Required for /stats voice-time tracking.
    GatewayIntentBits.GuildVoiceStates,
    // Required for guildMemberAdd to fire at all (raidprotect auto-kick
    // and mass-join detection). Enable "Server Members Intent" for this
    // bot at https://discord.com/developers/applications -> your app -> Bot.
    GatewayIntentBits.GuildMembers,
    // Required so "Move Existing" and /secure can read message content.
    // Enable "Message Content Intent" for this bot at
    // https://discord.com/developers/applications -> your app -> Bot.
    GatewayIntentBits.MessageContent,
  ],
});

client.commands = new Collection();
for (const command of commandList) {
  client.commands.set(command.data.name, command);
}

client.once(Events.ClientReady, (c) => {
  console.log(`Des Hood Watch is online as ${c.user.tag}`);
  primeVoiceSessions(c);
});

client.on(Events.MessageCreate, (message) => {
  handleMessageCreate(message).catch((err) => console.error('messageCreate handler error:', err));
});

client.on(Events.VoiceStateUpdate, (oldState, newState) => {
  try {
    handleVoiceStateUpdate(oldState, newState);
  } catch (err) {
    console.error('voiceStateUpdate handler error:', err);
  }
});

client.on(Events.GuildMemberAdd, (member) => {
  handleGuildMemberAdd(member).catch((err) => console.error('guildMemberAdd handler error:', err));
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
