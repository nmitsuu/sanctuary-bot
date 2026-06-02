// ============================================================
//  SANCTUARY — Discord Vote-to-Restart Bot
//  When players vote to restart, sends in-game warnings
//  via RCON then gracefully restarts the PZ server.
// ============================================================

require('dotenv').config();
const {
  Client,
  GatewayIntentBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} = require('discord.js');
const { Rcon } = require('rcon-client');

// ── Config (set these as environment variables in Railway) ───
const DISCORD_TOKEN       = process.env.DISCORD_TOKEN;
const VOTE_CHANNEL_ID     = process.env.VOTE_CHANNEL_ID;     // #vote-restart channel ID
const ANNOUNCE_CHANNEL_ID = process.env.ANNOUNCE_CHANNEL_ID; // #general channel
const ANNOUNCE_ROLE_ID    = process.env.ANNOUNCE_ROLE_ID;    // role to ping (e.g. Tester role) ID
const RCON_HOST           = process.env.RCON_HOST;           // your server IP
const RCON_PORT           = parseInt(process.env.RCON_PORT)  || 27015;
const RCON_PASSWORD       = process.env.RCON_PASSWORD;
const MIN_VOTES           = parseInt(process.env.MIN_VOTES)  || 3;
const VOTE_MINUTES        = parseInt(process.env.VOTE_MINUTES) || 3;
const COOLDOWN_MINUTES    = parseInt(process.env.COOLDOWN_MINUTES) || 30;

// ── State ────────────────────────────────────────────────────
let voteActive    = false;
let votes         = { yes: new Set(), no: new Set() };
let voteMessage   = null;
let initiatorName = '';
let voteTimeout   = null;
let lastVoteEnd   = null;

// ── Helpers ──────────────────────────────────────────────────
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function sendRcon(command) {
  const rcon = new Rcon({ host: RCON_HOST, port: RCON_PORT, password: RCON_PASSWORD });
  try {
    await rcon.connect();
    await rcon.send(command);
    await rcon.end();
    return true;
  } catch (err) {
    console.error('[RCON error]', err.message);
    return false;
  }
}

async function serverMsg(text) {
  return await sendRcon(`servermsg "${text}"`);
}

// ── Vote embed builder ────────────────────────────────────────
function buildEmbed(status = 'active') {
  const yesCount = votes.yes.size;
  const noCount  = votes.no.size;
  const total    = yesCount + noCount;

  const color = status === 'active' ? 0xc8a96e
              : status === 'passed' ? 0x5c8c5a
              : 0xe05555;

  const title = status === 'active' ? '🗳️  Vote: Restart the Server?'
              : status === 'passed' ? '✅  Vote Passed — Restarting!'
              : '❌  Vote Failed';

  return new EmbedBuilder()
    .setTitle(title)
    .setDescription(
      `**${initiatorName}** has called for a restart.\n\n` +
      `✅  Yes: **${yesCount}**　　❌  No: **${noCount}**\n` +
      `Total votes: **${total}** / ${MIN_VOTES} minimum\n\n` +
      (status === 'active' ? '*You can change your vote at any time.*' : '')
    )
    .setColor(color)
    .setFooter({ text: `Majority wins  •  Min ${MIN_VOTES} votes  •  ${VOTE_MINUTES} min window` });
}

// ── Restart sequence (runs after vote passes) ─────────────────
async function runRestartSequence(channel) {
  const ok = await serverMsg('A player vote has passed! Server restarting in 10 minutes — find a safe spot!');
  if (!ok) {
    await channel.send('⚠️ **Could not reach the server via RCON.** Please ask an admin to restart manually using the IB bot.');
    voteActive = false;
    return;
  }
  await channel.send('🗳️ **Vote passed!** Server restarting in **10 minutes**. In-game announcement sent!');

  await sleep(5 * 60 * 1000);
  await serverMsg('Server restarting in 5 minutes!');
  await channel.send('⏰ **5 minutes** until restart.');

  await sleep(4 * 60 * 1000);
  await serverMsg('Server restarting in 1 minute! Please find shelter now!');
  await channel.send('⏰ **1 minute** until restart!');

  await sleep(60 * 1000);
  await serverMsg('Restarting now — see you on the other side!');
  await channel.send('🔄 **Restarting server now...**');

  await sleep(3000);
  await sendRcon('quit');
}

