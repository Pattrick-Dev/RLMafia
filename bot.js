require('dotenv').config();
const {
  Client, GatewayIntentBits, SlashCommandBuilder, REST, Routes,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
} = require('discord.js');
const express = require('express');
const fs      = require('fs');
const path    = require('path');
const crypto  = require('crypto');
const https   = require('https');

// ── Config ───────────────────────────────────────────────────────────────────
const TOKEN                  = process.env.DISCORD_TOKEN;
const CLIENT_ID              = process.env.CLIENT_ID;
const CLIENT_SECRET          = process.env.DISCORD_CLIENT_SECRET;
const REDIRECT_URI           = process.env.DISCORD_REDIRECT_URI;
const GUILD_ID               = process.env.GUILD_ID || null;
const WEB_PORT               = process.env.WEB_PORT || 3000;
const DATA_FILE              = path.join(__dirname, 'data.json');
const ADMIN_USER_ID          = '251503326447927306';

if (!TOKEN || !CLIENT_ID) {
  console.error('Missing DISCORD_TOKEN or CLIENT_ID environment variables.');
  process.exit(1);
}

// ── Settings (per-guild, persisted) ──────────────────────────────────────────
// Defaults — overridden per guild via dashboard
const DEFAULT_SETTINGS = {
  voteTimeoutSecs:  60,
  reminderSecs:     30,
  minPlayers:       2,
  mafiaCount:       1, // how many mafia per round
  doubleAgentChance: 0, // legacy random double-agent chance
};

const guildSettings = new Map(); // guildId → settings object

function getSettings(guildId) {
  if (!guildSettings.has(guildId)) guildSettings.set(guildId, { ...DEFAULT_SETTINGS });
  return guildSettings.get(guildId);
}

const MAX_HISTORY       = 20; // rounds to keep per guild

// ── State ─────────────────────────────────────────────────────────────────────
const gameState = new Map();   // guildId → round state
const history   = new Map();   // guildId → [roundRecord]
const scores    = new Map();   // guildId → { username → { townWins, mafiaWins, timesAsMafia, totalRounds } }

// ── Session store (Discord OAuth) ────────────────────────────────────────────
// token → { discordId, username, avatar, expiresAt }
const sessions = new Map();

function createSession(discordId, username, avatar) {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { discordId, username, avatar, expiresAt: Date.now() + 24 * 60 * 60 * 1000 });
  return token;
}

function getSession(token) {
  if (!token) return null;
  const s = sessions.get(token);
  if (!s) return null;
  if (Date.now() > s.expiresAt) { sessions.delete(token); return null; }
  return s;
}

function isAdmin(token) {
  const s = getSession(token);
  return s && s.discordId === ADMIN_USER_ID;
}

