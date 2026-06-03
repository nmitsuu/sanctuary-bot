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
  REST,
  Routes,
  SlashCommandBuilder,
} = require('discord.js');

// ── Config (set these as environment variables in Railway) ───
const DISCORD_TOKEN       = process.env.DISCORD_TOKEN;
const VOTE_CHANNEL_ID     = process.env.VOTE_CHANNEL_ID;
const ANNOUNCE_CHANNEL_ID = process.env.ANNOUNCE_CHANNEL_ID;
const ANNOUNCE_ROLE_ID    = process.env.ANNOUNCE_ROLE_ID;
const MIN_VOTES           = parseInt(process.env.MIN_VOTES)  || 2;
const VOTE_MINUTES        = parseInt(process.env.VOTE_MINUTES) || 3;
const COOLDOWN_MINUTES    = parseInt(process.env.COOLDOWN_MINUTES) || 30;

// ── IB Dashboard API config ───────────────────────────────────
const IB_EMAIL            = process.env.IB_EMAIL;
const IB_PASSWORD         = process.env.IB_PASSWORD;
const IB_GUID             = process.env.IB_GUID;
const IB_SERVER_USERNAME  = process.env.IB_SERVER_USERNAME;
const IB_SERVER_ID        = process.env.IB_SERVER_ID;

// ── Scheduled restart times (UTC hours, matches IB scheduler) ─
const RESTART_HOURS = [0, 6, 12, 18];

function getNextRestart() {
  const now = new Date();
  const h = now.getUTCHours();
  const m = now.getUTCMinutes();

  // Find next restart hour today, or wrap to tomorrow
  let nextHour = RESTART_HOURS.find(r => r > h || (r === h && m === 0));
  const next = new Date(now);
  next.setUTCSeconds(0, 0);
  next.setUTCMinutes(0);
  if (nextHour !== undefined) {
    next.setUTCHours(nextHour);
  } else {
    next.setUTCDate(next.getUTCDate() + 1);
    next.setUTCHours(RESTART_HOURS[0]);
  }

  const diffMs   = next - now;
  const diffHrs  = Math.floor(diffMs / 3600000);
  const diffMins = Math.floor((diffMs % 3600000) / 60000);
  const timeStr  = `${String(next.getUTCHours()).padStart(2,'0')}:00 UTC`;

  const unixTs = Math.floor(next.getTime() / 1000);
  return { timeStr: `<t:${unixTs}:t>`, fullStr: `<t:${unixTs}:F>`, diffHrs, diffMins, diffMs };
}

// ── State ────────────────────────────────────────────────────
let voteActive    = false;
let votes         = { yes: new Set(), no: new Set() };
let voteMessage   = null;
let initiatorName = '';
let voteTimeout   = null;
let lastVoteEnd   = null;

// ── Helpers ──────────────────────────────────────────────────
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Log in to IB dashboard and return session cookie
async function ibLogin() {
  const body = new URLSearchParams({ email: IB_EMAIL, password: IB_PASSWORD });
  const res = await fetch('https://dashboard.indifferentbroccoli.com/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    redirect: 'manual',
  });
  const setCookie = res.headers.get('set-cookie') || '';
  const match = setCookie.match(/indifferentSess=[^;]+/);
  if (!match) {
    console.error('[IB] Login failed — could not get session cookie');
    return null;
  }
  console.log('[IB] Login successful');
  return match[0];
}

// Restart the server via IB dashboard API
async function ibRestart() {
  try {
    const cookie = await ibLogin();
    if (!cookie) return false;

    const body = new URLSearchParams({
      guid:                IB_GUID,
      serverLinuxUsername: IB_SERVER_USERNAME,
      serverId:            IB_SERVER_ID,
    });

    const res = await fetch('https://dashboard.indifferentbroccoli.com/restart', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Cookie': cookie,
      },
      body: body.toString(),
    });

    if (res.ok) {
      console.log('[IB] Restart triggered successfully');
      return true;
    } else {
      console.error('[IB] Restart failed — status:', res.status);
      return false;
    }
  } catch (err) {
    console.error('[IB] Restart error:', err.message);
    return false;
  }
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
    .setFooter({ text: `Majority wins  •  Min ${MIN_VOTES} votes  •  ${VOTE_MINUTES} min window  •  Next scheduled restart: ${getNextRestart().timeStr}` });
}

