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
  // Plain UTC time string for footers (Discord doesn't render <t:> in embed footers)
  const plainTime = next.toUTCString().match(/(\d{2}:\d{2})/)?.[1] + ' UTC' || '';
  return { timeStr: `<t:${unixTs}:t>`, fullStr: `<t:${unixTs}:F>`, plainTime, diffHrs, diffMins, diffMs, unix: unixTs };
}

// ── State ─────────────────────────────────────────────────────
let voteActive    = false;
let votes         = { yes: new Set(), no: new Set() };
let voteMessage   = null;
let initiatorName = '';
let voteInitiatorId = null;
let voteTimeout   = null;
const userCooldowns = new Map();
const userFailedAttempts = new Map(); // userId -> count of failed votes before cooldown
let statusMessageId = null;

// ── Helpers ───────────────────────────────────────────────────
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function isAdmin(member) {
  if (!member) return false;
  if (member.id === member.guild.ownerId) return true;
  return member.permissions.has('Administrator');
}

// Cached session cookie — avoids hammering IB with a fresh login every cycle
let cachedCookie = null;
let cookieFetchedAt = 0;
const COOKIE_MAX_AGE_MS = 20 * 60 * 1000; // refresh proactively every 20 min

// Performs the actual login POST
async function ibLoginFresh() {
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

// Returns a cached cookie, only logging in again if missing or stale.
// Pass forceRefresh = true to discard the cache (e.g. after a failed request).
async function ibLogin(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && cachedCookie && (now - cookieFetchedAt) < COOKIE_MAX_AGE_MS) {
    return cachedCookie;
  }
  const fresh = await ibLoginFresh();
  if (fresh) {
    cachedCookie = fresh;
    cookieFetchedAt = now;
  }
  return fresh;
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

// ── Get online players by scraping IB dashboard HTML ─────────
async function ibGetPlayers(cookie) {
  try {
    const res = await fetch('https://dashboard.indifferentbroccoli.com/', {
      method: 'GET',
      headers: { 'Cookie': cookie },
    });
    if (!res.ok) return null;
    const html = await res.text();

    // Detect server offline via the monitor status element
    const statusMatch = html.match(/id="[^"]*_monitor_statusText">([^<]+)<\/span>/);
    const serverStatus = statusMatch ? statusMatch[1].trim() : 'Unknown';
    const isOffline = serverStatus === 'Offline' || serverStatus === 'Stopped';

    // Extract max slots
    const maxMatch = html.match(/id="players-container-[^"]*"[^>]*data-max="(\d+)"/);
    const maxSlots = maxMatch ? parseInt(maxMatch[1]) : 16;

    if (!maxMatch && isOffline) return { count: 0, maxSlots: 16, players: [], isOffline: true };
    if (!maxMatch) return null;

    // Extract player list — each li has avatar letter div, then name + time
    const listMatch = html.match(/id="players-list-[^"]*"([\s\S]*?)<\/ul>/);
    const players = [];
    if (listMatch) {
      const liMatches = [...listMatch[1].matchAll(/<li[^>]*>([\s\S]*?)<\/li>/g)];
      for (const match of liMatches) {
        const tokens = match[1]
          .replace(/<[^>]+>/g, '|')
          .split('|')
          .map(t => t.trim())
          .filter(Boolean);
        // Time token looks like "0h 42m" or "5m"
        const timeToken = tokens.find(t => /^\d+h\s*\d*m?$|^\d+m$/.test(t)) || '';
        // Require BOTH name AND time — prevents avatar letter being counted as a player
        const nameTokens = tokens.filter(t => t !== timeToken && t.length > 1);
        const name = nameTokens[0] || '';
        if (name && timeToken) players.push({ name, time: timeToken });
      }
    }

    return { count: players.length, maxSlots, players, isOffline };
  } catch { return null; }
}

async function ibCheckOnline(cookie) {
  const data = await ibGetPlayers(cookie);
  return data ? !data.isOffline : false;
}

// ── Status channel update ─────────────────────────────────────
async function updateStatusChannel(guild) {
  try {
    const channel = guild.channels.cache.get(STATUS_CHANNEL_ID);
    if (!channel) return;

    const cookie = await ibLogin();
    if (!cookie) return;

    let playerData = await ibGetPlayers(cookie);

    // If the cached cookie was stale (scrape failed), force one fresh login and retry
    if (playerData === null) {
      const freshCookie = await ibLogin(true);
      if (freshCookie) playerData = await ibGetPlayers(freshCookie);
    }

    const nextR  = getNextRestart();

    let description = '';
    let color = 0xe05555;
    let statusLine = '🔴 **Server Offline**';
    let channelEmoji = '🔴';

    if (playerData && !playerData.isOffline) {
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

    // No existing message — post a new one
    const sent = await channel.send({ embeds: [embed] });
    statusMessageId = sent.id;

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
    .setFooter({ text: `Min ${MIN_VOTES} vote  •  ${VOTE_MINUTES} min window  •  Next restart: ${getNextRestart().plainTime}` });
}

// ── Restart sequence (instant) ───────────────────────────────
async function runRestartSequence(channel, whoRestarted) {
  const cookie = await ibLogin();
  await channel.send(`**Server is being restarted by ${whoRestarted}.**`);
  if (cookie) await ibServerMsg(cookie, 'Server is restarting now.');
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
  await channel.send('Waiting for server to come back online...');
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
    await runRestartSequence(channel, initiatorName);
    // Successful vote — no cooldown needed (server is restarting)
    userFailedAttempts.delete(voteInitiatorId);
  } else {
    const reason = total < MIN_VOTES
      ? `Not enough votes (got **${total}**, need **${MIN_VOTES}**).`
      : `Majority voted no (**${yesCount}** yes vs **${noCount}** no).`;
    await channel.send(`❌ **Vote failed.** ${reason}`);
    try {
      const cookie = await ibLogin();
      if (cookie) await ibServerMsg(cookie, 'Vote Failed: Server will NOT restart.');
    } catch {}

    // Track failed attempts — 2 allowed before 30 min cooldown kicks in
    if (voteInitiatorId) {
      const attempts = (userFailedAttempts.get(voteInitiatorId) || 0) + 1;
      userFailedAttempts.set(voteInitiatorId, attempts);
      if (attempts >= 2) {
        userCooldowns.set(voteInitiatorId, Date.now() + COOLDOWN_MINUTES * 60 * 1000);
        userFailedAttempts.delete(voteInitiatorId);
      }
    }
  }
  votes = { yes: new Set(), no: new Set() };
  voteInitiatorId = null;
}

// ── Start a vote (shared by command + confirmation) ──────────
async function startVote(interaction) {
  voteActive    = true;
  votes         = { yes: new Set(), no: new Set() };
  initiatorName = interaction.member?.displayName || interaction.user.username;
  voteInitiatorId = interaction.user.id;

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('vote_yes').setLabel('✅  Yes, restart!').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('vote_no').setLabel('❌  No, keep going').setStyle(ButtonStyle.Danger),
  );

  const channel = interaction.guild.channels.cache.get(VOTE_CHANNEL_ID);

  // If this came from a slash command, reply with the vote embed directly.
  // If it came from a confirmation button (already updated), send to channel.
  if (interaction.isChatInputCommand && interaction.isChatInputCommand()) {
    await interaction.reply({ embeds: [buildEmbed('active')], components: [row] });
    voteMessage = await interaction.fetchReply();
  } else {
    voteMessage = await channel.send({ embeds: [buildEmbed('active')], components: [row] });
  }

  voteTimeout = setTimeout(() => endVote(channel), VOTE_MINUTES * 60 * 1000);

  // In-game notice
  ibLogin().then(cookie => {
    if (cookie) ibServerMsg(cookie, `Restart vote started! Vote on Discord. Closes in ${VOTE_MINUTES} mins!`);
  }).catch(() => {});
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

    // If a scheduled restart is coming soon, ASK for confirmation instead of blocking
    const nextR = getNextRestart();
    if (nextR.diffMs < 15 * 60 * 1000) {
      const confirmRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('confirm_restart_yes').setLabel('Yes, restart now').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('confirm_restart_no').setLabel('No, cancel').setStyle(ButtonStyle.Danger),
      );
      return interaction.reply({
        content: `A scheduled restart is happening in **${nextR.diffMins} minute(s)**. Are you sure you want to restart now?`,
        components: [confirmRow],
        ephemeral: true,
      });
    }

    await startVote(interaction);
    return;
  }

  // ── Confirm-restart buttons (when scheduled restart is near) ──
  if (interaction.isButton() && ['confirm_restart_yes', 'confirm_restart_no'].includes(interaction.customId)) {
    if (interaction.customId === 'confirm_restart_no') {
      return interaction.update({ content: 'Restart cancelled.', components: [] });
    }
    await interaction.update({ content: 'Starting restart vote...', components: [] });
    await startVote(interaction);
    return;

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

    // INSTANT pass: if yes-votes meet the minimum and outweigh no-votes, end immediately
    const yesCount = votes.yes.size;
    const noCount  = votes.no.size;
    if (isYes && yesCount >= MIN_VOTES && yesCount > noCount) {
      await interaction.reply({ content: 'Vote passed — restarting now!', ephemeral: true });
      await endVote(interaction.channel);
      return;
    }

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
