require('dotenv').config();
const { REST, Routes } = require('discord.js');
const commandList = require('./commands');

const { DISCORD_TOKEN, CLIENT_ID, GUILD_ID } = process.env;

if (!DISCORD_TOKEN || !CLIENT_ID) {
  console.error('Missing DISCORD_TOKEN or CLIENT_ID in your .env file.');
  process.exit(1);
}

const commands = commandList.map((c) => c.data.toJSON());
const rest = new REST().setToken(DISCORD_TOKEN);

(async () => {
  try {
    if (GUILD_ID) {
      // Guild-scoped: shows up in that one server within seconds. Best for setup/testing.
      await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
      console.log(`Registered ${commands.length} commands to guild ${GUILD_ID}.`);
    } else {
      // Global: can take up to ~1 hour to propagate to every server the bot is in.
      await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
      console.log(`Registered ${commands.length} commands globally.`);
    }
  } catch (err) {
    console.error('Failed to register commands:', err);
    process.exit(1);
  }
})();