// Send an in-game message via IB dashboard RCON
async function ibServerMsg(cookie, text) {
  try {
    const res = await fetch('https://dashboard.indifferentbroccoli.com/rconsend', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Cookie': cookie,
      },
      body: JSON.stringify({
        serverLinuxUsername: IB_SERVER_USERNAME,
        command: `servermsg "${text}"`,
      }),
    });
    return res.ok;
  } catch (err) {
    console.error('[IB RCON error]', err.message);
    return false;
  }
}

// Check if PZ server is online by pinging via RCON
async function ibCheckOnline(cookie) {
  try {
    const res = await fetch('https://dashboard.indifferentbroccoli.com/rconsend', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Cookie': cookie },
      body: JSON.stringify({
        serverLinuxUsername: IB_SERVER_USERNAME,
        command: 'players',
      }),
    });
    if (!res.ok) return false;
    const text = await res.text();
    // If response contains error/offline indicators, server is down
    const lower = text.toLowerCase();
    return !lower.includes('offline') && !lower.includes('not running') && !lower.includes('error');
  } catch {
    return false;
  }
}

// Poll until server is back online, then post in Discord
async function waitForServerOnline(channel) {
  const cookie = await ibLogin();
  if (!cookie) return;

  await channel.send('⏳ Waiting for server to come back online...');

  const maxAttempts = 20; // up to 10 minutes (every 30s)
  for (let i = 0; i < maxAttempts; i++) {
    await sleep(30 * 1000);
    const online = await ibCheckOnline(cookie);
    if (online) {
      await channel.send('✅ **Server Restarted:** Server is now back online!');
      return;
    }
  }
  await channel.send('⚠️ Server is taking longer than expected. Please check the IB dashboard manually.');
}

// ── Get online players via RCON ───────────────────────────────
async function ibGetPlayers(cookie) {
  try {
    const res = await fetch('https://dashboard.indifferentbroccoli.com/rconsend', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Cookie': cookie },
      body: JSON.stringify({ serverLinuxUsername: IB_SERVER_USERNAME, command: 'players' }),
    });
    if (!res.ok) return null;
    const raw  = await res.text();
    // Try JSON first, fall back to raw text
    let text = raw;
    try { const j = JSON.parse(raw); text = j.output || j.result || j.data || raw; } catch {}

    const countMatch = text.match(/Players connected \((\d+)\)/i);
    const count = countMatch ? parseInt(countMatch[1]) : 0;
    const players = text.split('\n')
      .filter(l => l.trim().startsWith('-'))
      .map(l => l.trim().slice(1).trim())
      .filter(Boolean);
    return { count, players };
  } catch { return null; }
}

// ── Restart sequence (runs after vote passes) ─────────────────
async function runRestartSequence(channel) {
  // Login once and reuse the cookie for all IB calls
  const cookie = await ibLogin();

  async function msg(discord, ingame) {
    await channel.send(discord);
    if (cookie && ingame) await ibServerMsg(cookie, ingame);
  }

  const nextSched = getNextRestart();
  await msg(
    `🗳️ **Vote passed!** Server restarting in **5 minutes** — find a safe spot!\n📅 Next scheduled restart after this: **${nextSched.timeStr}**`,
    'Server Restart Vote Started: Restarting in 5 minutes!'
  );

  await sleep(2 * 60 * 1000);
  await msg('⏰ **3 minutes** until restart.', 'Server Restart Vote Started: Restarting in 3 minutes!');

  await sleep(2 * 60 * 1000);
  await msg('⏰ **1 minute** until restart! Find shelter now!', 'Server Restart Vote Started: Restarting in 1 minute!');

  await sleep(60 * 1000);
  await msg('🔄 **Restarting now...**', 'Server is restarting now.');

  // Trigger restart via IB API (reuse same cookie)
  try {
    const body = new URLSearchParams({
      guid:                IB_GUID,
      serverLinuxUsername: IB_SERVER_USERNAME,
      serverId:            IB_SERVER_ID,
    });
    const res = await fetch('https://dashboard.indifferentbroccoli.com/restart', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Cookie': cookie },
      body: body.toString(),
    });
    if (!res.ok) throw new Error('status ' + res.status);
    console.log('[IB] Restart triggered successfully');
    // Start polling for server to come back online
    waitForServerOnline(channel).catch(() => {});
  } catch (err) {
    console.error('[IB] Restart error:', err.message);
    await channel.send('⚠️ **Restart failed!** Could not reach the IB dashboard. Please ask an admin to restart manually.');
  }
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

