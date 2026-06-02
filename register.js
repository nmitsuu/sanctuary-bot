// ============================================================
//  Run this ONCE to register the /voterestart slash command.
//  node register.js
// ============================================================

require('dotenv').config();
const { REST, Routes, SlashCommandBuilder } = require('discord.js');

const commands = [
  new SlashCommandBuilder()
    .setName('voterestart')
    .setDescription('Start a community vote to restart the Sanctuary PZ server')
    .toJSON()
];

const rest = new REST().setToken(process.env.DISCORD_TOKEN);

(async () => {
  try {
    console.log('Registering slash commands...');
    await rest.put(
      Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID),
      { body: commands }
    );
    console.log('✅ /voterestart registered successfully!');
  } catch (err) {
    console.error('❌ Error registering commands:', err);
  }
})();
