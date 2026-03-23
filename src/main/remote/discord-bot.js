// ── Discord Bot — Remote CLI access via Discord ───────────
// Lobby-based architecture:
//   - "claude-sessions-lobby" channel for orchestrating sessions
//   - Private channels per session in "OmniClaw" category
//   - @bot mentions for interaction (lobby: create/end, session: chat)
//   - Rich embed output with markdown summaries

const { Client, GatewayIntentBits, Events, REST, Routes, ChannelType,
        SlashCommandBuilder, EmbedBuilder, PermissionsBitField,
        AttachmentBuilder, MessageFlags } = require('discord.js');
const messagingBridge = require('./messaging-bridge');
const db = require('../db/database');

let client = null;
let isConnecting = false;
let statusCallback = null;

// Guild setup state: guildId -> { categoryId, lobbyId }
const guildSetup = new Map();

// Session -> channel mapping for cleanup
const sessionChannels = new Map(); // sessionId -> { guildId, channelId }

// Pending typing indicators: channelId -> { interval, messageRef }
let pendingTyping = new Map();

// Lobby status message tracking: guildId -> messageId
const lobbyStatusMessages = new Map();

const CATEGORY_NAME = 'OmniClaw';
const LOBBY_NAME = 'claude-sessions-lobby';
const EMBED_COLOR = 0xd4845a; // orange accent matching app theme
const SUCCESS_COLOR = 0x57f287;
const ERROR_COLOR = 0xed4245;

// Safe console wrapper — prevents EPIPE crashes when stdout/stderr pipe is broken
function log(...args) { try { console.log(...args); } catch (e) { /* swallow EPIPE */ } }
function warn(...args) { try { console.warn(...args); } catch (e) { /* swallow EPIPE */ } }
function error(...args) { try { console.error(...args); } catch (e) { /* swallow EPIPE */ } }

// ── Slash Command Definitions ────────────────────────────

const commands = [
  new SlashCommandBuilder()
    .setName('sessions')
    .setDescription('List all OmniClaw'),

  new SlashCommandBuilder()
    .setName('status')
    .setDescription('Show bot connection status')
];

// ── Bot Lifecycle ────────────────────────────────────────

async function start(token) {
  if (client) return { success: true, status: 'already_connected' };
  if (isConnecting) return { success: false, status: 'connecting' };

  if (!token) {
    token = db.appState.get('discord_bot_token');
    if (!token) {
      return { success: false, status: 'no_token', error: 'No Discord bot token configured' };
    }
  }

  isConnecting = true;
  log('[DiscordBot] Starting...');

  try {
    client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
      ]
    });

    setupEventHandlers();

    // Set up ready listener BEFORE login to avoid race condition
    // (ClientReady can fire during login() before the await returns)
    let loginErrorHandler;
    const readyPromise = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Bot login timed out after 30s')), 30000);
      client.once(Events.ClientReady, () => { clearTimeout(timeout); resolve(); });
      loginErrorHandler = (err) => { clearTimeout(timeout); reject(err); };
      client.once(Events.Error, loginErrorHandler);
    });

    await client.login(token);
    await readyPromise;

    // Remove the one-shot error handler so it doesn't fire on unrelated errors later
    if (loginErrorHandler) client.removeListener(Events.Error, loginErrorHandler);

    log(`[DiscordBot] Connected as ${client.user.tag} (${client.guilds.cache.size} guilds)`);

    // Register slash commands
    await registerCommands(token);

    // Setup lobby and category in all guilds
    for (const [guildId, guild] of client.guilds.cache) {
      try {
        await setupGuild(guild);
      } catch (err) {
        warn(`[DiscordBot] Guild setup failed for ${guild.name}:`, err.message);
      }
    }

    // Detect existing running sessions and create channels
    await syncExistingSessions();

    // Register output handler with messaging bridge
    registerOutputHandler();
    registerPermissionHandler();

    isConnecting = false;
    broadcastStatus(true);

    return { success: true, status: 'connected', tag: client.user.tag };
  } catch (err) {
    error('[DiscordBot] Start failed:', err.message);
    if (client) {
      try { client.destroy(); } catch (e) { /* ignore */ }
    }
    client = null;
    isConnecting = false;
    broadcastStatus(false);
    return { success: false, status: 'error', error: err.message };
  }
}

async function stop() {
  if (!client) return;

  log('[DiscordBot] Stopping...');
  messagingBridge.unregisterPlatform('discord');

  try { client.destroy(); } catch (e) {
    warn('[DiscordBot] Destroy error:', e.message);
  }

  client = null;
  isConnecting = false;
  guildSetup.clear();
  sessionChannels.clear();
  broadcastStatus(false);
  log('[DiscordBot] Stopped');
}

function isRunning() {
  return client !== null && client.isReady();
}

function getStatus() {
  if (!client || !client.isReady()) {
    return { connected: false, connecting: isConnecting };
  }
  const bindings = db.channelBindings.listByPlatform('discord');
  return {
    connected: true,
    tag: client.user.tag,
    guilds: client.guilds.cache.size,
    bindings: bindings.length,
    uptime: client.uptime
  };
}

function onStatusChange(callback) { statusCallback = callback; }

function broadcastStatus(connected) {
  if (statusCallback) {
    statusCallback({ connected, ...(connected ? getStatus() : {}) });
  }
}

// ── Guild Setup (Category + Lobby) ──────────────────────

/**
 * Build permission overrides that guarantee the bot can see + use a channel,
 * even if the category or channel is set to private later.
 */
function botPermissionOverwrites(guild) {
  if (!client || !client.user) return [];
  return [
    {
      // Deny @everyone — makes the channel private
      id: guild.id,
      deny: [
        PermissionsBitField.Flags.ViewChannel,
      ]
    },
    {
      // Allow the bot full access
      id: client.user.id,
      allow: [
        PermissionsBitField.Flags.ViewChannel,
        PermissionsBitField.Flags.SendMessages,
        PermissionsBitField.Flags.ReadMessageHistory,
        PermissionsBitField.Flags.ManageMessages,
        PermissionsBitField.Flags.EmbedLinks,
        PermissionsBitField.Flags.AttachFiles,
        PermissionsBitField.Flags.AddReactions,
        PermissionsBitField.Flags.ManageChannels
      ]
    },
    {
      // Allow the server owner (you) to see the channels
      id: guild.ownerId,
      allow: [
        PermissionsBitField.Flags.ViewChannel,
        PermissionsBitField.Flags.SendMessages,
        PermissionsBitField.Flags.ReadMessageHistory,
        PermissionsBitField.Flags.AddReactions,
      ]
    }
  ];
}

/**
 * Ensure the bot has explicit permission overrides on an existing channel.
 * Prevents lockout when a category/channel is later made private.
 */
async function ensureBotAccess(channel) {
  if (!client || !client.user) return;
  try {
    const existing = channel.permissionOverwrites.cache.get(client.user.id);
    if (!existing) {
      await channel.permissionOverwrites.create(client.user.id, {
        ViewChannel: true,
        SendMessages: true,
        ReadMessageHistory: true,
        ManageMessages: true,
        EmbedLinks: true,
        AttachFiles: true,
        AddReactions: true,
        ManageChannels: true
      });
      log(`[DiscordBot] Added bot permission overrides to: #${channel.name}`);
    }
  } catch (err) {
    warn(`[DiscordBot] Could not set bot permissions on #${channel.name}:`, err.message);
  }
}