function fetchDiscordUser(accessToken) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'discord.com',
      path: '/api/v10/users/@me',
      headers: { Authorization: 'Bearer ' + accessToken },
    }, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch { reject(new Error('Bad JSON')); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function exchangeCode(code) {
  return new Promise((resolve, reject) => {
    const body = new URLSearchParams({
      client_id:     CLIENT_ID,
      client_secret: CLIENT_SECRET,
      grant_type:    'authorization_code',
      code,
      redirect_uri:  REDIRECT_URI,
    }).toString();

    const req = https.request({
      hostname: 'discord.com',
      path: '/api/v10/oauth2/token',
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch { reject(new Error('Bad JSON')); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── Persistent data ───────────────────────────────────────────────────────────
function saveData() {
  try {
    const out = { history: {}, scores: {}, settings: {}, activeGames: {} };
    for (const [id, h] of history.entries())       out.history[id]   = h;
    for (const [id, s] of scores.entries())        out.scores[id]    = s;
    for (const [id, s] of guildSettings.entries()) out.settings[id]  = s;
    // Persist active game state (sans timers/message objects)
    for (const [id, state] of gameState.entries()) {
      if (state.players && state.players.length) {
        out.activeGames[id] = {
          guildId:       id,
          mafiaUsername: state.mafiaUsername,
          players:       state.players,
          optedOut:      [...state.optedOut],
          startedBy:     state.startedBy,
          channelId:     state.channelId,
          active:        state.active,
          roundStartTime: state.roundStartTime,
          testMode:      state.testMode || false,
        };
      }
    }
    fs.writeFileSync(DATA_FILE, JSON.stringify(out, null, 2));
  } catch (e) { console.error('Save error:', e); }
}

function loadData() {
  try {
    if (!fs.existsSync(DATA_FILE)) return;
    const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    if (data.history)  for (const [id, h] of Object.entries(data.history))  history.set(id, h);
    if (data.scores)   for (const [id, s] of Object.entries(data.scores))   scores.set(id, s);
    if (data.settings) for (const [id, s] of Object.entries(data.settings)) guildSettings.set(id, { ...DEFAULT_SETTINGS, ...s });
    if (data.activeGames) {
      for (const [id, g] of Object.entries(data.activeGames)) {
        gameState.set(id, {
          ...g,
          optedOut:      new Set(g.optedOut || []),
          votes:         {},
          votedIds:      new Set(),
          voteTimer:     null,
          reminderTimer: null,
          countdownTimer: null,
          voteStartTime: null,
          tiebreaker:    false,
          tiedNames:     null,
          voteMessage:   null,
          paused:        false,
        });
      }
      console.log(`Restored ${Object.keys(data.activeGames).length} active game(s) from data.json`);
    }
    console.log('Data loaded from data.json');
  } catch (e) { console.error('Load error:', e); }
}

loadData();

// ── Commands ──────────────────────────────────────────────────────────────────
const commands = [
  new SlashCommandBuilder().setName('startgame').setDescription('Pick a mafia player from your voice channel').toJSON(),
  new SlashCommandBuilder().setName('newround').setDescription('Re-roll a new mafia from the same player pool').toJSON(),
  new SlashCommandBuilder().setName('vote').setDescription('Start a private vote to find the mafia').toJSON(),
  new SlashCommandBuilder().setName('endvote').setDescription('End the vote early and reveal now').toJSON(),
  new SlashCommandBuilder().setName('status').setDescription('Show current game status and vote progress').toJSON(),
  new SlashCommandBuilder().setName('history').setDescription('Show recent round history').toJSON(),
  new SlashCommandBuilder().setName('score').setDescription('Show player scoreboard').toJSON(),
  new SlashCommandBuilder()
    .setName('optout').setDescription('Opt a player out of the game')
    .addUserOption((o) => o.setName('player').setDescription('Player to opt out (blank = yourself)').setRequired(false))
    .toJSON(),
  new SlashCommandBuilder()
    .setName('optin').setDescription('Opt a player back into the game')
    .addUserOption((o) => o.setName('player').setDescription('Player to opt back in (blank = yourself)').setRequired(false))
    .toJSON(),
  new SlashCommandBuilder()
    .setName('testgame')
    .setDescription('Start a solo test game (bypasses voice channel and player requirements)')
    .toJSON(),
  new SlashCommandBuilder()
    .setName('kick')
    .setDescription('Remove a player from the current game')
    .addUserOption((o) => o.setName('player').setDescription('Player to kick').setRequired(true))
    .toJSON(),
  new SlashCommandBuilder().setName('pause').setDescription('Pause the current vote timer').toJSON(),
  new SlashCommandBuilder().setName('resume').setDescription('Resume a paused vote timer').toJSON(),
  new SlashCommandBuilder().setName('standings').setDescription('Post the current standings in chat').toJSON(),
  new SlashCommandBuilder().setName('dashboard').setDescription('Get the dashboard link').toJSON(),
  new SlashCommandBuilder().setName('endgame').setDescription('End the current game session and reset state').toJSON(),
];

const rest = new REST({ version: '10' }).setToken(TOKEN);
(async () => {
  console.log('Registering slash commands...');
  if (GUILD_ID) {
    // Clear global commands so there are no duplicates
    await rest.put(Routes.applicationCommands(CLIENT_ID), { body: [] });
    await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
    console.log('Commands registered (guild-specific — instant). Global commands cleared.');
  } else {
    await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
    console.log('Commands registered (global — may take up to 1 hour).');
  }
})();

// ── Discord client ────────────────────────────────────────────────────────────
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates, GatewayIntentBits.GuildMessages],
});
client.once('ready', () => {
  console.log(`Logged in as ${client.user.tag}`);
  updateBotStatus();
});

function updateBotStatus() {
  // Count active games
  let activePlayers = 0;
  let activeGames = 0;
  for (const [, state] of gameState.entries()) {
    if (state.active) {
      activeGames++;
      activePlayers += state.players.filter(p => !state.optedOut.has(p.id)).length;
    }
  }
  if (activeGames > 0) {
    client.user.setPresence({ activities: [{ name: `🎮 ${activePlayers} players · Round in progress` }], status: 'online' });
  } else {
    client.user.setPresence({ activities: [{ name: '🚀 /startgame to play' }], status: 'online' });
  }
}

// ── Score tracking ────────────────────────────────────────────────────────────
function ensureScore(guildId, username) {
  if (!scores.has(guildId)) scores.set(guildId, {});
  const g = scores.get(guildId);
  if (!g[username]) g[username] = { townWins: 0, mafiaWins: 0, timesAsMafia: 0, totalRounds: 0, timesVotedFor: 0, timesCorrectlyIdentified: 0 };
  return g[username];
}

function recordRound(guildId, roundRecord) {
  // History
  if (!history.has(guildId)) history.set(guildId, []);
  const h = history.get(guildId);
  h.unshift(roundRecord);
  if (h.length > MAX_HISTORY) h.pop();

  // Scores
  const { mafiaUsername, players, townWon, voteResults } = roundRecord;
  for (const p of players) {
    const s = ensureScore(guildId, p);
    s.totalRounds++;
    if (p === mafiaUsername) {
      s.timesAsMafia++;
      if (!townWon) s.mafiaWins++;
      if (townWon) s.timesCorrectlyIdentified++;
    } else {
      if (townWon) s.townWins++;
    }
    // Track how many votes this player received this round
    const votedFor = voteResults.find(v => v.name === p);
    if (votedFor) s.timesVotedFor += votedFor.votes;
  }
  // Also track round start time for duration
  roundRecord.startedAt = roundRecord.startedAt || roundRecord.timestamp;
  saveData();
}

// ── Game helpers ──────────────────────────────────────────────────────────────
function activePlayers(state) {
  return state.players.filter((p) => !state.optedOut.has(p.id));
}

function buildVoteRows(names) {
  const rows = [];
  for (let i = 0; i < names.length; i += 5) {
    const row = new ActionRowBuilder();
    names.slice(i, i + 5).forEach((name) => {
      row.addComponents(new ButtonBuilder().setCustomId(`vote:${name}`).setLabel(name).setStyle(ButtonStyle.Primary));
    });
    rows.push(row);
  }
  return rows;
}

function voteStatusContent(state, label = '🗳️ **Voting in progress**') {
  const active  = activePlayers(state);
  const voted   = active.filter((p) => state.votedIds.has(p.id));
  const pending = active.filter((p) => !state.votedIds.has(p.id));
  const secsLeft = state.voteStartTime
    ? Math.max(0, Math.round(((state.guildId ? getSettings(state.guildId).voteTimeoutSecs * 1000 : 60000) - (Date.now() - state.voteStartTime)) / 1000))
    : 60;
  return (
    `${label} — check your DMs to cast your vote privately.\n\n` +
    `✅ Voted: **${voted.length}/${active.length}**\n` +
    `⏳ Still waiting on:\n${pending.length > 0 ? pending.map((p) => `• ${p.username}`).join('\n') : '_Everyone has voted!_'}\n\n` +
    `⏱️ **${secsLeft}s** remaining — auto-closes when everyone votes. Use \`/endvote\` to force early.`
  );
}

async function updateVoteMessage(guildId, label) {
  const state = gameState.get(guildId);
  if (!state?.voteMessage) return;
  try { await state.voteMessage.edit({ content: voteStatusContent(state, label) }); } catch {}
}

function startCountdown(guildId, label) {
  const state = gameState.get(guildId);
  if (!state) return;
  if (state.countdownTimer) clearInterval(state.countdownTimer);
  state.countdownTimer = setInterval(async () => {
    if (!gameState.get(guildId)?.voteMessage) return;
    await updateVoteMessage(guildId, label);
  }, 10000); // tick every 10s
  gameState.set(guildId, state);
}

function clearTimers(state) {
  if (state.voteTimer)      clearTimeout(state.voteTimer);
  if (state.reminderTimer)  clearTimeout(state.reminderTimer);
  if (state.countdownTimer) clearInterval(state.countdownTimer);
}

function tallyVotes(votes) {
  const counts = {};
  for (const t of Object.values(votes)) counts[t] = (counts[t] ?? 0) + 1;
  return counts;
}

async function sendVoteDMs(guildId, candidates, label = '🗳️ Who is the MAFIA? Pick one:') {
  const state = gameState.get(guildId);
  if (!state) return;
  const g = await client.guilds.fetch(guildId);
  for (const player of activePlayers(state)) {
    const options = candidates.filter((n) => n !== player.username);
    if (!options.length) continue;
    try {
      const m = await g.members.fetch(player.id);
      await m.user.send({ content: label, components: buildVoteRows(options) });
    } catch { console.warn(`Couldn't DM ${player.username}`); }
  }
}

async function sendReminders(guildId) {
  const state = gameState.get(guildId);
  if (!state) return;
  const g = await client.guilds.fetch(guildId);
  for (const p of activePlayers(state).filter((p) => !state.votedIds.has(p.id))) {
    try {
      const m = await g.members.fetch(p.id);
      await m.user.send(`⏰ **Reminder:** You haven't voted yet! 30 seconds left.`);
    } catch {}
  }
}

// ── Reveal ────────────────────────────────────────────────────────────────────
async function doReveal(guildId) {
  const state = gameState.get(guildId);
  if (!state) return;

  clearTimers(state);

  const channel = await client.channels.fetch(state.channelId);
  const counts  = tallyVotes(state.votes);
  const active  = activePlayers(state);
  const sorted  = active.map((p) => ({ name: p.username, votes: counts[p.username] ?? 0 })).sort((a, b) => b.votes - a.votes);

  const topPick    = sorted[0]?.name ?? '';
  const mafiaNames = state.mafiaUsernames || [state.mafiaUsername];
  const townWon    = mafiaNames.map(n => n.toLowerCase()).includes(topPick.toLowerCase());
  const resultLines = sorted.map((r) => `• ${r.name} — ${r.votes} vote${r.votes !== 1 ? 's' : ''}`).join('\n');

  if (state.voteMessage) {
    try { await state.voteMessage.edit({ content: `🗳️ **Voting closed!** Calculating results...` }); } catch {}
  }

  // Record to history + scores (skip test rounds)
  if (!state.testMode) { recordRound(guildId, {
    roundNumber:   (history.get(guildId)?.length ?? 0) + 1,
    mafiaUsername: state.mafiaUsername,
    mafiaUsernames: state.mafiaUsernames || [state.mafiaUsername],
    doubleAgent:   state.doubleAgent || false,
    players:       active.map((p) => p.username),
    townWon,
    voteResults:   sorted,
    startedBy:     state.startedBy,
    timestamp:     new Date().toISOString(),
    durationSecs:  state.roundStartTime ? Math.round((Date.now() - state.roundStartTime) / 1000) : null,
  }); }

  // Reset state but keep players/optouts for /newround
  gameState.set(guildId, {
    ...state,
    mafiaUsername: null, votes: {}, votedIds: new Set(),
    voteTimer: null, reminderTimer: null, countdownTimer: null,
    voteStartTime: null, tiebreaker: false, tiedNames: null,
    active: false, voteMessage: null,
    testMode: state.testMode || false,
  });

  // Announce streak if applicable
  const guildHistory = history.get(guildId) || [];
  if (guildHistory.length >= 2) {
    const streak = calcStreak(guildHistory);
    if (streak.count >= 2) {
      await channel.send(
        `${streak.type === 'mafia' ? '🔴' : '✅'} **${streak.type === 'mafia' ? 'Mafia' : 'Town'} is on a ${streak.count}-round streak!**`
      );
    }
  }

  const mafiaLabel = state.doubleAgent
    ? `🔴 **Double Agent round!** The mafia were: **${(state.mafiaUsernames || [state.mafiaUsername]).join('** and **')}**`
    : `🔴 **${state.mafiaUsername}** was the mafia all along!`;

  updateBotStatus();
  await channel.send(
    `🔍 **The mafia has been revealed!**\n\n` +
    `${mafiaLabel}\n\n` +
    `📊 **Vote Results:**\n${resultLines}\n\n` +
    `${townWon ? '✅ **The town voted correctly!**' : '❌ **The town voted wrong — mafia wins!**'}\n\n` +
    `_Players: ${active.map((p) => p.username).join(', ')}_\n` +
    `_Use \`/newround\` to play again or \`/history\` to see past rounds!_`
  );
}

// ── Resolve / tiebreaker ──────────────────────────────────────────────────────
async function resolveVote(guildId) {
  const state = gameState.get(guildId);
  if (!state) return;
  clearTimers(state);

  const counts  = tallyVotes(state.votes);
  const active  = activePlayers(state);
  const sorted  = active.map((p) => ({ name: p.username, votes: counts[p.username] ?? 0 })).sort((a, b) => b.votes - a.votes);
  const top     = sorted[0]?.votes ?? 0;
  const tied    = sorted.filter((r) => r.votes === top).map((r) => r.name);

  if (tied.length > 1 && !state.tiebreaker) {
    const channel = await client.channels.fetch(state.channelId);
    if (state.voteMessage) { try { await state.voteMessage.edit({ content: `⚡ **Tie detected!** Starting sudden death...` }); } catch {} }
    await channel.send(`⚡ **SUDDEN DEATH!** Tied between: **${tied.join(', ')}** — check your DMs!`);

    const tiebreakerMsg = await channel.send('⚡ Loading tiebreaker...');
    state.votes = {}; state.votedIds = new Set();
    state.tiebreaker = true; state.tiedNames = tied;
    state.voteMessage = tiebreakerMsg; state.voteStartTime = Date.now();
    state.voteTimer    = setTimeout(() => forceResolve(guildId), getSettings(guildId).voteTimeoutSecs * 1000);
    state.reminderTimer = setTimeout(() => sendReminders(guildId), getSettings(guildId).reminderSecs * 1000);
    gameState.set(guildId, state);
    await updateVoteMessage(guildId, '⚡ **Tiebreaker vote in progress**');
    startCountdown(guildId, '⚡ **Tiebreaker vote in progress**');
    await sendVoteDMs(guildId, tied, `⚡ **TIEBREAKER** — Who is the MAFIA? (${tied.join(' vs ')})`);
  } else if (tied.length > 1 && state.tiebreaker) {
    await forceResolve(guildId);
  } else {
    await doReveal(guildId);
  }
}

async function forceResolve(guildId) {
  const state = gameState.get(guildId);
  if (!state) return;

  const channel   = await client.channels.fetch(state.channelId);
  const active    = activePlayers(state);
  const nonVoters = active.filter((p) => !state.votedIds.has(p.id));

  if (nonVoters.length > 0) {
    await channel.send(
      `⚠️ **Time's up!** The following player${nonVoters.length !== 1 ? 's' : ''} didn't vote:\n` +
      nonVoters.map((p) => `• ${p.username}`).join('\n') +
      `\n\nResolving with votes that were cast...`
    );
  }

  const counts  = tallyVotes(state.votes);
  const sorted  = active.map((p) => ({ name: p.username, votes: counts[p.username] ?? 0 })).sort((a, b) => b.votes - a.votes);
  const top     = sorted[0]?.votes ?? 0;
  const tied    = sorted.filter((r) => r.votes === top);

  if (top === 0) {
    const pick = active[Math.floor(Math.random() * active.length)];
    await channel.send(`🎲 **Nobody voted!** Randomly selecting **${pick.username}**...`);
    state.votes['__random__'] = pick.username;
    gameState.set(guildId, state);
    await doReveal(guildId);
    return;
  }

  if (tied.length > 1) {
    const pick = tied[Math.floor(Math.random() * tied.length)];
    await channel.send(`🎲 Still tied! Randomly selecting **${pick.name}**...`);
    state.votes['__random__'] = pick.name;
    gameState.set(guildId, state);
  }

  await doReveal(guildId);
}

function calcStreak(rounds) {
  if (!rounds.length) return { count: 0, type: null };
  const type = rounds[0].townWon ? 'town' : 'mafia';
  let count = 0;
  for (const r of rounds) {
    if ((r.townWon && type === 'town') || (!r.townWon && type === 'mafia')) count++;
    else break;
  }
  return { count, type };
}

async function checkVoteComplete(guildId) {
  const state = gameState.get(guildId);
  if (!state) return;
  const needed = state.testMode ? 1 : activePlayers(state).length;
  if (state.votedIds.size >= needed) await resolveVote(guildId);
}

// ── Button handler ────────────────────────────────────────────────────────────
client.on('interactionCreate', async (interaction) => {
  if (interaction.isButton() && interaction.customId.startsWith('vote:')) {
    const target  = interaction.customId.slice(5);
    const voterId = interaction.user.id;

    let guildId = null;
    for (const [id, state] of gameState.entries()) {
      if (state.players.some((p) => p.id === voterId)) { guildId = id; break; }
    }
    if (!guildId) return interaction.reply({ content: '❌ No active game.', ephemeral: true });

    const state = gameState.get(guildId);
    if (state.optedOut.has(voterId)) return interaction.reply({ content: '❌ You are opted out.', ephemeral: true });
    if (state.votedIds.has(voterId)) return interaction.reply({ content: '✅ You already voted!', ephemeral: true });

    const valid = state.tiebreaker ? state.tiedNames : state.testMode
      ? state.players.map((p) => p.username)
      : activePlayers(state).map((p) => p.username);
    if (!valid.includes(target)) return interaction.reply({ content: '❌ Invalid vote target.', ephemeral: true });

    state.votes[voterId] = target;
    state.votedIds.add(voterId);
    gameState.set(guildId, state);

    await interaction.reply({ content: `✅ You voted for **${target}**. Waiting for others...`, ephemeral: true });
    await updateVoteMessage(guildId, state.tiebreaker ? '⚡ **Tiebreaker vote in progress**' : '🗳️ **Voting in progress**');
    await checkVoteComplete(guildId);
    return;
  }

  if (!interaction.isChatInputCommand()) return;
  const { commandName, guild, member } = interaction;

  // ── /startgame ───────────────────────────────────────────────────────────────
  if (commandName === 'startgame') {
    const vc = member.voice?.channel;
    if (!vc) return interaction.reply({ content: '🚗 Join a voice channel first!', ephemeral: true });

    const members  = vc.members.filter((m) => !m.user.bot);
    const existing = gameState.get(guild.id);
    const optedOut = existing?.optedOut ?? new Set();
    const eligible = [...members.values()].filter((m) => !optedOut.has(m.id));

    if (eligible.length < getSettings(guild.id).minPlayers) {
      return interaction.reply({
        content: `🏟️ Need at least **${getSettings(guild.id).minPlayers} players** — have ${eligible.length} eligible.`,
        ephemeral: true,
      });
    }

    const playerArray = [...members.values()];
    const settings    = getSettings(guild.id);

    // Determine mafia count — mafiaCount setting, but cap at eligible.length - 1
    const wantedMafia = Math.max(1, Math.min(
      settings.mafiaCount || 1,
      Math.floor(eligible.length / 2) // never more than half the players
    ));

    // Shuffle and pick mafia
    const shuffled     = [...eligible].sort(() => Math.random() - 0.5);
    const mafiaPlayers = shuffled.slice(0, wantedMafia);
    const mafiaUsernames = mafiaPlayers.map((m) => m.user.username);
    const mafia        = mafiaPlayers[0]; // primary for display
    const isMultiMafia = mafiaPlayers.length > 1;

    gameState.set(guild.id, {
      guildId:        guild.id,
      mafiaUsername:  mafia.user.username,
      mafiaUsernames,
      doubleAgent:    isMultiMafia,
      players:        playerArray.map((m) => ({ id: m.id, username: m.user.username })),
      optedOut, startedBy: member.user.username, channelId: interaction.channelId,
      votes: {}, votedIds: new Set(),
      voteTimer: null, reminderTimer: null, countdownTimer: null,
      voteStartTime: null, tiebreaker: false, tiedNames: null,
      active: true, voteMessage: null,
      roundStartTime: Date.now(),
    });

    const failedDMs = [];
    for (const p of eligible) {
      const isMafia = mafiaPlayers.some((m) => m.id === p.id);
      let msg;
      if (isMafia && isMultiMafia) {
        msg = `🔴 **You are MAFIA (${wantedMafia}-player mafia)!**\n\nThere are **${wantedMafia}** mafia this round — but you don't know who the others are. Act natural! 🚀`;
      } else if (isMafia) {
        msg = `🔴 **You are the MAFIA!**\n\nPlay it cool — sabotage your team without getting caught. Good luck! 🚀`;
      } else {
        msg = `✅ **You are CREWMATE!**\n\nFind the ${wantedMafia === 1 ? 'mafia' : `${wantedMafia} mafia`} and vote them out. Good luck! 🚀`;
      }
      try { await p.user.send(msg); } catch { failedDMs.push(p.user.username); }
    }

    const optedOutNames  = playerArray.filter((m) => optedOut.has(m.id)).map((m) => m.user.username);
    const multiMafiaNote = isMultiMafia ? `\n🕵️ **${wantedMafia}-player mafia this round!**` : '';
    updateBotStatus();
    saveData();
    await interaction.reply({
      content:
        `🏁 **Rocket League Mafia started!**\n\n` +
        `📍 **${vc.name}** | 👥 Playing: ${eligible.map((m) => m.user.username).join(', ')}` +
        (optedOutNames.length ? `\n⛔ Opted out: ${optedOutNames.join(', ')}` : '') +
        multiMafiaNote +
        `\n\nEveryone DMed their role. Use \`/vote\` when the round ends!` +
        (failedDMs.length ? `\n\n⚠️ **Couldn't DM the following players** (they may have DMs closed):\n${failedDMs.map(n => `• ${n}`).join('\n')}` : ''),
    });
  }

  // ── /newround ─────────────────────────────────────────────────────────────────
  if (commandName === 'newround') {
    const state = gameState.get(guild.id);
    if (!state) return interaction.reply({ content: '❌ No previous game. Use `/startgame` first!', ephemeral: true });

    const eligible = activePlayers(state);
    if (eligible.length < getSettings(guild.id).minPlayers) {
      return interaction.reply({ content: `🏟️ Need at least **${getSettings(guild.id).minPlayers} players** — have ${eligible.length}.`, ephemeral: true });
    }

    clearTimers(state);

    const nrSettings    = getSettings(guild.id);
    const nrWanted      = Math.max(1, Math.min(nrSettings.mafiaCount || 1, Math.floor(eligible.length / 2)));
    const nrShuffled    = [...eligible].sort(() => Math.random() - 0.5);
    const nrMafia       = nrShuffled.slice(0, nrWanted);
    const nrMafiaNames  = nrMafia.map((p) => p.username);
    const nrIsMulti     = nrMafia.length > 1;

    gameState.set(guild.id, {
      ...state,
      mafiaUsername:  nrMafia[0].username,
      mafiaUsernames: nrMafiaNames,
      doubleAgent:    nrIsMulti,
      votes: {}, votedIds: new Set(),
      voteTimer: null, reminderTimer: null, countdownTimer: null,
      voteStartTime: null, tiebreaker: false, tiedNames: null,
      active: true, voteMessage: null,
      roundStartTime: Date.now(),
    });

    const failedDMs = [];
    const g = await client.guilds.fetch(guild.id);
    for (const p of eligible) {
      const isMafia = nrMafia.some((m) => m.id === p.id);
      let msg;
      if (isMafia && nrIsMulti) {
        msg = `🔴 **You are MAFIA (${nrWanted}-player mafia)!** New round — there are ${nrWanted} mafia but you don't know who else. Stay sneaky! 🚀`;
      } else if (isMafia) {
        msg = `🔴 **You are the MAFIA!** New round — stay sneaky! 🚀`;
      } else {
        msg = `✅ **You are CREWMATE!** New round — find the ${nrWanted === 1 ? 'mafia' : nrWanted + ' mafia'}! 🚀`;
      }
      try {
        const m = await g.members.fetch(p.id);
        await m.user.send(msg);
      } catch { failedDMs.push(p.username); }
    }

    updateBotStatus();
    saveData();
    await interaction.reply({
      content:
        `🔄 **New round started!**\n\n👥 Playing: ${eligible.map((p) => p.username).join(', ')}\n\n` +
        `Everyone DMed their role. Use \`/vote\` when the round ends!` +
        (failedDMs.length ? `\n⚠️ Couldn't DM: ${failedDMs.join(', ')}` : ''),
    });
  }

  // ── /vote ─────────────────────────────────────────────────────────────────────
  if (commandName === 'vote') {
    const state = gameState.get(guild.id);
    if (!state) return interaction.reply({ content: '❌ No active game. Use `/startgame`!', ephemeral: true });
    if (state.votedIds.size > 0 || Object.keys(state.votes).length > 0) {
      return interaction.reply({ content: '🗳️ A vote is already in progress!', ephemeral: true });
    }

    const active = activePlayers(state);
    if (!state.testMode && active.length < getSettings(guild.id).minPlayers) {
      return interaction.reply({ content: `🏟️ Need at least **${getSettings(guild.id).minPlayers} players** — have ${active.length}.`, ephemeral: true });
    }

    state.voteStartTime = Date.now();
    state.voteTimer     = setTimeout(() => forceResolve(guild.id), getSettings(guild.id).voteTimeoutSecs * 1000);
    state.reminderTimer = setTimeout(() => sendReminders(guild.id), getSettings(guild.id).reminderSecs * 1000);
    gameState.set(guild.id, state);

    const voteMsg = await interaction.reply({ content: voteStatusContent(state), fetchReply: true });
    state.voteMessage = voteMsg;
    gameState.set(guild.id, state);

    startCountdown(guild.id, '🗳️ **Voting in progress**');
    if (state.testMode) {
      // In test mode add a fake "Bot" candidate so there's always someone to vote for
      const testCandidates = [...state.players.map((p) => p.username), 'Bot (test)'];
      // Also register Bot as a valid player for vote resolution
      if (!state.players.find((p) => p.username === 'Bot (test)')) {
        state.players.push({ id: '__bot__', username: 'Bot (test)' });
        gameState.set(guild.id, state);
      }
      try {
        await member.user.send({ content: '🧪 **[TEST VOTE]** Who is the MAFIA?', components: buildVoteRows(testCandidates) });
      } catch (e) {
        console.error('Test DM error:', e.message);
        await interaction.followUp({ content: '⚠️ Could not DM you — make sure your DMs are open from server members.', ephemeral: true });
      }
    } else {
      await sendVoteDMs(guild.id, active.map((p) => p.username));
    }
  }

  // ── /endvote ──────────────────────────────────────────────────────────────────
  if (commandName === 'endvote') {
    const state = gameState.get(guild.id);
    if (!state || (state.votedIds.size === 0 && !Object.keys(state.votes).length)) {
      return interaction.reply({ content: '❌ No active vote.', ephemeral: true });
    }
    await interaction.reply({ content: '🔍 Ending vote early...' });
    await forceResolve(guild.id);
  }

  // ── /status ───────────────────────────────────────────────────────────────────
  if (commandName === 'status') {
    const state = gameState.get(guild.id);
    if (!state) return interaction.reply({ content: '❌ No active game.', ephemeral: true });

    const active     = activePlayers(state);
    const optedOut   = state.players.filter((p) => state.optedOut.has(p.id));
    const voteActive = state.votedIds.size > 0 || Object.keys(state.votes).length > 0;
    const label      = state.tiebreaker ? '⚡ **Tiebreaker in progress**' : '🗳️ **Voting in progress**';

    let msg = `📋 **Game Status**\n\n👥 **Playing (${active.length}):** ${active.map((p) => p.username).join(', ')}\n`;
    if (optedOut.length) msg += `⛔ **Opted out:** ${optedOut.map((p) => p.username).join(', ')}\n`;
    msg += voteActive ? `\n` + voteStatusContent(state, label) : `\n_No vote in progress. Use \`/vote\` to start._`;

    await interaction.reply({ content: msg, ephemeral: true });
  }

  // ── /history ──────────────────────────────────────────────────────────────────
  if (commandName === 'history') {
    const rounds = history.get(guild.id);
    if (!rounds?.length) {
      return interaction.reply({ content: '📜 No rounds played yet this session!', ephemeral: true });
    }

    const lines = rounds.slice(0, 10).map((r, i) => {
      const date    = new Date(r.timestamp).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
      const outcome = r.townWon ? '✅ Town won' : '🔴 Mafia won';
      const topVote = r.voteResults[0];
      return (
        `**Round ${rounds.length - i}** — ${date}\n` +
        `🔴 Mafia: **${r.mafiaUsername}** | ${outcome}\n` +
        `🗳️ Most votes: ${topVote?.name ?? '?'} (${topVote?.votes ?? 0})\n` +
        `👥 ${r.players.join(', ')}`
      );
    });

    await interaction.reply({
      content: `📜 **Recent Rounds** (last ${lines.length}):\n\n` + lines.join('\n\n'),
      ephemeral: true,
    });
  }

  // ── /score ────────────────────────────────────────────────────────────────────
  if (commandName === 'score') {
    const g = scores.get(guild.id);
    if (!g || !Object.keys(g).length) {
      return interaction.reply({ content: '📊 No scores yet — play some rounds first!', ephemeral: true });
    }

    const rows = Object.entries(g)
      .sort((a, b) => (b[1].townWins + b[1].mafiaWins) - (a[1].townWins + a[1].mafiaWins))
      .map(([name, s]) => {
        const totalWins = s.townWins + s.mafiaWins;
        const winRate   = s.totalRounds > 0 ? Math.round((totalWins / s.totalRounds) * 100) : 0;
        return `**${name}** — ${totalWins}W/${s.totalRounds - totalWins}L (${winRate}% win rate) | Mafia ${s.timesAsMafia}x`;
      });

    await interaction.reply({
      content: `📊 **Scoreboard**\n\n` + rows.join('\n'),
      ephemeral: false,
    });
  }

  // ── /optout ───────────────────────────────────────────────────────────────────
  if (commandName === 'optout') {
    const target = interaction.options.getUser('player') ?? member.user;
    let state    = gameState.get(guild.id);
    if (!state) {
      state = {
        mafiaUsername: null, players: [], optedOut: new Set(), startedBy: null,
        channelId: interaction.channelId, votes: {}, votedIds: new Set(),
        voteTimer: null, reminderTimer: null, countdownTimer: null,
        voteStartTime: null, tiebreaker: false, tiedNames: null, active: false, voteMessage: null,
      };
      gameState.set(guild.id, state);
    }
    if (state.optedOut.has(target.id)) {
      return interaction.reply({ content: `⛔ **${target.username}** is already opted out.`, ephemeral: true });
    }
    state.optedOut.add(target.id);
    await interaction.reply({ content: `⛔ **${target.username}** opted out. Use \`/optin\` to add back.` });
  }

  // ── /optin ────────────────────────────────────────────────────────────────────
  if (commandName === 'optin') {
    const target = interaction.options.getUser('player') ?? member.user;
    const state  = gameState.get(guild.id);
    if (!state?.optedOut.has(target.id)) {
      return interaction.reply({ content: `✅ **${target.username}** is already in.`, ephemeral: true });
    }
    state.optedOut.delete(target.id);
    await interaction.reply({ content: `✅ **${target.username}** is back in!` });
  }

  // ── /kick ────────────────────────────────────────────────────────────────────
  if (commandName === 'kick') {
    const target = interaction.options.getUser('player');
    const state  = gameState.get(guild.id);
    if (!state?.active) {
      return interaction.reply({ content: '❌ No active game.', ephemeral: true });
    }
    const idx = state.players.findIndex((p) => p.id === target.id);
    if (idx === -1) {
      return interaction.reply({ content: `❌ **${target.username}** isn't in the current game.`, ephemeral: true });
    }
    state.players.splice(idx, 1);
    // Remove their vote if cast
    delete state.votes[target.id];
    state.votedIds.delete(target.id);
    gameState.set(guild.id, state);
    updateBotStatus();
    await interaction.reply({ content: `👢 **${target.username}** has been kicked from the game.` });
    // Check if vote is now complete after kick
    await checkVoteComplete(guild.id);
  }

  // ── /pause ────────────────────────────────────────────────────────────────────
  if (commandName === 'pause') {
    const state = gameState.get(guild.id);
    if (!state?.voteStartTime) {
      return interaction.reply({ content: '❌ No active vote to pause.', ephemeral: true });
    }
    if (state.paused) {
      return interaction.reply({ content: '⏸️ Vote is already paused.', ephemeral: true });
    }
    // Store how much time was left when paused
    const settings = getSettings(guild.id);
    const elapsed = Date.now() - state.voteStartTime;
    state.pausedTimeRemainingMs = Math.max(0, (settings.voteTimeoutSecs * 1000) - elapsed);
    state.paused = true;
    // Clear all timers
    clearTimers(state);
    gameState.set(guild.id, state);
    const secsLeft = Math.round(state.pausedTimeRemainingMs / 1000);
    await interaction.reply({ content: `⏸️ **Vote paused** with **${secsLeft}s** remaining. Use \`/resume\` to continue.` });
  }

  // ── /resume ───────────────────────────────────────────────────────────────────
  if (commandName === 'resume') {
    const state = gameState.get(guild.id);
    if (!state?.paused) {
      return interaction.reply({ content: '❌ No paused vote to resume.', ephemeral: true });
    }
    const remaining = state.pausedTimeRemainingMs ?? (getSettings(guild.id).voteTimeoutSecs * 1000);
    state.paused = false;
    state.voteStartTime = Date.now() - ((getSettings(guild.id).voteTimeoutSecs * 1000) - remaining);
    state.voteTimer     = setTimeout(() => forceResolve(guild.id), remaining);
    state.reminderTimer = remaining > getSettings(guild.id).reminderSecs * 1000
      ? setTimeout(() => sendReminders(guild.id), remaining - (getSettings(guild.id).reminderSecs * 1000))
      : null;
    gameState.set(guild.id, state);
    const secsLeft = Math.round(remaining / 1000);
    const label = state.tiebreaker ? '⚡ **Tiebreaker vote in progress**' : '🗳️ **Voting in progress**';
    startCountdown(guild.id, label);
    await updateVoteMessage(guild.id, label);
    await interaction.reply({ content: `▶️ **Vote resumed** — **${secsLeft}s** remaining.` });
  }

  // ── /standings ───────────────────────────────────────────────────────────────
  if (commandName === 'standings') {
    const g = scores.get(guild.id);
    const guildHistory = history.get(guild.id) || [];
    const totalRounds = guildHistory.length;

    if (!g || !Object.keys(g).length) {
      return interaction.reply({ content: '📊 No scores yet — play some rounds first!', ephemeral: true });
    }

    const entries = Object.entries(g)
      .sort((a, b) => {
        const wa = (a[1].townWins + a[1].mafiaWins) / Math.max(1, a[1].totalRounds);
        const wb = (b[1].townWins + b[1].mafiaWins) / Math.max(1, b[1].totalRounds);
        return wb - wa;
      });

    const medals = ['🥇', '🥈', '🥉'];
    const rows = entries.map(([name, s], i) => {
      const wins = s.townWins + s.mafiaWins;
      const wr   = s.totalRounds ? Math.round(wins / s.totalRounds * 100) : 0;
      const detRate = s.timesAsMafia ? Math.round((s.timesCorrectlyIdentified || 0) / s.timesAsMafia * 100) : null;
      return `${medals[i] ?? `${i + 1}.`} **${name}** — ${wins}W/${s.totalRounds - wins}L (${wr}%) | Mafia ${s.timesAsMafia}x${detRate !== null ? ` | Caught ${detRate}%` : ''}`;
    });

    const streak = calcStreak(guildHistory);
    const streakLine = streak.count >= 2
      ? `
${streak.type === 'mafia' ? '🔴' : '✅'} **${streak.type === 'mafia' ? 'Mafia' : 'Town'} is on a ${streak.count}-round streak!**`
      : '';

    const townWins  = guildHistory.filter(r => r.townWon).length;
    const mafiaWins = totalRounds - townWins;

    await interaction.reply({
      content:
        `📊 **Standings** — ${totalRounds} round${totalRounds !== 1 ? 's' : ''} played\n` +
        `🏘️ Town ${townWins} — Mafia ${mafiaWins}` +
        streakLine +
        `\n\n` +
        rows.join('\n'),
    });
  }

  // ── /dashboard ───────────────────────────────────────────────────────────────
  if (commandName === 'dashboard') {
    const dashUrl = process.env.DASHBOARD_URL || `http://51.222.117.202:${WEB_PORT}`;
    await interaction.reply({
      content: `📊 **Dashboard:** ${dashUrl}`,
      ephemeral: true,
    });
  }

  // ── /endgame ─────────────────────────────────────────────────────────────────
  if (commandName === 'endgame') {
    const state = gameState.get(guild.id);
    if (!state) {
      return interaction.reply({ content: '❌ No active game to end.', ephemeral: true });
    }
    clearTimers(state);
    gameState.delete(guild.id);
    updateBotStatus();
    saveData();
    await interaction.reply({
      content:
        `🛑 **Game ended.**

` +
        `All game state has been cleared. Use \`/startgame\` to start a new session.
` +
        `_Scores and history from completed rounds are preserved._`,
    });
  }

  // ── /testgame ─────────────────────────────────────────────────────────────────
  if (commandName === 'testgame') {
    if (member.id !== '251503326447927306') {
      return interaction.reply({ content: '❌ This command is restricted to the bot owner.', ephemeral: true });
    }
    const isMafia = Math.random() < 0.5;
    const you = { id: member.id, username: member.user.username };

    gameState.set(guild.id, {
      guildId:       guild.id,
      mafiaUsername: isMafia ? you.username : '__bot__',
      players:       [you],
      optedOut:      new Set(),
      startedBy:     you.username,
      channelId:     interaction.channelId,
      votes:         {},
      votedIds:      new Set(),
      voteTimer:     null,
      reminderTimer: null,
      countdownTimer: null,
      voteStartTime: null,
      tiebreaker:    false,
      tiedNames:     null,
      active:        true,
      voteMessage:   null,
      roundStartTime: Date.now(),
      testMode:      true,
    });

    try {
      await member.user.send(
        isMafia
          ? `🔴 **[TEST] You are the MAFIA!**

This is a solo test game. Use \`/vote\` and \`/endvote\` to test the voting flow.`
          : `✅ **[TEST] You are CREWMATE!**

This is a solo test game. Use \`/vote\` and \`/endvote\` to test the voting flow.`
      );
    } catch { /* DMs closed */ }

    await interaction.reply({
      content:
        `🧪 **Test game started!**

` +
        `You have been DMed your role.
` +
        `Use \`/vote\` to test voting, then \`/endvote\` or wait for the timer.

` +
        `_This round won't count toward scores._`,
      ephemeral: true,
    });
  }
});

client.login(TOKEN);

// ── Web dashboard ─────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());

// Serialize state safely (Sets → arrays, strip timers/message objects)
function serializeState(state) {
  if (!state) return null;
  return {
    mafiaUsername: state.active ? '???' : state.mafiaUsername, // hide during active round
    players:       activePlayers(state).map((p) => p.username),
    optedOut:      [...state.optedOut].map((id) => state.players.find((p) => p.id === id)?.username).filter(Boolean),
    votes:         state.active ? Object.keys(state.votes).length : null, // just a count during active
    votedIds:      [...state.votedIds].map((id) => state.players.find((p) => p.id === id)?.username).filter(Boolean),
    pending:       activePlayers(state).filter((p) => !state.votedIds.has(p.id)).map((p) => p.username),
    tiebreaker:    state.tiebreaker,
    tiedNames:     state.tiedNames,
    active:        state.active,
    paused:        state.paused ?? false,
    voteStartTime:  state.voteStartTime,
    voteTimeoutMs:  state.guildId ? getSettings(state.guildId).voteTimeoutSecs * 1000 : 60000,
    roundStartTime: state.roundStartTime ?? null,
    players_all:   state.players.map((p) => p.username),
  };
}

app.get('/api/state', (req, res) => {
  const out = {};
  for (const [guildId, state] of gameState.entries()) out[guildId] = serializeState(state);
  res.json(out);
});

app.get('/api/history', (req, res) => {
  const out = {};
  for (const [guildId, rounds] of history.entries()) out[guildId] = rounds;
  res.json(out);
});

app.get('/api/scores', (req, res) => {
  const out = {};
  for (const [guildId, g] of scores.entries()) out[guildId] = g;
  res.json(out);
});

app.get('/api/settings', (req, res) => {
  const out = {};
  const gids = [...new Set([...gameState.keys(), ...history.keys(), ...scores.keys()])];
  for (const id of gids) out[id] = getSettings(id);
  res.json(out);
});



app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'dashboard.html'));
});

