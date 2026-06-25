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

// ── Config ────────────────────────────────────────────────────
const DISCORD_TOKEN       = process.env.DISCORD_TOKEN;
const CLIENT_ID           = process.env.CLIENT_ID;
const GUILD_ID            = process.env.GUILD_ID;
const VOTE_CHANNEL_ID     = process.env.VOTE_CHANNEL_ID;
const ANNOUNCE_CHANNEL_ID = process.env.ANNOUNCE_CHANNEL_ID;
const ANNOUNCE_ROLE_ID    = process.env.ANNOUNCE_ROLE_ID;
const STATUS_CHANNEL_ID   = '1196857209640988803';
const MIN_VOTES           = parseInt(process.env.MIN_VOTES)   || 1;
const VOTE_MINUTES        = parseInt(process.env.VOTE_MINUTES) || 3;
const COOLDOWN_MINUTES    = parseInt(process.env.COOLDOWN_MINUTES) || 30;
const STATUS_INTERVAL_MS  = 30 * 1000;

// ── IB API ────────────────────────────────────────────────────
const IB_EMAIL           = process.env.IB_EMAIL;
const IB_PASSWORD        = process.env.IB_PASSWORD;
const IB_GUID            = process.env.IB_GUID;
const IB_SERVER_USERNAME = process.env.IB_SERVER_USERNAME;
const IB_SERVER_ID       = process.env.IB_SERVER_ID;

// ── Scheduled restarts (UTC hours) ───────────────────────────
const RESTART_HOURS = [0, 6, 12, 18];

function getNextRestart() {
  const now = new Date();
  const h = now.getUTCHours();
  const m = now.getUTCMinutes();
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
  const unixTs   = Math.floor(next.getTime() / 1000);
  return { timeStr: `<t:${unixTs}:t>`, fullStr: `<t:${unixTs}:F>`, diffHrs, diffMins, diffMs, unix: unixTs };
}

// ── State ─────────────────────────────────────────────────────
let voteActive    = false;
let votes         = { yes: new Set(), no: new Set() };
let voteMessage   = null;
let initiatorName = '';
let voteTimeout   = null;
const userCooldowns = new Map();
let statusMessageId = null;

// ── Helpers ───────────────────────────────────────────────────
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function isAdmin(member) {
  if (!member) return false;
  if (member.id === member.guild.ownerId) return true;
  return member.permissions.has('Administrator');
}

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
  if (!match) { console.error('[IB] Login failed'); return null; }
  return match[0];
}

async function ibServerMsg(cookie, text) {
  try {
    const res = await fetch('https://dashboard.indifferentbroccoli.com/rconsend', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Cookie': cookie },
      body: JSON.stringify({ serverLinuxUsername: IB_SERVER_USERNAME, command: `servermsg "${text}"` }),
    });
    return res.ok;
  } catch (err) { console.error('[IB RCON]', err.message); return false; }
}

// Scrape IB dashboard HTML to get player list and online status
async function ibGetPlayers(cookie) {
  try {
    const res = await fetch('https://dashboard.indifferentbroccoli.com/', {
      method: 'GET',
      headers: { 'Cookie': cookie },
    });
    if (!res.ok) return null;
    const html = await res.text();

    // Check if server shows as offline in the HTML
    const offlineMatch = html.match(/id="EuCM3ZAXFPKJ_monitor_statusText"[^>]*>([^<]*)<\/span>/i);
    if (offlineMatch && offlineMatch[1].trim().toLowerCase() === 'offline') {
      return { online: false, count: 0, players: [] };
    }

    // Get player list from the players-list element
    const listMatch = html.match(/id="players-list-EuCM3ZAXFPKJ"([\s\S]*?)<\/ul>/);
    const players = [];
    if (listMatch) {
      const listHtml = listMatch[1];
      const liMatches = [...listHtml.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/g)];
      for (const match of liMatches) {
        const tokens = match[1]
          .replace(/<[^>]+>/g, '|')
          .split('|')
          .map(t => t.trim())
          .filter(Boolean);
        // tokens: [avatar_letter, name, time_online]
        const timeToken = tokens.find(t => /\d+h\s*\d*m?|\d+m/.test(t)) || '';
        const nameTokens = tokens.filter(t => t !== timeToken && t.length > 1);
        const name = nameTokens[0] || '';
        if (name) players.push({ name, time: timeToken });
      }
    }

    return { online: true, count: players.length, players };
  } catch { return null; }
}