async function setupGuild(guild) {
  log(`[DiscordBot] Setting up guild: ${guild.name}`);

  // Find or create the "OmniClaw" category
  let category = guild.channels.cache.find(
    c => c.type === ChannelType.GuildCategory && c.name === CATEGORY_NAME
  );

  if (!category) {
    category = await guild.channels.create({
      name: CATEGORY_NAME,
      type: ChannelType.GuildCategory,
      permissionOverwrites: botPermissionOverwrites(guild),
      reason: 'OmniClaw bot setup'
    });
    log(`[DiscordBot] Created category: ${CATEGORY_NAME}`);
  } else {
    // Ensure bot has access to existing category
    await ensureBotAccess(category);
  }

  // Find or create the lobby channel
  let lobby = guild.channels.cache.find(
    c => c.type === ChannelType.GuildText &&
         c.name === LOBBY_NAME &&
         c.parentId === category.id
  );

  if (!lobby) {
    lobby = await guild.channels.create({
      name: LOBBY_NAME,
      type: ChannelType.GuildText,
      parent: category.id,
      permissionOverwrites: botPermissionOverwrites(guild),
      topic: 'Orchestrate Claude CLI sessions. @mention the bot to create, list, or end sessions.',
      reason: 'OmniClaw lobby'
    });
    log(`[DiscordBot] Created lobby channel: ${LOBBY_NAME}`);

    // Send welcome message
    await sendLobbyWelcome(lobby);
  } else {
    // Ensure bot has access to existing lobby
    await ensureBotAccess(lobby);

    // Send welcome embed if lobby has no bot messages (e.g. bot was locked out previously)
    try {
      const messages = await lobby.messages.fetch({ limit: 10 });
      const hasBotMessage = messages.some(m => m.author.id === client.user.id);
      if (!hasBotMessage) {
        log(`[DiscordBot] Lobby has no bot messages, sending welcome...`);
        await sendLobbyWelcome(lobby);
      }
    } catch (e) {
      warn(`[DiscordBot] Could not check lobby messages:`, e.message);
    }
  }

  guildSetup.set(guild.id, {
    categoryId: category.id,
    lobbyId: lobby.id
  });

  // Post or update the persistent session status message in the lobby
  try {
    await updateLobbyStatusMessage(guild, { categoryId: category.id, lobbyId: lobby.id });
  } catch (e) {
    warn('[DiscordBot] Could not post lobby status message:', e.message);
  }

  log(`[DiscordBot] Guild setup complete: ${guild.name} (category=${category.id}, lobby=${lobby.id})`);
}

async function sendLobbyWelcome(channel) {
  const embed = new EmbedBuilder()
    .setTitle('OmniClaw')
    .setColor(EMBED_COLOR)
    .setDescription(
      'Welcome to the OmniClaw lobby! Use this channel to manage your remote CLI sessions.\n\n' +
      '**Commands** (mention me first):\n' +
      '`@ClaudeSessions create <name>` — Start a new session\n' +
      '`@ClaudeSessions end <name>` — Stop a session\n' +
      '`@ClaudeSessions list` — Show all sessions\n\n' +
      'Each session gets its own private channel. Send messages there (with `@ClaudeSessions`) to interact with the CLI.'
    )
    .setFooter({ text: 'OmniClaw Bot' })
    .setTimestamp();

  await channel.send({ embeds: [embed] });
}

// ── Session Channel Management ──────────────────────────

async function createSessionChannel(guild, session, setup) {
  const channelName = `session-${sanitizeChannelName(session.name || session.id.slice(0, 8))}`;

  // Check if channel already exists
  const existing = guild.channels.cache.find(
    c => c.type === ChannelType.GuildText &&
         c.parentId === setup.categoryId &&
         c.name === channelName
  );

  if (existing) {
    // Re-bind if needed
    messagingBridge.bindChannel('discord', existing.id, session.id, {
      guild_id: guild.id,
      channel_name: existing.name,
      session_channel: true
    });
    sessionChannels.set(session.id, { guildId: guild.id, channelId: existing.id });
    // Ensure bot has access to existing session channel
    await ensureBotAccess(existing);

    // Send session info embed if channel has no bot messages
    try {
      const messages = await existing.messages.fetch({ limit: 5 });
      const hasBotEmbed = messages.some(m => m.author.id === client.user.id && m.embeds.length > 0);
      if (!hasBotEmbed) {
        const workspace = session.workspace_path ? session.workspace_path.split(/[\\/]/).pop() : 'None';
        const embed = new EmbedBuilder()
          .setTitle(`Session: ${session.name}`)
          .setColor(SUCCESS_COLOR)
          .setDescription(
            `This channel is connected to the Claude CLI session **${session.name}**.\n\n` +
            `Mention me and type your message to send it to the CLI.\n` +
            `Example: \`@ClaudeSessions tell me about this project\``
          )
          .addFields(
            { name: 'Mode', value: session.mode || 'ask', inline: true },
            { name: 'Workspace', value: `\`${workspace}\``, inline: true },
            { name: 'Status', value: session.status || 'active', inline: true }
          )
          .setFooter({ text: `ID: ${session.id}` })
          .setTimestamp();
        await existing.send({ embeds: [embed] });
        log(`[DiscordBot] Sent session embed to existing channel: #${existing.name}`);
      }
    } catch (e) {
      warn(`[DiscordBot] Could not check/send session embed:`, e.message);
    }

    return existing;
  }

  // Create dedicated session channel under the category
  let channel;
  try {
    channel = await guild.channels.create({
      name: channelName,
      type: ChannelType.GuildText,
      parent: setup.categoryId,
      permissionOverwrites: botPermissionOverwrites(guild),
      topic: `Session: ${session.name} | Mode: ${session.mode || 'ask'} | ID: ${session.id.slice(0, 12)}`,
      reason: `Claude session channel for: ${session.name}`
    });
    log(`[DiscordBot] Created #${channelName} in OmniClaw category`);
  } catch (createErr) {
    error(`[DiscordBot] Could not create channel #${channelName}: ${createErr.message}`);
    throw createErr;
  }

  // Bind channel to session
  messagingBridge.bindChannel('discord', channel.id, session.id, {
    guild_id: guild.id,
    channel_name: channel.name,
    session_channel: true
  });

  sessionChannels.set(session.id, { guildId: guild.id, channelId: channel.id });

  // Send session info embed
  const workspace = session.workspace_path ? session.workspace_path.split(/[\\/]/).pop() : 'None';
  const embed = new EmbedBuilder()
    .setTitle(`Session: ${session.name}`)
    .setColor(SUCCESS_COLOR)
    .setDescription(
      `This channel is connected to the Claude CLI session **${session.name}**.\n\n` +
      `Mention me and type your message to send it to the CLI.\n` +
      `Example: \`@ClaudeSessions tell me about this project\``
    )
    .addFields(
      { name: 'Mode', value: session.mode || 'ask', inline: true },
      { name: 'Workspace', value: `\`${workspace}\``, inline: true },
      { name: 'Status', value: session.status || 'active', inline: true }
    )
    .setFooter({ text: `ID: ${session.id}` })
    .setTimestamp();

  await channel.send({ embeds: [embed] });

  return channel;
}