app.get('/favicon.svg', (req, res) => {
  res.sendFile(path.join(__dirname, 'favicon.svg'));
});

// ── Auth routes ───────────────────────────────────────────────────────────────
app.get('/auth/login', (req, res) => {
  const params = new URLSearchParams({
    client_id:     CLIENT_ID,
    redirect_uri:  REDIRECT_URI,
    response_type: 'code',
    scope:         'identify',
  });
  res.redirect('https://discord.com/oauth2/authorize?' + params.toString());
});

app.get('/auth/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.redirect('/?error=no_code');
  try {
    const tokenData = await exchangeCode(code);
    if (!tokenData.access_token) return res.redirect('/?error=no_token');
    const user = await fetchDiscordUser(tokenData.access_token);
    if (!user.id) return res.redirect('/?error=no_user');
    const sessionToken = createSession(user.id, user.username, user.avatar);
    res.redirect('/?session=' + sessionToken);
  } catch (e) {
    console.error('OAuth error:', e);
    res.redirect('/?error=oauth_failed');
  }
});

app.get('/auth/me', (req, res) => {
  const token = req.query.token;
  const s = getSession(token);
  if (!s) return res.json({ loggedIn: false });
  res.json({ loggedIn: true, username: s.username, avatar: s.avatar, discordId: s.discordId, isAdmin: s.discordId === ADMIN_USER_ID });
});