async function ibCheckOnline(cookie) {
  const data = await ibGetPlayers(cookie);
  return data ? data.online : false;
}

// ── Status channel update ─────────────────────────────────────
async function updateStatusChannel(guild) {
  try {
    const channel = guild.channels.cache.get(STATUS_CHANNEL_ID);
    if (!channel) return;

    const cookie = await ibLogin();
    if (!cookie) return;

    const playerData = await ibGetPlayers(cookie);
    const nextR  = getNextRestart();

    let description = '';
    let color = 0xe05555;
    let statusLine = '🔴 **Server Offline**';
    let channelEmoji = '🔴';

    if (playerData?.online) {
      const count   = playerData.count ?? 0;
      const players = playerData.players ?? [];

      color       = 0x5c8c5a;
      channelEmoji = count > 0 ? '🟢' : '🟠';
      statusLine  = count > 0
        ? `🟢 **Server Online** — ${count} survivor${count !== 1 ? 's' : ''} in the field`
        : '🟠 **Server Online** — No survivors online';

      const playerList = players.length > 0
        ? players.map(p => `• ${p.name}${p.time ? ` — ${p.time}` : ''}`).join('\n')
        : '*No survivors currently online*';

      description = [
        statusLine,
        '',
        '**Survivors Online:**',
        playerList,
        '',
        `**Next Restart:** ${nextR.timeStr} — in ${nextR.diffHrs > 0 ? `${nextR.diffHrs}h ${nextR.diffMins}m` : `${nextR.diffMins}m`}`,
      ].join('\n');
    } else {
      description = [
        statusLine,
        '',
        '*The server is currently offline or restarting.*',
        '',
        `**Next Scheduled Restart:** ${nextR.timeStr}`,
      ].join('\n');
    }

    const embed = new EmbedBuilder()
      .setTitle('🐰 Sanctuary Server Status')
      .setDescription(description)
      .setColor(color)
      .setFooter({ text: 'Updates every 30 seconds' })
      .setTimestamp();

    // Try to rename channel emoji
    try {
      const currentName = channel.name;
      const newName = currentName.replace(/^[🟢🔴🟠]/, channelEmoji);
      if (newName !== currentName) await channel.setName(newName).catch(() => {});
    } catch {}

    // Edit existing status message or post a new one
    if (statusMessageId) {
      try {
        const msg = await channel.messages.fetch(statusMessageId);
        await msg.edit({ embeds: [embed] });
        return;
      } catch {
        statusMessageId = null;
      }
    }

    // No existing message — post a new one and pin it
    const sent = await channel.send({ embeds: [embed] });
    statusMessageId = sent.id;
    try { await sent.pin(); } catch {}

  } catch (err) {
    console.error('[Status] Update failed:', err.message);
  }
}

// ── Vote embed ────────────────────────────────────────────────
function buildEmbed(status = 'active') {
  const yesCount = votes.yes.size;
  const noCount  = votes.no.size;
  const total    = yesCount + noCount;
  const color    = status === 'active' ? 0xc8a96e : status === 'passed' ? 0x5c8c5a : 0xe05555;
  const title    = status === 'active' ? '🗳️  Vote: Restart the Server?'
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
    .setFooter({ text: `Min ${MIN_VOTES} vote  •  ${VOTE_MINUTES} min window  •  Next restart: ${getNextRestart().timeStr}` });
}