async function deleteSessionChannel(sessionId) {
  const mapping = sessionChannels.get(sessionId);
  if (!mapping) return;

  try {
    messagingBridge.unbindChannel('discord', mapping.channelId);
    sessionChannels.delete(sessionId);

    if (client && client.isReady()) {
      const channel = await client.channels.fetch(mapping.channelId).catch(() => null);
      if (channel) {
        // Send goodbye message, wait briefly, then delete the channel
        await channel.send({
          embeds: [new EmbedBuilder()
            .setTitle('Session Ended')
            .setColor(ERROR_COLOR)
            .setDescription('This session has been closed. Channel will be deleted in 5 seconds.')
            .setTimestamp()
          ]
        });
        // Brief delay so the user can see the message
        setTimeout(async () => {
          try {
            await channel.delete('OmniClaw session closed');
            log(`[DiscordBot] Deleted channel #${channel.name} for ended session`);
          } catch (delErr) {
            warn(`[DiscordBot] Could not delete channel:`, delErr.message);
          }
        }, 5000);
      }
    }
  } catch (err) {
    warn(`[DiscordBot] Failed to cleanup session channel:`, err.message);
  }
}

function sanitizeChannelName(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);
}

// ── Auto-Restart PTY from Discord ────────────────────────
// When a user @mentions the bot in a session channel but the PTY
// isn't running, this spawns a new PTY process directly from
// the main process with essential callbacks wired up.

async function spawnSessionPty(sessionId, session) {
  const { PtyManager } = require('../pty/pty-manager');
  const os = require('os');

  const cwd = session.workspace_path || session.workspacePath || os.homedir();
  const skipPerms = session.mode === 'bypassPermissions' || session.skip_perms || session.skipPerms;

  log(`[DiscordBot] Spawning PTY for session: ${session.name} (${sessionId.slice(0, 12)})`);
  log(`[DiscordBot]   cwd=${cwd}, mode=${session.mode}, skipPerms=${skipPerms}`);

  let ptySession;
  try {
    ptySession = PtyManager.create(sessionId, {
      cwd: cwd,
      cols: 120,
      rows: 30,
      mode: session.mode || 'ask',
      skipPerms: skipPerms,
      name: session.name,
      launchClaude: true
    });
  } catch (createErr) {
    error(`[DiscordBot] PtyManager.create failed:`, createErr.message, createErr.stack);
    throw createErr;
  }

  // Wire up data callback — send to renderer + messaging bridge
  ptySession.onDataCallback = (data) => {
    // Forward to Electron renderer (xterm.js terminal)
    try {
      const { getMainWindow } = require('../main');
      const win = getMainWindow();
      if (win && !win.isDestroyed()) {
        win.webContents.send('pty:data', { id: sessionId, data });
      }
    } catch (e) { /* renderer not available */ }

    // Forward to messaging platforms (Discord, Telegram, etc.)
    try {
      messagingBridge.dispatchOutput(sessionId, data);
    } catch (e) { /* non-fatal */ }
  };

  // Wire up exit callback — update DB + notify + cleanup VT buffer
  ptySession.onExitCallback = (exitCode) => {
    log(`[DiscordBot] PTY exited for ${session.name}, code=${exitCode}`);

    try {
      const { getMainWindow } = require('../main');
      const win = getMainWindow();
      if (win && !win.isDestroyed()) {
        win.webContents.send('pty:exit', { id: sessionId, exitCode });
      }
    } catch (e) { /* renderer not available */ }

    // Clean up VT buffer for this session
    try { messagingBridge.cleanupSession(sessionId); } catch (e) { /* non-fatal */ }

    // Mark session as stopped in DB
    try { db.sessions.update(sessionId, { status: 'stopped' }); } catch (e) { /* non-fatal */ }

    // Delete the Discord channel for this session
    deleteSessionChannel(sessionId).catch(() => {});

    // Refresh lobby status to show updated state
    refreshAllLobbyStatus().catch(() => {});
  };

  // Spawn the PTY process — this starts PowerShell and schedules the claude command
  try {
    ptySession.spawn();
  } catch (spawnErr) {
    error(`[DiscordBot] ptySession.spawn() failed:`, spawnErr.message, spawnErr.stack);
    throw spawnErr;
  }

  // Verify the process actually started
  if (!ptySession.process) {
    error(`[DiscordBot] spawn() completed but process is null — spawn failed silently`);
    throw new Error('PTY spawn failed: process is null after spawn()');
  }

  const pid = ptySession.process.pid;
  log(`[DiscordBot] PTY spawned successfully, pid=${pid}`);

  // Mark session as active
  db.sessions.update(sessionId, { status: 'active' });

  // Wait 2 seconds and verify the process didn't die immediately
  // (e.g., PowerShell crash, missing claude binary, etc.)
  await new Promise(r => setTimeout(r, 2000));
  if (!ptySession.process) {
    warn(`[DiscordBot] PTY process died within 2s of spawning (pid was ${pid})`);
    throw new Error('PTY process died immediately after spawning');
  }
  log(`[DiscordBot] PTY process still alive after 2s, pid=${ptySession.process.pid}`);

  return true;
}

/**
 * Try to revive a session: check if PTY is alive, if not, restart it.
 * Returns true if session was restarted, false if it was already alive.
 */
async function ensureSessionAlive(sessionId, session) {
  const { PtyManager } = require('../pty/pty-manager');

  // Check if PTY is already running
  const existingPty = PtyManager.get(sessionId);
  const hasProcess = existingPty && existingPty.process;

  log(`[DiscordBot] ensureSessionAlive: sessionId=${sessionId.slice(0, 12)}, ` +
      `hasPtyObject=${!!existingPty}, hasProcess=${hasProcess}, ` +
      `pid=${hasProcess ? existingPty.process.pid : 'none'}`);

  if (hasProcess) {
    log(`[DiscordBot] Session already alive — no restart needed`);
    return false; // already alive
  }

  // PTY is dead — restart it
  log(`[DiscordBot] Session PTY is dead — attempting restart...`);
  try {
    await spawnSessionPty(sessionId, session);
    log(`[DiscordBot] Restart successful for ${session.name}`);
    return true;
  } catch (restartErr) {
    error(`[DiscordBot] Restart failed for ${session.name}:`, restartErr.message);
    throw restartErr; // propagate so caller knows restart failed
  }
}

// ── Sync Existing Sessions ──────────────────────────────

async function syncExistingSessions() {
  try {
    const sessions = db.sessions.list();
    const activeSessions = sessions.filter(s => s.status === 'active');

    if (activeSessions.length === 0) return;

    log(`[DiscordBot] Syncing ${activeSessions.length} active sessions...`);

    for (const [guildId, setup] of guildSetup) {
      const guild = client.guilds.cache.get(guildId);
      if (!guild) continue;

      for (const session of activeSessions) {
        try {
          await createSessionChannel(guild, session, setup);
        } catch (err) {
          warn(`[DiscordBot] Failed to sync session ${session.name}:`, err.message);
        }
      }
    }
  } catch (err) {
    warn('[DiscordBot] Session sync failed:', err.message);
  }
}

// ── Slash Command Registration ───────────────────────────

async function registerCommands(token) {
  try {
    const rest = new REST({ version: '10' }).setToken(token);
    await rest.put(
      Routes.applicationCommands(client.user.id),
      { body: commands.map(c => c.toJSON()) }
    );
    log(`[DiscordBot] Registered ${commands.length} slash commands`);
  } catch (err) {
    error('[DiscordBot] Slash command registration failed:', err.message);
  }
}

// ── Event Handlers ───────────────────────────────────────