// ── Auto-register slash commands on startup ───────────────────
async function registerCommands() {
  const commands = [
    new SlashCommandBuilder()
      .setName('voterestart')
      .setDescription('Start a community vote to restart the Sanctuary PZ server')
      .toJSON(),
    new SlashCommandBuilder()
      .setName('servercheck')
      .setDescription('Check if the Sanctuary PZ server is online or offline')
      .toJSON(),
    new SlashCommandBuilder()
      .setName('nextrestart')
      .setDescription('Check when the next scheduled server restart is')
      .toJSON(),
    new SlashCommandBuilder()
      .setName('players')
      .setDescription('See who is currently online on the Sanctuary PZ server')
      .toJSON(),
  ];
  const rest = new REST().setToken(DISCORD_TOKEN);
  try {
    await rest.put(
      Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID),
      { body: commands }
    );
    console.log('✅ /voterestart command registered!');
  } catch (err) {
    console.error('⚠️ Could not register commands:', err.message);
  }
}

// ── Discord client ────────────────────────────────────────────
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once('ready', async () => {
  console.log(`✅ Sanctuary Bot online as ${client.user.tag}`);
  await registerCommands();
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

    // Block vote if a scheduled restart is happening soon
    const nextR = getNextRestart();
    if (nextR.diffMs < 15 * 60 * 1000) {
      return interaction.reply({
        content: `⏰ The server restarts in **${nextR.diffMins} minutes** anyway (at ${nextR.timeStr})! No need to vote.`,
        ephemeral: true
      });
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

    // Announce in-game that a vote has started
    ibLogin().then(cookie => {
      if (cookie) ibServerMsg(cookie, `Restart vote started! Vote on Discord in #vote-restart. Closes in ${VOTE_MINUTES} mins!`);
    }).catch(() => {});

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


// ── /servercheck command ─────────────────────────────────────
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand() || interaction.commandName !== 'servercheck') return;

  await interaction.deferReply();

  const cookie = await ibLogin();
  if (!cookie) {
    return interaction.editReply('❌ Could not connect to the server management panel. Try again later.');
  }

  const online = await ibCheckOnline(cookie);
  if (online) {
    await interaction.editReply('✅ **Server Status:** Online and running!');
  } else {
    await interaction.editReply('🔴 **Server Status:** Offline or currently restarting.');
  }
});

// ── /nextrestart command ─────────────────────────────────────
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand() || interaction.commandName !== 'nextrestart') return;
  const r = getNextRestart();
  const timeLeft = r.diffHrs > 0
    ? `${r.diffHrs}h ${r.diffMins}m`
    : `${r.diffMins} minutes`;
  await interaction.reply(`🕐 **Next Scheduled Restart:** ${r.timeStr} — ${r.fullStr} (in **${timeLeft}**)` );
});

// ── /players command ──────────────────────────────────────────
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand() || interaction.commandName !== 'players') return;

  await interaction.deferReply();

  const cookie = await ibLogin();
  if (!cookie) {
    return interaction.editReply('❌ Could not connect to the server management panel.');
  }

  try {
    const res = await fetch('https://dashboard.indifferentbroccoli.com/rconsend', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Cookie': cookie },
      body: JSON.stringify({ serverLinuxUsername: IB_SERVER_USERNAME, command: 'players' }),
    });

    const raw = await res.text();
    console.log('[/players debug] status:', res.status, 'body:', raw.slice(0, 300));

    if (!res.ok) {
      return interaction.editReply(`🔴 **Server appears to be offline.** No player data available.\n\`status: ${res.status}\``);
    }

    // Try to parse JSON wrapper if present
    let playerText = raw;
    try {
      const parsed = JSON.parse(raw);
      playerText = parsed.result || parsed.message || parsed.output || raw;
    } catch (_) {}

    if (!playerText || playerText.toLowerCase().includes('offline') || playerText.toLowerCase().includes('not running')) {
      return interaction.editReply('🔴 **Server appears to be offline.** No player data available.');
    }

    // Format nicely
    const lines = playerText.trim().split('\n').filter(l => l.trim());
    const header = lines[0] || 'Players connected (0):';
    const players = lines.slice(1).map(l => l.replace(/^-/, '').trim()).filter(Boolean);

    if (players.length === 0) {
      await interaction.editReply(`👻 **No players online** right now.\n\n*${header}*`);
    } else {
      const list = players.map(p => `• ${p}`).join('\n');
      await interaction.editReply(`🟢 **Players Online (${players.length}):**\n${list}`);
    }
  } catch (err) {
    await interaction.editReply('❌ Could not fetch player list. Try again later.');
  }
});

client.login(DISCORD_TOKEN);
