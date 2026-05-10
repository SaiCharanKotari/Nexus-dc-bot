require('dotenv').config();
const {
    Client,
    GatewayIntentBits,
    AttachmentBuilder,
    REST,
    Routes,
    SlashCommandBuilder,
    EmbedBuilder
} = require('discord.js');

const axios = require('axios');
const fs = require('fs');
const path = require('path');
const http = require('http');

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages
    ]
});

const BACKEND_URL = process.env.BACKEND_URL || 'https://smh-server.onrender.com/download';
const NEXUS_SECRET = process.env.NEXUS_SECRET || 'nexuskey';
const CLIENT_ID = process.env.CLIENT_ID;
const TOKEN = process.env.DISCORD_TOKEN;
const SELF_URL = process.env.SELF_URL || 'https://nexus-dc-bot-q3m1.onrender.com';
const PORT = process.env.PORT || 10000;

// Simple health-check server to prevent Render sleep
http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Bot is alive!');
}).listen(PORT, () => {
    console.log(`Health-check server listening on port ${PORT}`);
});

// Keep-alive ping every 9 minutes
setInterval(() => {
    axios.get(SELF_URL).then(() => {
        console.log(`[Keep-Alive] Pinged ${SELF_URL} successfully.`);
    }).catch(err => {
        console.error(`[Keep-Alive] Ping failed: ${err.message}`);
    });
}, 9 * 60 * 1000);

// Define Slash Commands
const commands = [
    new SlashCommandBuilder()
        .setName('get')
        .setDescription('Download a manifest zip for a given Steam AppID')
        .addStringOption(option =>
            option.setName('appid')
                .setDescription('The Steam AppID of the game')
                .setRequired(true))
].map(command => command.toJSON());

// Register Slash Commands
const rest = new REST({ version: '10' }).setToken(TOKEN);

async function registerCommands() {
    try {
        console.log('Started refreshing application (/) commands.');

        await rest.put(
            Routes.applicationCommands(CLIENT_ID),
            { body: commands },
        );

        console.log('Successfully reloaded application (/) commands.');
    } catch (error) {
        console.error('Error registering commands:', error);
    }
}

client.once('clientReady', async () => {
    console.log(`Logged in as ${client.user.tag}`);
    await registerCommands();
});

const userLimits = new Map();

client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;

    if (interaction.commandName === 'get') {
        const userId = interaction.user.id;
        const appId = interaction.options.getString('appid');

        // Check limit
        const currentUsage = userLimits.get(userId) || 0;
        if (currentUsage >= 5) {
            return interaction.reply({
                content: '❌ You have reached your limit of 5 manifest downloads. Please try again later!',
                ephemeral: true
            });
        }

        try {
            // Acknowledge the interaction PUBLICLY first
            await interaction.reply({
                content: `🔍 **${interaction.user.tag}** is requesting a manifest for AppID: **${appId}**...`,
                ephemeral: false
            });

            // Request backend server
            const response = await axios({
                method: 'GET',
                url: BACKEND_URL,
                params: { 
                    appid: appId,
                    file_type: 'manifest'
                },
                headers: {
                    'nexuskey': NEXUS_SECRET
                },
                responseType: 'arraybuffer'
            });

            // Save zip temporarily
            const fileName = `${appId}_manifest.zip`;
            const filePath = path.join(__dirname, fileName);

            fs.writeFileSync(filePath, response.data);

            // Create Discord attachment
            const attachment = new AttachmentBuilder(filePath);

            // Create success embed for the PUBLIC message
            const successEmbed = new EmbedBuilder()
                .setTitle('Manifest Request Processed!')
                .setAuthor({ 
                    name: interaction.user.tag, 
                    iconURL: interaction.user.displayAvatarURL() 
                })
                .setDescription(`User **${interaction.user.username}** has successfully retrieved the manifest for AppID: **${appId}**.\n\n*The file has been sent to them privately.*`)
                .setImage('https://images-ext-1.discordapp.net/external/0foevzTyhlfGH7kVCvd1cYqpB461l_XmcKO_Ex8aR18/https/images4.alphacoders.com/148/thumb-1920-14808.jpg?format=webp&width=1376&height=860')
                .setColor('#00ff00')
                .setTimestamp();

            // Update the PUBLIC message
            await interaction.editReply({
                content: `✅ Request completed for **${interaction.user.tag}**`,
                embeds: [successEmbed]
            });

            // Send ZIP file PRIVATELY as a follow-up
            await interaction.followUp({
                content: `Enjoy! Here is your manifest for AppID: **${appId}**`,
                files: [attachment],
                ephemeral: true
            });

            // Update limit after success
            userLimits.set(userId, currentUsage + 1);

            // Delete temporary file
            fs.unlinkSync(filePath);

        } catch (error) {
            console.error('Error fetching manifest:', error.response?.status, error.message);
            
            let errorMessage = 'Failed to fetch the manifest ZIP file.';
            if (error.response?.status === 401) {
                errorMessage = '❌ Unauthorized: Invalid secret key.';
            } else if (error.response?.status === 404) {
                errorMessage = `❌ Manifest not found for AppID: **${appId}**.`;
            } else if (error.response?.status === 502) {
                errorMessage = '❌ Backend server error or GitHub API limit reached.';
            }

            // Error messages should stay private
            if (interaction.replied || interaction.deferred) {
                await interaction.followUp({ content: errorMessage, ephemeral: true });
            } else {
                await interaction.reply({ content: errorMessage, ephemeral: true });
            }
        }
    }
});

client.login(TOKEN);