function setupEventHandlers() {
  client.on(Events.MessageCreate, handleMessage);
  client.on(Events.InteractionCreate, handleInteraction);

  client.on(Events.Error, (err) => {
    error('[DiscordBot] Client error:', err.message);
  });

  client.on('disconnect', () => {
    warn('[DiscordBot] Disconnected, will attempt reconnect...');
    broadcastStatus(false);
  });

  client.on('reconnecting', () => {
    log('[DiscordBot] Reconnecting...');
  });

  // Handle new guild joins
  client.on(Events.GuildCreate, async (guild) => {
    try {
      await setupGuild(guild);
    } catch (err) {
      warn(`[DiscordBot] Auto-setup failed for new guild ${guild.name}:`, err.message);
    }
  });
}

async function handleMessage(message) {
  // Ignore bot messages
  if (message.author.bot) return;
  if (!client || !client.user) return;

  // Check if bot is mentioned
  const isMentioned = message.mentions.has(client.user.id);

  // Get guild setup
  const setup = guildSetup.get(message.guild?.id);

  // ── Lobby Messages ──
  if (setup && message.channel.id === setup.lobbyId) {
    if (!isMentioned) return; // Only respond to @mentions in lobby

    // Check if this looks like a lobby command vs a session message
    const testText = message.content
      .replace(new RegExp(`<@!?${client.user.id}>`, 'g'), '')
      .trim()
      .replace(/^\/+/, '')
      .toLowerCase();

    const isCommand = /^(create|new|start|end|stop|kill|close|list|sessions|ls|help|\?)\b/.test(testText);

    if (isCommand) {
      return handleLobbyMessage(message, setup);
    }

    // Not a command — check if lobby has a session bound (fallback mode)
    const lobbyBinding = messagingBridge.getBinding('discord', message.channel.id);
    if (lobbyBinding) {
      // Route to session (fall through to session handler below)
    } else {
      // No binding, unknown input — show help
      return handleLobbyMessage(message, setup);
    }
  }

  // ── Session Channel Messages (or lobby-bound sessions) ──
  const binding = messagingBridge.getBinding('discord', message.channel.id);
  if (binding) {
    if (!isMentioned) return; // Only respond to @mentions in session channels

    // Strip the bot mention from the message
    const cleanText = message.content
      .replace(new RegExp(`<@!?${client.user.id}>`, 'g'), '')
      .trim();

    if (!cleanText) {
      return message.reply({
        embeds: [new EmbedBuilder()
          .setColor(EMBED_COLOR)
          .setDescription('Type a message after mentioning me to send it to the CLI session.')
        ]
      });
    }

    // Show typing indicator
    await message.channel.sendTyping();

    // Route the message to the bound session
    let success = messagingBridge.routeMessage('discord', message.channel.id, cleanText);

    // ── Auto-restart failsafe ──
    // If routing failed, the PTY may be dead. Check if the session exists
    // in the DB and try to restart it automatically.
    if (!success) {
      log(`[DiscordBot] routeMessage failed for channel ${message.channel.id} → session ${binding.session_id.slice(0, 12)}`);

      try {
        const session = db.sessions.list().find(s => s.id === binding.session_id);
        if (!session) {
          warn(`[DiscordBot] Session ${binding.session_id.slice(0, 12)} not found in DB — cannot restart`);
        } else {
          log(`[DiscordBot] Found session in DB: name=${session.name}, mode=${session.mode}, status=${session.status}, workspace=${session.workspace_path}`);
          log(`[DiscordBot] Attempting auto-restart for session: ${session.name}`);

          await message.react('\uD83D\uDD04'); // 🔄 restart indicator

          // Restart the PTY (ensureSessionAlive throws on failure)
          let restarted = false;
          try {
            restarted = await ensureSessionAlive(session.id, session);
          } catch (aliveErr) {
            error(`[DiscordBot] ensureSessionAlive threw:`, aliveErr.message);
            await message.channel.send({
              embeds: [new EmbedBuilder()
                .setColor(ERROR_COLOR)
                .setDescription(
                  `\u26A0\uFE0F Failed to restart session **${session.name}**.\n` +
                  `Error: \`${aliveErr.message}\`\n` +
                  `Try starting the session from the Electron app first.`
                )
              ]
            });
          }

          if (restarted) {
            await message.channel.send({
              embeds: [new EmbedBuilder()
                .setColor(EMBED_COLOR)
                .setDescription(`\uD83D\uDD04 Session **${session.name}** was offline — restarting CLI...`)
              ]
            });

            // Wait for CLI to fully initialize:
            //   spawnSessionPty already waited 2s to verify the process is alive.
            //   PowerShell command is sent at 800ms.
            //   Claude CLI needs ~5-8s to connect to API and show prompt.
            //   Total from spawn: ~8-10s. We already waited 2s, so wait 8s more.
            log(`[DiscordBot] Waiting 8s for CLI to initialize...`);
            await new Promise(r => setTimeout(r, 8000));

            // Verify PTY is still alive before routing
            const { PtyManager } = require('../pty/pty-manager');
            const ptyCheck = PtyManager.get(session.id);
            if (!ptyCheck || !ptyCheck.process) {
              warn(`[DiscordBot] PTY died during initialization — cannot route message`);
              await message.channel.send({
                embeds: [new EmbedBuilder()
                  .setColor(ERROR_COLOR)
                  .setDescription(
                    `\u26A0\uFE0F Session **${session.name}** restarted but the CLI exited during initialization.\n` +
                    `The session may have a configuration issue. Try starting it from the Electron app.`
                  )
                ]
              });
            } else {
              log(`[DiscordBot] PTY still alive, pid=${ptyCheck.process.pid}. Routing message...`);

              // Re-send the message now that PTY should be alive
              success = messagingBridge.routeMessage('discord', message.channel.id, cleanText);

              // If still failing, CLI might need more time — retry once after 5s
              if (!success) {
                log(`[DiscordBot] First retry failed — waiting 5s more...`);
                await new Promise(r => setTimeout(r, 5000));

                // Re-check process alive
                const ptyCheck2 = PtyManager.get(session.id);
                if (ptyCheck2 && ptyCheck2.process) {
                  success = messagingBridge.routeMessage('discord', message.channel.id, cleanText);
                  log(`[DiscordBot] Second retry: success=${success}`);
                } else {
                  warn(`[DiscordBot] PTY died between retries`);
                }
              } else {
                log(`[DiscordBot] Message routed successfully after restart`);
              }
            }

            // Refresh lobby status
            refreshAllLobbyStatus().catch(() => {});
          }
        }
      } catch (restartErr) {
        error(`[DiscordBot] Auto-restart unhandled error:`, restartErr.message, restartErr.stack);
      }
    }

    try {
      if (success) {
        // Remove restart indicator if it was added, then add processing indicator
        try { await message.reactions.cache.get('\uD83D\uDD04')?.users.remove(client.user.id); } catch (e) { /* ok */ }
        await message.react('\u231B'); // ⏳ processing indicator
        // Keep typing indicator active while waiting for response
        const typingInterval = setInterval(() => {
          if (message.channel) message.channel.sendTyping().catch(() => {});
        }, 8000);
        // Auto-clear typing after 2 minutes max
        setTimeout(() => clearInterval(typingInterval), 120000);
        // Store interval so we can clear it when output arrives
        if (!pendingTyping) pendingTyping = new Map();
        pendingTyping.set(message.channel.id, { interval: typingInterval, messageRef: message });
      } else {
        await message.react('\u274C'); // ❌
        await message.reply({
          embeds: [new EmbedBuilder()
            .setColor(ERROR_COLOR)
            .setDescription('Failed to send message. Could not reach the CLI session even after restart attempt.')
          ]
        });
      }
    } catch (e) {
      // React might fail if bot lacks permission
    }
    return;
  }

  // ── Unbound Channel: Auto-detect session from channel name ──
  // If user @mentions bot in a channel named "session-xxx" under our
  // category but it has no binding, try to find and reconnect the session.
  if (isMentioned && setup && message.channel.parentId === setup.categoryId) {
    const channelName = message.channel.name;
    const sessionNameMatch = channelName.replace(/^session-/, '');
    if (sessionNameMatch && sessionNameMatch !== channelName) {
      const sessions = db.sessions.list();
      const matchedSession = sessions.find(s =>
        sanitizeChannelName(s.name || s.id.slice(0, 8)) === sessionNameMatch
      );

      if (matchedSession) {
        try {
          log(`[DiscordBot] Auto-reconnecting unbound channel #${channelName} to session ${matchedSession.name}`);

          // Rebind the channel
          messagingBridge.bindChannel('discord', message.channel.id, matchedSession.id, {
            guild_id: message.guild.id,
            channel_name: channelName,
            session_channel: true
          });
          sessionChannels.set(matchedSession.id, { guildId: message.guild.id, channelId: message.channel.id });

          // Ensure the PTY is alive
          let restarted = false;
          try {
            restarted = await ensureSessionAlive(matchedSession.id, matchedSession);
          } catch (aliveErr) {
            error(`[DiscordBot] ensureSessionAlive threw for unbound reconnect:`, aliveErr.message);
            await message.channel.send({
              embeds: [new EmbedBuilder()
                .setColor(ERROR_COLOR)
                .setDescription(
                  `\u26A0\uFE0F Failed to restart session **${matchedSession.name}** for reconnect.\n` +
                  `Error: \`${aliveErr.message}\``
                )
              ]
            });
            return;
          }

          const cleanText = message.content
            .replace(new RegExp(`<@!?${client.user.id}>`, 'g'), '')
            .trim();

          if (restarted) {
            await message.channel.send({
              embeds: [new EmbedBuilder()
                .setColor(SUCCESS_COLOR)
                .setDescription(
                  `\uD83D\uDD04 Reconnected to session **${matchedSession.name}** and restarted CLI.\n` +
                  `${cleanText ? 'Your message will be sent once the CLI is ready.' : 'You can now send messages.'}`
                )
              ]
            });

            if (cleanText) {
              // spawnSessionPty already waited 2s for initial health check.
              // Wait 8s more for claude CLI to fully initialize.
              log(`[DiscordBot] Waiting 8s for CLI to initialize (unbound reconnect)...`);
              await new Promise(r => setTimeout(r, 8000));

              // Verify PTY still alive
              const { PtyManager } = require('../pty/pty-manager');
              const ptyCheck = PtyManager.get(matchedSession.id);
              if (!ptyCheck || !ptyCheck.process) {
                warn(`[DiscordBot] PTY died during init for unbound reconnect`);
                await message.react('\u274C');
                return;
              }

              let routed = messagingBridge.routeMessage('discord', message.channel.id, cleanText);
              if (!routed) {
                log(`[DiscordBot] First route failed after reconnect, retrying in 5s...`);
                await new Promise(r => setTimeout(r, 5000));
                routed = messagingBridge.routeMessage('discord', message.channel.id, cleanText);
              }
              if (routed) await message.react('\u231B');
              else await message.react('\u274C');
            }
          } else {
            // Session was already alive, just needed rebinding
            if (cleanText) {
              messagingBridge.routeMessage('discord', message.channel.id, cleanText);
              await message.react('\u231B');
            }
          }

          refreshAllLobbyStatus().catch(() => {});
          return;
        } catch (e) {
          warn(`[DiscordBot] Auto-reconnect failed for #${channelName}:`, e.message);
        }
      }
    }
  }
}

