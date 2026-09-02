require('dotenv').config();
const { Client, GatewayIntentBits, Collection, Events, MessageFlags } = require('discord.js');

const store = require('./utils/store');
const commandList = require('./commands');
const { handleButton, handleChannelSelect, handleModalSubmit } = require('./handlers/embedInteractions');
const { handleMessageCreate } = require('./handlers/messageTracking');
const { handleVoiceStateUpdate, primeVoiceSessions } = require('./handlers/voiceTracking');
const { handleGuildMemberAdd } = require('./handlers/memberJoin');

if (!process.env.DISCORD_TOKEN) {
  console.error('Missing DISCORD_TOKEN. Copy .env.example to .env and fill it in.');
  process.exit(1);
}

if (!process.env.ALLOWED_USER_IDS) {
  console.error('Missing ALLOWED_USER_IDS. Set a comma-separated list of Discord user IDs allowed to use this bot.');
  process.exit(1);
}

// Every interaction (slash commands and the embed builder's buttons/selects/
// modals) is gated to this set, independent of Discord's own role/permission
// system — so even someone with Administrator on the server can't use the
// bot unless their user ID is explicitly listed here.
const ALLOWED_USER_IDS = new Set(
  process.env.ALLOWED_USER_IDS.split(',').map((id) => id.trim()).filter(Boolean)
);

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
  store.warmRaidProtectCache().catch((err) => console.error('Failed to warm raid-protect cache:', err));

  // Pull the full member list into the gateway cache once, so the cache-first
  // lookup in /stats is a guaranteed hit rather than a coin flip on whether
  // that member happened to be seen recently. Backgrounded — the bot is
  // already serving commands while this runs.
  for (const guild of c.guilds.cache.values()) {
    guild.members
      .fetch()
      .then((members) => console.log(`Primed member cache for ${guild.name}: ${members.size} members.`))
      .catch((err) => console.error(`Failed to prime member cache for ${guild.id}:`, err.message));
  }
});

client.on(Events.MessageCreate, (message) => {
  handleMessageCreate(message).catch((err) => console.error('messageCreate handler error:', err));
});

client.on(Events.VoiceStateUpdate, (oldState, newState) => {
  handleVoiceStateUpdate(oldState, newState).catch((err) =>
    console.error('voiceStateUpdate handler error:', err)
  );
});

client.on(Events.GuildMemberAdd, (member) => {
  handleGuildMemberAdd(member).catch((err) => console.error('guildMemberAdd handler error:', err));
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!ALLOWED_USER_IDS.has(interaction.user.id)) {
    await interaction
      .reply({ content: 'You are not authorized to use this bot.', flags: MessageFlags.Ephemeral })
      .catch(() => {});
    return;
  }

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

store
  .init()
  .then(() => {
    console.log('Database ready.');
    client.login(process.env.DISCORD_TOKEN);
  })
  .catch((err) => {
    console.error('Failed to initialize database:', err);
    process.exit(1);
  });