// ── Restart sequence ──────────────────────────────────────────
async function runRestartSequence(channel) {
  const cookie = await ibLogin();
  async function msg(discord, ingame) {
    await channel.send(discord);
    if (cookie && ingame) await ibServerMsg(cookie, ingame);
  }
  const nextSched = getNextRestart();
  await msg(
    `🗳️ **Vote passed!** Server restarting in **5 minutes** — find a safe spot!\n📅 Next scheduled restart after this: **${nextSched.timeStr}**`,
    'Server Restart Vote Passed: Restarting in 5 minutes!'
  );
  await sleep(2 * 60 * 1000);
  await msg('⏰ **3 minutes** until restart.', 'Server restarting in 3 minutes!');
  await sleep(2 * 60 * 1000);
  await msg('⏰ **1 minute** until restart! Find shelter now!', 'Server restarting in 1 minute!');
  await sleep(60 * 1000);
  await msg('🔄 **Restarting now...**', 'Server is restarting now.');
  try {
    const body = new URLSearchParams({
      guid: IB_GUID,
      serverLinuxUsername: IB_SERVER_USERNAME,
      serverId: IB_SERVER_ID,
    });
    const res = await fetch('https://dashboard.indifferentbroccoli.com/restart', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Cookie': cookie },
      body: body.toString(),
    });
    if (!res.ok) throw new Error('status ' + res.status);
    waitForServerOnline(channel).catch(() => {});
  } catch (err) {
    console.error('[IB] Restart error:', err.message);
    await channel.send('⚠️ **Restart failed!** Please ask an admin to restart manually.');
  }
}

async function waitForServerOnline(channel) {
  const cookie = await ibLogin();
  if (!cookie) return;
  await channel.send('⏳ Waiting for server to come back online...');
  for (let i = 0; i < 20; i++) {
    await sleep(30 * 1000);
    if (await ibCheckOnline(cookie)) {
      await channel.send('✅ **Server is back online!**');
      return;
    }
  }
  await channel.send('⚠️ Server is taking longer than expected. Check the IB dashboard manually.');
}

// ── End vote ──────────────────────────────────────────────────
async function endVote(channel) {
  if (!voteActive) return;
  voteActive = false;
  if (voteTimeout) { clearTimeout(voteTimeout); voteTimeout = null; }
  const yesCount = votes.yes.size;
  const noCount  = votes.no.size;
  const total    = yesCount + noCount;
  const passed   = yesCount > noCount && total >= MIN_VOTES;
  if (voteMessage) {
    try { await voteMessage.edit({ embeds: [buildEmbed(passed ? 'passed' : 'failed')], components: [] }); } catch {}
  }
  if (passed) {
    await runRestartSequence(channel);
  } else {
    const reason = total < MIN_VOTES
      ? `Not enough votes (got **${total}**, need **${MIN_VOTES}**).`
      : `Majority voted no (**${yesCount}** yes vs **${noCount}** no).`;
    await channel.send(`❌ **Vote failed.** ${reason}`);
    try {
      const cookie = await ibLogin();
      if (cookie) await ibServerMsg(cookie, 'Vote Failed: Server will NOT restart.');
    } catch {}
  }
  votes = { yes: new Set(), no: new Set() };
}

// ── Register commands ─────────────────────────────────────────
async function registerCommands() {
  const commands = [
    new SlashCommandBuilder()
      .setName('voterestart')
      .setDescription('Start a community vote to restart the Sanctuary PZ server')
      .toJSON(),
    new SlashCommandBuilder()
      .setName('nextrestart')
      .setDescription('Check when the next scheduled server restart is')
      .toJSON(),
  ];
  const rest = new REST().setToken(DISCORD_TOKEN);
  try {
    await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
    console.log('✅ Commands registered!');
  } catch (err) {
    console.error('⚠️ Could not register commands:', err.message);
  }
}

// ── Discord client ────────────────────────────────────────────
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once('ready', async () => {
  console.log(`✅ Sanctuary Bunny online as ${client.user.tag}`);
  await registerCommands();

  // Initial status update then every 30s
  const guild = client.guilds.cache.get(GUILD_ID);
  if (guild) {
    await updateStatusChannel(guild);
    setInterval(() => updateStatusChannel(guild), STATUS_INTERVAL_MS);
  }
});