// ── Lobby Command Parser ─────────────────────────────────

async function handleLobbyMessage(message, setup) {
  // Strip bot mention, leading slash, and whitespace
  const rawText = message.content
    .replace(new RegExp(`<@!?${client.user.id}>`, 'g'), '')
    .trim()
    .replace(/^\/+/, '');  // strip leading slash(es) from /create, /list, etc.
  const cleanText = rawText.toLowerCase();

  // Parse command
  if (cleanText.startsWith('create ') || cleanText.startsWith('new ') || cleanText.startsWith('start ')) {
    const sessionName = rawText
      .replace(/^(create|new|start)\s+/i, '')
      .trim();
    return handleCreateSession(message, setup, sessionName);

  } else if (cleanText.startsWith('end ') || cleanText.startsWith('stop ') || cleanText.startsWith('kill ') || cleanText.startsWith('close ')) {
    const sessionName = rawText
      .replace(/^(end|stop|kill|close)\s+/i, '')
      .trim();
    return handleEndSession(message, sessionName);

  } else if (cleanText === 'list' || cleanText === 'sessions' || cleanText === 'ls') {
    return handleListSessions(message);

  } else if (cleanText === 'help' || cleanText === '?') {
    return sendLobbyHelp(message);

  } else {
    return sendLobbyHelp(message);
  }
}

async function handleCreateSession(message, setup, rawName) {
  if (!rawName) {
    return message.reply({
      embeds: [new EmbedBuilder()
        .setColor(ERROR_COLOR)
        .setDescription(
          'Please provide a session name.\n' +
          'Examples:\n' +
          '`@ClaudeSessions create my-project`\n' +
          '`@ClaudeSessions create my-project at D:\\Projects\\my-project`'
        )
      ]
    });
  }

  // Parse optional workspace path: "name at D:\path\to\dir" or "name D:\path\to\dir"
  let sessionName = rawName;
  let workspacePath = null;

  // Pattern 1: "name at <path>" (case-insensitive "at" or "in")
  const atMatch = rawName.match(/^(.+?)\s+(?:at|in)\s+([A-Za-z]:\\[^\s].*|\/[^\s].*)$/i);
  if (atMatch) {
    sessionName = atMatch[1].trim();
    workspacePath = atMatch[2].trim();
  } else {
    // Pattern 2: "name <path>" — last token is a Windows/Unix path
    const pathMatch = rawName.match(/^(.+?)\s+([A-Za-z]:\\[^\s]+|\/[a-z][^\s]*)$/i);
    if (pathMatch) {
      sessionName = pathMatch[1].trim();
      workspacePath = pathMatch[2].trim();
    }
  }

  // Validate workspace path exists (if provided)
  if (workspacePath) {
    const fs = require('fs');
    if (!fs.existsSync(workspacePath)) {
      return message.reply({
        embeds: [new EmbedBuilder()
          .setColor(ERROR_COLOR)
          .setDescription(`Path not found: \`${workspacePath}\`\nPlease provide a valid directory path.`)
        ]
      });
    }
  }

  // Check if session with this name already exists and is active
  const sessions = db.sessions.list();
  const existing = sessions.find(s =>
    s.name.toLowerCase() === sessionName.toLowerCase() && s.status === 'active'
  );

  if (existing) {
    // Session exists — just create/find the channel for it
    const guild = message.guild;
    const channel = await createSessionChannel(guild, existing, setup);

    return message.reply({
      embeds: [new EmbedBuilder()
        .setColor(EMBED_COLOR)
        .setTitle('Session Already Running')
        .setDescription(`**${existing.name}** is already active.\nGo to <#${channel.id}> to interact with it.`)
      ]
    });
  }

  // Create a new session in the database
  const sessionId = generateId();
  const session = {
    id: sessionId,
    name: sessionName,
    workspacePath: workspacePath,
    workspace_path: workspacePath, // DB column name
    mode: 'ask',
    skipPerms: false,
    groupId: null,
    model: null,
    status: 'active'
  };

  try {
    db.sessions.create(session);

    // Create the Discord channel
    const guild = message.guild;
    const channel = await createSessionChannel(guild, session, setup);

    // Notify the Electron app to spawn a PTY for this session
    try {
      const { getMainWindow } = require('../main');
      const win = getMainWindow();
      if (win && !win.isDestroyed()) {
        win.webContents.send('discord:sessionRequested', {
          id: sessionId,
          name: sessionName,
          workspacePath: workspacePath,
          channelId: channel.id
        });
      }
    } catch (e) {
      warn('[DiscordBot] Could not notify renderer of new session:', e.message);
    }

    const fields = [
      { name: 'Session ID', value: `\`${sessionId.slice(0, 12)}\``, inline: true },
      { name: 'Mode', value: 'ask', inline: true }
    ];
    if (workspacePath) {
      fields.push({ name: 'Workspace', value: `\`${workspacePath}\``, inline: false });
    }

    await message.reply({
      embeds: [new EmbedBuilder()
        .setColor(SUCCESS_COLOR)
        .setTitle('Session Created')
        .setDescription(
          `**${sessionName}** has been created!\n\n` +
          `Go to <#${channel.id}> and mention me to start chatting with the CLI.`
        )
        .addFields(...fields)
        .setTimestamp()
      ]
    });

    // Update lobby status
    refreshAllLobbyStatus().catch(() => {});
    return;
  } catch (err) {
    error('[DiscordBot] Create session failed:', err.message);
    return message.reply({
      embeds: [new EmbedBuilder()
        .setColor(ERROR_COLOR)
        .setDescription(`Failed to create session: ${err.message}`)
      ]
    });
  }
}