app.get('/auth/logout', (req, res) => {
  const token = req.query.token;
  if (token) sessions.delete(token);
  res.redirect('/');
});

// ── Admin-only settings now check session token OR password ──────────────────
app.post('/api/settings/admin', (req, res) => {
  const { sessionToken, guildId, settings } = req.body;
  if (!isAdmin(sessionToken)) return res.status(401).json({ error: 'Not authorized' });
  if (!guildId || !settings) return res.status(400).json({ error: 'Missing fields' });
  const current = getSettings(guildId);
  const updated = {
    voteTimeoutSecs:   Math.max(10, Math.min(300, parseInt(settings.voteTimeoutSecs)  || current.voteTimeoutSecs)),
    reminderSecs:      Math.max(5,  Math.min(290, parseInt(settings.reminderSecs)     || current.reminderSecs)),
    minPlayers:        Math.max(2,  Math.min(10,  parseInt(settings.minPlayers)       || current.minPlayers)),
    mafiaCount:        Math.max(1,  Math.min(5,   parseInt(settings.mafiaCount)       || current.mafiaCount)),
    doubleAgentChance: Math.max(0,  Math.min(100, parseInt(settings.doubleAgentChance)|| current.doubleAgentChance)),
  };
  guildSettings.set(guildId, updated);
  saveData();
  res.json({ ok: true, settings: updated });
});