client.on('interactionCreate', async (interaction) => {

  // ── /voterestart ─────────────────────────────────────────
  if (interaction.isChatInputCommand() && interaction.commandName === 'voterestart') {
    if (interaction.channelId !== VOTE_CHANNEL_ID) {
      return interaction.reply({ content: `❌ Please use this command in <#${VOTE_CHANNEL_ID}>!`, ephemeral: true });
    }
    if (voteActive) {
      return interaction.reply({ content: '❌ A vote is already in progress!', ephemeral: true });
    }

    const member = interaction.member;
    const admin  = await isAdmin(member);
    if (!admin) {
      const cooldownExpiry = userCooldowns.get(interaction.user.id);
      if (cooldownExpiry && Date.now() < cooldownExpiry) {
        const minutesLeft = Math.ceil((cooldownExpiry - Date.now()) / 60000);
        return interaction.reply({ content: `⏳ You're on cooldown! Please wait **${minutesLeft} more minute(s)**.`, ephemeral: true });
      }
    }

    const nextR = getNextRestart();
    if (nextR.diffMs < 15 * 60 * 1000) {
      return interaction.reply({ content: `⏰ The server restarts in **${nextR.diffMins} minutes** anyway (at ${nextR.timeStr})! No need to vote.`, ephemeral: true });
    }

    userCooldowns.set(interaction.user.id, Date.now() + COOLDOWN_MINUTES * 60 * 1000);
    voteActive    = true;
    votes         = { yes: new Set(), no: new Set() };
    initiatorName = interaction.member?.displayName || interaction.user.username;

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('vote_yes').setLabel('✅  Yes, restart!').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('vote_no').setLabel('❌  No, keep going').setStyle(ButtonStyle.Danger),
    );

    await interaction.reply({ embeds: [buildEmbed('active')], components: [row] });
    voteMessage = await interaction.fetchReply();

    // Ping in general/announce channel
    const announceChannel = interaction.guild.channels.cache.get(ANNOUNCE_CHANNEL_ID);
    if (announceChannel) {
      const roleMention = ANNOUNCE_ROLE_ID ? `<@&${ANNOUNCE_ROLE_ID}>` : '';
      announceChannel.send({
        content: `${roleMention} 🗳️ **A server restart vote has started!** Head to <#${VOTE_CHANNEL_ID}> to vote. Closes in ${VOTE_MINUTES} minutes.`,
        allowedMentions: { roles: ANNOUNCE_ROLE_ID ? [ANNOUNCE_ROLE_ID] : [] }
      }).catch(() => {});
    }

    voteTimeout = setTimeout(() => endVote(interaction.channel), VOTE_MINUTES * 60 * 1000);

    ibLogin().then(cookie => {
      if (cookie) ibServerMsg(cookie, `Restart vote started! Vote on Discord. Closes in ${VOTE_MINUTES} mins!`);
    }).catch(() => {});
    return;
  }

  // ── Vote buttons ──────────────────────────────────────────
  if (interaction.isButton() && ['vote_yes', 'vote_no'].includes(interaction.customId)) {
    if (!voteActive) return interaction.reply({ content: 'This vote has already ended.', ephemeral: true });
    const userId = interaction.user.id;
    const isYes  = interaction.customId === 'vote_yes';
    if (isYes) { votes.yes.add(userId); votes.no.delete(userId); }
    else        { votes.no.add(userId);  votes.yes.delete(userId); }
    if (voteMessage) {
      try { await voteMessage.edit({ embeds: [buildEmbed('active')], components: voteMessage.components }); } catch {}
    }
    await interaction.reply({
      content: `You voted ${isYes ? '✅ **Yes**' : '❌ **No**'}! You can change your vote any time before it closes.`,
      ephemeral: true
    });
  }

  // ── /nextrestart ──────────────────────────────────────────
  if (interaction.isChatInputCommand() && interaction.commandName === 'nextrestart') {
    const r = getNextRestart();
    const timeLeft = r.diffHrs > 0 ? `${r.diffHrs}h ${r.diffMins}m` : `${r.diffMins}m`;
    await interaction.reply(`🕐 **Next Scheduled Restart:** ${r.timeStr} — ${r.fullStr} (in **${timeLeft}**)`);
  }

});

client.login(DISCORD_TOKEN);