async function handleEndSession(message, rawName) {
  if (!rawName) {
    return message.reply({
      embeds: [new EmbedBuilder()
        .setColor(ERROR_COLOR)
        .setDescription('Please provide a session name.\nExample: `@ClaudeSessions end my-project`')
      ]
    });
  }

  const sessions = db.sessions.list();
  const target = sessions.find(s =>
    s.name.toLowerCase() === rawName.toLowerCase() ||
    s.id === rawName ||
    s.id.startsWith(rawName)
  );

  if (!target) {
    return message.reply({
      embeds: [new EmbedBuilder()
        .setColor(ERROR_COLOR)
        .setDescription(`Session "${rawName}" not found. Use \`@ClaudeSessions list\` to see available sessions.`)
      ]
    });
  }

  try {
    // Kill the PTY
    const { PtyManager } = require('../pty/pty-manager');
    PtyManager.kill(target.id);

    // Update session status
    db.sessions.update(target.id, { status: 'stopped' });

    // Cleanup Discord channel
    await deleteSessionChannel(target.id);

    // Notify Electron app
    try {
      const { getMainWindow } = require('../main');
      const win = getMainWindow();
      if (win && !win.isDestroyed()) {
        win.webContents.send('discord:sessionEnded', { id: target.id });
      }
    } catch (e) { /* non-fatal */ }

    await message.reply({
      embeds: [new EmbedBuilder()
        .setColor(ERROR_COLOR)
        .setTitle('Session Ended')
        .setDescription(`**${target.name}** has been stopped.`)
        .setTimestamp()
      ]
    });

    // Update lobby status
    refreshAllLobbyStatus().catch(() => {});
    return;
  } catch (err) {
    return message.reply({
      embeds: [new EmbedBuilder()
        .setColor(ERROR_COLOR)
        .setDescription(`Failed to end session: ${err.message}`)
      ]
    });
  }
}

async function handleListSessions(message) {
  // Update the persistent lobby status message instead of replying
  const setup = guildSetup.get(message.guild?.id);
  if (setup) {
    await updateLobbyStatusMessage(message.guild, setup);
  }
  // Also reply with confirmation
  await message.react('\u2705');
}

/**
 * Build the session status embed used in both lobby and slash commands.
 */