// ── Admin: kick player ───────────────────────────────────────────────────────
app.post('/api/admin/kick', (req, res) => {
  const { sessionToken, guildId, username } = req.body;
  if (!isAdmin(sessionToken)) return res.status(401).json({ error: 'Not authorized' });
  const state = gameState.get(guildId);
  if (!state) return res.status(404).json({ error: 'No active game' });
  const idx = state.players.findIndex((p) => p.username === username);
  if (idx === -1) return res.status(404).json({ error: 'Player not found' });
  state.players.splice(idx, 1);
  delete state.votes[state.players[idx]?.id];
  gameState.set(guildId, state);
  updateBotStatus();
  res.json({ ok: true });
});

// ── Admin: reset scores ───────────────────────────────────────────────────────
app.post('/api/admin/reset-scores', (req, res) => {
  const { sessionToken, guildId } = req.body;
  if (!isAdmin(sessionToken)) return res.status(401).json({ error: 'Not authorized' });
  scores.delete(guildId);
  saveData();
  res.json({ ok: true });
});

// ── Export history as CSV ─────────────────────────────────────────────────────
app.get('/api/export/history', (req, res) => {
  const { token } = req.query;
  if (!isAdmin(token)) return res.status(401).json({ error: 'Not authorized' });
  const rows = ['Round,Mafia,Town Won,Players,Top Vote,Votes,Duration,Timestamp'];
  for (const [, rounds] of history.entries()) {
    for (const r of rounds) {
      const topVote = r.voteResults?.[0];
      rows.push([
        r.roundNumber,
        r.mafiaUsername,
        r.townWon ? 'Yes' : 'No',
        '"' + (r.players || []).join(', ') + '"',
        topVote?.name ?? '',
        topVote?.votes ?? 0,
        r.durationSecs ?? '',
        r.timestamp,
      ].join(','));
    }
  }
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="rl-mafia-history.csv"');
  res.send(rows.join('\n'));
});

app.listen(WEB_PORT, () => console.log(`Dashboard running at http://localhost:${WEB_PORT}`));