// ── End vote and tally ────────────────────────────────────────
async function endVote(channel) {
  if (!voteActive) return;
  voteActive  = false;
  lastVoteEnd = Date.now();
  if (voteTimeout) { clearTimeout(voteTimeout); voteTimeout = null; }

  const yesCount = votes.yes.size;
  const noCount  = votes.no.size;
  const total    = yesCount + noCount;
  const passed   = yesCount > noCount && total >= MIN_VOTES;

  if (voteMessage) {
    try {
      await voteMessage.edit({ embeds: [buildEmbed(passed ? 'passed' : 'failed')], components: [] });
    } catch (_) {}
  }

  if (passed) {
    await runRestartSequence(channel);
  } else {
    const reason = total < MIN_VOTES
      ? `Not enough votes (got **${total}**, need **${MIN_VOTES}**).`
      : `Majority voted no (**${yesCount}** yes vs **${noCount}** no).`;
    await channel.send(`❌ **Vote failed.** ${reason}`);
  }

  votes = { yes: new Set(), no: new Set() };
}

// ── Discord client ────────────────────────────────────────────
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once('ready', () => {
  console.log(`✅ Sanctuary Bot online as ${client.user.tag}`);
});

client.on('interactionCreate', async (interaction) => {

  // /voterestart command
  if (interaction.isChatInputCommand() && interaction.commandName === 'voterestart') {

    if (interaction.channelId !== VOTE_CHANNEL_ID) {
      return interaction.reply({
        content: `❌ Please use this command in <#${VOTE_CHANNEL_ID}>!`,
        ephemeral: true
      });
    }

    if (voteActive) {
      return interaction.reply({
        content: '❌ A vote is already in progress! Head to this channel to vote.',
        ephemeral: true
      });
    }

    if (lastVoteEnd) {
      const elapsed    = Date.now() - lastVoteEnd;
      const cooldownMs = COOLDOWN_MINUTES * 60 * 1000;
      if (elapsed < cooldownMs) {
        const minutesLeft = Math.ceil((cooldownMs - elapsed) / 60000);
        return interaction.reply({
          content: `⏳ Please wait **${minutesLeft} more minute(s)** before starting another vote.`,
          ephemeral: true
        });
      }
    }

    voteActive    = true;
    votes         = { yes: new Set(), no: new Set() };
    initiatorName = interaction.member?.displayName || interaction.user.username;

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('vote_yes')
        .setLabel('✅  Yes, restart!')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId('vote_no')
        .setLabel('❌  No, keep going')
        .setStyle(ButtonStyle.Danger),
    );

    await interaction.reply({ embeds: [buildEmbed('active')], components: [row] });
    voteMessage = await interaction.fetchReply();

    // Announce in general channel, pinging the designated role
    const announceChannel = interaction.guild.channels.cache.get(ANNOUNCE_CHANNEL_ID);
    if (announceChannel) {
      const roleMention = ANNOUNCE_ROLE_ID ? `<@&${ANNOUNCE_ROLE_ID}>` : '';
      announceChannel.send({
        content: `${roleMention} 🗳️ **A server restart vote has started!** Head to <#${VOTE_CHANNEL_ID}> to vote. Voting closes in ${VOTE_MINUTES} minutes.`,
        allowedMentions: { roles: ANNOUNCE_ROLE_ID ? [ANNOUNCE_ROLE_ID] : [] }
      }).catch(() => {});
    }

    voteTimeout = setTimeout(
      () => endVote(interaction.channel),
      VOTE_MINUTES * 60 * 1000
    );
    return;
  }

  // Vote buttons
  if (interaction.isButton() && ['vote_yes', 'vote_no'].includes(interaction.customId)) {
    if (!voteActive) {
      return interaction.reply({ content: 'This vote has already ended.', ephemeral: true });
    }

    const userId = interaction.user.id;
    const isYes  = interaction.customId === 'vote_yes';

    if (isYes) { votes.yes.add(userId);  votes.no.delete(userId);  }
    else        { votes.no.add(userId);   votes.yes.delete(userId); }

    if (voteMessage) {
      try {
        await voteMessage.edit({ embeds: [buildEmbed('active')], components: voteMessage.components });
      } catch (_) {}
    }

    await interaction.reply({
      content: `You voted ${isYes ? '✅ **Yes**' : '❌ **No**'}! You can change your vote any time before it closes.`,
      ephemeral: true
    });
  }
});

client.login(DISCORD_TOKEN);