function buildSessionsEmbed() {
  const sessions = db.sessions.list();

  if (!sessions.length) {
    return new EmbedBuilder()
      .setTitle('\uD83D\uDCCB OmniClaw')
      .setColor(EMBED_COLOR)
      .setDescription('No sessions found.\nUse `@ClaudeSessions create <name>` to start one.')
      .setFooter({ text: `Last updated` })
      .setTimestamp();
  }

  const active = sessions.filter(s => s.status === 'active');
  const stopped = sessions.filter(s => s.status !== 'active');

  const lines = [];

  if (active.length > 0) {
    lines.push('**Active Sessions:**');
    for (const s of active.slice(0, 15)) {
      const workspace = s.workspace_path ? s.workspace_path.split(/[\\/]/).pop() : '';
      const channelInfo = sessionChannels.has(s.id)
        ? ` → <#${sessionChannels.get(s.id).channelId}>`
        : '';
      lines.push(`\uD83D\uDFE2 **${s.name}** (${s.mode || 'ask'})${workspace ? ` · \`${workspace}\`` : ''}${channelInfo}`);
    }
  }

  if (stopped.length > 0) {
    if (lines.length > 0) lines.push('');
    lines.push('**Stopped Sessions:**');
    for (const s of stopped.slice(0, 10)) {
      const workspace = s.workspace_path ? s.workspace_path.split(/[\\/]/).pop() : '';
      lines.push(`\u26AA **${s.name}** (${s.mode || 'ask'})${workspace ? ` · \`${workspace}\`` : ''}`);
    }
  }

  return new EmbedBuilder()
    .setTitle('\uD83D\uDCCB OmniClaw')
    .setColor(EMBED_COLOR)
    .setDescription(lines.join('\n'))
    .setFooter({ text: `${active.length} active · ${stopped.length} stopped · Last updated` })
    .setTimestamp();
}

/**
 * Update (or create) the persistent session status message in the lobby.
 * This message is edited in-place whenever sessions change.
 */
async function updateLobbyStatusMessage(guild, setup) {
  if (!guild || !setup || !client || !client.isReady()) return;

  const lobby = await client.channels.fetch(setup.lobbyId).catch(() => null);
  if (!lobby) return;

  const embed = buildSessionsEmbed();

  // Try to edit existing status message
  const existingId = lobbyStatusMessages.get(guild.id);
  if (existingId) {
    try {
      const msg = await lobby.messages.fetch(existingId);
      await msg.edit({ embeds: [embed] });
      return; // successfully updated
    } catch (e) {
      // Message deleted or not found — send a new one
      lobbyStatusMessages.delete(guild.id);
    }
  }

  // Send new status message and store its ID
  try {
    const msg = await lobby.send({ embeds: [embed] });
    lobbyStatusMessages.set(guild.id, msg.id);
  } catch (e) {
    warn('[DiscordBot] Could not send lobby status message:', e.message);
  }
}

/**
 * Trigger a lobby status update in all guilds.
 * Called whenever sessions change (create, end, status change).
 */
async function refreshAllLobbyStatus() {
  if (!client || !client.isReady()) return;
  for (const [guildId, setup] of guildSetup) {
    const guild = client.guilds.cache.get(guildId);
    if (guild) {
      try { await updateLobbyStatusMessage(guild, setup); } catch (e) { /* non-fatal */ }
    }
  }
}

async function sendLobbyHelp(message) {
  const embed = new EmbedBuilder()
    .setTitle('OmniClaw — Help')
    .setColor(EMBED_COLOR)
    .setDescription(
      '**Available Commands** (mention me first):\n\n' +
      '`create <name>` — Create a new CLI session\n' +
      '`create <name> at <path>` — Create with workspace directory\n' +
      '`end <name>` — Stop a session\n' +
      '`list` — Show all sessions\n' +
      '`help` — Show this help message\n\n' +
      '**Examples:**\n' +
      '`@ClaudeSessions create my-project at D:\\Projects\\my-project`\n' +
      '`@ClaudeSessions create quick-fix`\n\n' +
      '**Session Channels:**\n' +
      'Each session gets its own channel under the **OmniClaw** category. ' +
      'Mention me in a session channel to send messages to the CLI.\n' +
      'Sessions created in the desktop app also auto-create channels here.\n\n' +
      '**Output:**\n' +
      'CLI responses appear automatically as formatted messages with a summary and code details.'
    )
    .setTimestamp();

  return message.reply({ embeds: [embed] });
}

// ── Interaction Handler (Slash Commands) ─────────────────

async function handleInteraction(interaction) {
  if (!interaction.isChatInputCommand()) return;

  try {
    switch (interaction.commandName) {
      case 'sessions': return await cmdSessions(interaction);
      case 'status': return await cmdStatus(interaction);
    }
  } catch (err) {
    error(`[DiscordBot] Command '${interaction.commandName}' failed:`, err.message);
    const reply = { content: `Error: ${err.message}`, flags: MessageFlags.Ephemeral };
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp(reply);
    } else {
      await interaction.reply(reply);
    }
  }
}

async function cmdSessions(interaction) {
  const embed = buildSessionsEmbed();
  await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });

  // Also update the lobby status message
  const setup = guildSetup.get(interaction.guild?.id);
  if (setup && interaction.guild) {
    updateLobbyStatusMessage(interaction.guild, setup).catch(() => {});
  }
}

async function cmdStatus(interaction) {
  const status = getStatus();
  const bindings = db.channelBindings.listByPlatform('discord');

  const embed = new EmbedBuilder()
    .setTitle('Discord Bot Status')
    .setColor(status.connected ? SUCCESS_COLOR : ERROR_COLOR)
    .addFields(
      { name: 'Status', value: status.connected ? '\uD83D\uDFE2 Connected' : '\uD83D\uDD34 Disconnected', inline: true },
      { name: 'Bot', value: status.tag || 'N/A', inline: true },
      { name: 'Guilds', value: String(status.guilds || 0), inline: true },
      { name: 'Session Channels', value: String(bindings.length), inline: true }
    );

  return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}

// ── Output Handler — Rich Formatted Output ──────────────

function registerOutputHandler() {
  messagingBridge.registerPlatform('discord', async (channelId, text) => {
    if (!client || !client.isReady()) return;

    try {
      const channel = await client.channels.fetch(channelId);
      if (!channel) return;

      // Clear typing indicator and swap reaction ⏳ → ✅
      const pending = pendingTyping.get(channelId);
      if (pending) {
        clearInterval(pending.interval);
        pendingTyping.delete(channelId);
        try {
          await pending.messageRef.reactions.cache.get('\u231B')?.users.remove(client.user.id);
          await pending.messageRef.react('\u2705'); // ✅ done
        } catch (e) { /* reaction cleanup non-fatal */ }
      }

      // Format with rich embed + optional file attachment for long output
      const formatted = formatRichOutput(text);
      await channel.send(formatted);

    } catch (err) {
      error('[DiscordBot] Failed to send output to channel:', err.message);
    }
  });
}

// ── Permission Handler — Reaction-based approval ──────────

function registerPermissionHandler() {
  messagingBridge.registerPermissionCallback('discord', async (channelId, promptText, sessionId) => {
    if (!client || !client.isReady()) return;

    try {
      const channel = await client.channels.fetch(channelId);
      if (!channel) return;

      const { EmbedBuilder } = require('discord.js');
      const embed = new EmbedBuilder()
        .setColor(0xCC9966)
        .setTitle('🔐 Permission Required')
        .setDescription(promptText.slice(0, 200))
        .addFields(
          { name: 'React to respond', value: '✅ = **Approve** (Yes)\n❌ = **Deny** (No)', inline: false }
        )
        .setFooter({ text: 'Waiting for your response...' })
        .setTimestamp();

      const msg = await channel.send({ embeds: [embed] });
      await msg.react('✅');
      await msg.react('❌');

      // Wait for reaction (60 second timeout)
      const filter = (reaction, user) => {
        return ['✅', '❌'].includes(reaction.emoji.name) && user.id !== client.user.id;
      };

      try {
        const collected = await msg.awaitReactions({ filter, max: 1, time: 60000, errors: ['time'] });
        const reaction = collected.first();
        const approved = reaction.emoji.name === '✅';

        messagingBridge.respondToPermission('discord', channelId, approved);

        // Update the embed to show the decision
        const updatedEmbed = EmbedBuilder.from(embed)
          .setColor(approved ? 0x7AB87A : 0xB87A7A)
          .setTitle(approved ? '✅ Approved' : '❌ Denied')
          .setFooter({ text: `Responded by ${reaction.users.cache.filter(u => u.id !== client.user.id).first()?.tag || 'user'}` });

        await msg.edit({ embeds: [updatedEmbed] });
        await msg.reactions.removeAll().catch(() => {});

      } catch (timeoutErr) {
        // Timeout — auto-deny
        messagingBridge.respondToPermission('discord', channelId, false);

        const timeoutEmbed = EmbedBuilder.from(embed)
          .setColor(0xB87A7A)
          .setTitle('⏰ Timed Out — Auto-Denied')
          .setFooter({ text: 'No response received within 60 seconds' });

        await msg.edit({ embeds: [timeoutEmbed] });
        await msg.reactions.removeAll().catch(() => {});
      }

    } catch (err) {
      error('[DiscordBot] Permission handler failed:', err.message);
    }
  });
}

/**
 * Format CLI output as Discord message(s).
 * Splits long output into multiple sequential embeds (max 10 per message).
 * Each chunk fits within Discord's 4096-char embed description limit.
 */
function formatRichOutput(rawText) {
  const text = rawText.trim();
  if (!text) return { content: '_No output._' };

  const summary = generateSummary(text);
  const outputLength = text.length;

  // Short output (<=1800 chars): single clean embed
  if (outputLength <= 1800) {
    return {
      embeds: [new EmbedBuilder()
        .setColor(EMBED_COLOR)
        .setDescription(`**Summary:** ${summary}\n\n\`\`\`ansi\n${colorizeAnsi(text)}\n\`\`\``)
        .setFooter({ text: `${outputLength} chars` })
      ]
    };
  }

  // Longer output: split into chunks and send as multiple embeds
  // Discord allows up to 10 embeds per message, 4096 chars per embed description
  // Reserve ~100 chars for code block markers + formatting
  const CHUNK_SIZE = 1800;
  const chunks = splitIntoChunks(text, CHUNK_SIZE);

  // Cap at 10 embeds (Discord limit)
  const maxChunks = Math.min(chunks.length, 10);
  const embeds = [];

  for (let i = 0; i < maxChunks; i++) {
    const chunk = chunks[i];
    const isFirst = i === 0;
    const isLast = i === maxChunks - 1;

    const embed = new EmbedBuilder().setColor(EMBED_COLOR);

    if (isFirst) {
      embed.setDescription(`**Summary:** ${summary}\n\n\`\`\`ansi\n${colorizeAnsi(chunk)}\n\`\`\``);
    } else {
      embed.setDescription(`\`\`\`ansi\n${colorizeAnsi(chunk)}\n\`\`\``);
    }

    if (isLast) {
      const truncNote = maxChunks < chunks.length ? ` (showing ${maxChunks}/${chunks.length} segments)` : '';
      embed.setFooter({ text: `${outputLength} chars total${truncNote}` });
    }

    embeds.push(embed);
  }

  // If there are MORE than 10 chunks, attach the full output as a file too
  const result = { embeds };
  if (chunks.length > 10) {
    result.files = [new AttachmentBuilder(
      Buffer.from(text, 'utf-8'),
      { name: `full-output-${Date.now()}.md` }
    )];
  }

  return result;
}

/**
 * Split text into chunks at natural line boundaries.
 * Tries to break at paragraph boundaries (\n\n), then line boundaries (\n).
 */
function splitIntoChunks(text, maxLen) {
  const chunks = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }

    // Try to split at a double-newline (paragraph break) within the chunk
    let splitIdx = remaining.lastIndexOf('\n\n', maxLen);
    if (splitIdx > maxLen * 0.3) {
      chunks.push(remaining.slice(0, splitIdx).trimEnd());
      remaining = remaining.slice(splitIdx + 2).trimStart();
      continue;
    }

    // Fall back to single newline
    splitIdx = remaining.lastIndexOf('\n', maxLen);
    if (splitIdx > maxLen * 0.3) {
      chunks.push(remaining.slice(0, splitIdx).trimEnd());
      remaining = remaining.slice(splitIdx + 1).trimStart();
      continue;
    }

    // Hard split at maxLen if no good break point
    chunks.push(remaining.slice(0, maxLen));
    remaining = remaining.slice(maxLen);
  }

  return chunks;
}

/**
 * Apply Discord ANSI color codes to CLI output for syntax highlighting.
 * Discord supports \u001b[Xm escape codes inside ```ansi code blocks.
 * Colors: 30=gray, 31=red, 32=green, 33=yellow, 34=blue, 36=cyan, 37=white
 */
function colorizeAnsi(text) {
  let result = text;

  // Highlight error lines in red
  result = result.replace(/^(.*(?:error|Error|ERROR|failed|Failed|FAILED|exception|panic|fatal).*)$/gm,
    '\u001b[31m$1\u001b[0m');

  // Highlight success lines in green
  result = result.replace(/^(.*(?:successfully|completed|done|created|saved|passed|✓|✅).*)$/gm,
    '\u001b[32m$1\u001b[0m');

  // Highlight warnings in yellow
  result = result.replace(/^(.*(?:warning|Warning|WARNING|deprecated|caution).*)$/gm,
    '\u001b[33m$1\u001b[0m');

  // Highlight file paths in cyan
  result = result.replace(/([A-Za-z]:\\[^\s]+|\/[a-z][^\s]*\.[a-z]+)/g,
    '\u001b[36m$1\u001b[0m');

  // Highlight prompts in blue
  result = result.replace(/^(>\s*.*)$/gm, '\u001b[34m$1\u001b[0m');

  return result;
}

/**
 * Generate a brief summary of CLI output.
 * Looks for common patterns: errors, file changes, completions, questions, etc.
 */
function generateSummary(text) {
  const lines = text.split('\n').filter(l => l.trim());

  // Check for error patterns
  const errorLines = lines.filter(l => /error|failed|exception|panic|fatal/i.test(l));
  if (errorLines.length > 0) {
    const firstError = errorLines[0].trim().slice(0, 120);
    return `\u26A0\uFE0F Error detected: \`${firstError}\``;
  }

  // Check for common success patterns
  if (lines.some(l => /successfully|completed|done|created|updated|saved/i.test(l))) {
    const successLine = lines.find(l => /successfully|completed|done|created|updated|saved/i.test(l));
    return `\u2705 ${successLine.trim().slice(0, 120)}`;
  }

  // Check for file operation patterns
  const fileOps = lines.filter(l => /wrote|modified|deleted|added|removed|changed/i.test(l));
  if (fileOps.length > 0) {
    return `\uD83D\uDCC1 ${fileOps.length} file operation${fileOps.length > 1 ? 's' : ''} — ${fileOps[0].trim().slice(0, 100)}`;
  }

  // Check for question/prompt patterns (Claude asking for input)
  if (lines.some(l => /\?$|please|choose|select|confirm|do you want/i.test(l))) {
    const question = lines.find(l => /\?$|please|choose|select|confirm|do you want/i.test(l));
    return `\u2753 Waiting for input: ${question.trim().slice(0, 120)}`;
  }

  // Check for tool use patterns (Claude running tools)
  const toolLines = lines.filter(l => /Read|Write|Edit|Bash|Search|Grep|Glob/i.test(l));
  if (toolLines.length > 0) {
    return `\uD83D\uDD27 ${toolLines.length} tool operation${toolLines.length > 1 ? 's' : ''} — ${toolLines[0].trim().slice(0, 100)}`;
  }

  // Default: use last meaningful line
  const lastLine = lines[lines.length - 1]?.trim() || '';
  if (lastLine.length > 5) {
    return lastLine.slice(0, 150);
  }

  return `Response received (${lines.length} lines)`;
}

// ── Auto-Create Channel from Electron App ────────────────
// Called by ipc-handlers.js when a new session is spawned from the UI.
// Creates a Discord channel + binding so the session is immediately accessible remotely.

async function autoCreateChannel(session) {
  if (!client || !client.isReady()) return null;

  // Find first guild setup (primary guild)
  const [guildId, setup] = [...guildSetup.entries()][0] || [];
  if (!guildId || !setup) {
    log('[DiscordBot] autoCreateChannel: no guild setup found');
    return null;
  }

  const guild = client.guilds.cache.get(guildId);
  if (!guild) return null;

  // Check if a channel already exists for this session
  if (sessionChannels.has(session.id)) {
    log(`[DiscordBot] autoCreateChannel: channel already exists for ${session.name}`);
    return sessionChannels.get(session.id);
  }

  // Check if there's already a binding for this session
  const existingBindings = messagingBridge.getBindingsForSession(session.id);
  if (existingBindings && existingBindings.length > 0) {
    log(`[DiscordBot] autoCreateChannel: binding already exists for ${session.name}`);
    return existingBindings[0];
  }

  try {
    const channel = await createSessionChannel(guild, session, setup);
    log(`[DiscordBot] autoCreateChannel: created #session-${sanitizeChannelName(session.name)} for ${session.name}`);

    // Refresh lobby status to show the new session
    refreshAllLobbyStatus().catch(() => {});

    return { guildId, channelId: channel.id };
  } catch (err) {
    warn(`[DiscordBot] autoCreateChannel failed for ${session.name}:`, err.message);
    return null;
  }
}

// ── Utility ──────────────────────────────────────────────

function generateId() {
  return 'ses_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10);
}

module.exports = { start, stop, isRunning, getStatus, onStatusChange, createSessionChannel, deleteSessionChannel, refreshAllLobbyStatus, autoCreateChannel };
