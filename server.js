/**
 * TenTen Clone - Signaling Server
 * 
 * Handles:
 * - WebRTC signaling (SDP offer/answer, ICE candidates)
 * - User presence (online/offline)
 * - Poke system (multiple poke types)
 * - DND (Do Not Disturb) status
 * - Ghost mode (per-user muting)
 * - Room management for exactly 3 users
 * 
 * NO audio/video data passes through this server.
 * All media is peer-to-peer via WebRTC.
 * 
 * Deploy: Push to GitHub -> Deploy on Railway
 * Run locally: node server.js
 */

require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
  },
});

// ─── In-memory state (ephemeral by design) ───────────────────────────

const USERS = new Map();

const POKE_TYPES = ['wave', 'alert', 'poop', 'heart', 'laugh'];

// ─── Helper functions ────────────────────────────────────────────────

function broadcastPresence() {
  const presence = {};
  for (const [userId, user] of USERS) {
    presence[userId] = {
      name: user.name,
      online: user.online,
      dnd: user.dnd,
    };
  }
  io.emit('presence-update', presence);
}

function getUserBySocketId(socketId) {
  for (const [userId, user] of USERS) {
    if (user.socketId === socketId) return { userId, ...user };
  }
  return null;
}

// ─── REST endpoints ──────────────────────────────────────────────────

app.get('/health', (req, res) => {
  res.json({ status: 'ok', users: USERS.size });
});

app.get('/users', (req, res) => {
  const users = {};
  for (const [userId, user] of USERS) {
    users[userId] = {
      name: user.name,
      online: user.online,
      dnd: user.dnd,
    };
  }
  res.json(users);
});

app.post('/register', (req, res) => {
  const { userId, name } = req.body;

  if (!userId || !name) {
    return res.status(400).json({ error: 'userId and name required' });
  }

  if (USERS.has(userId)) {
    USERS.get(userId).name = name;
    return res.json({ success: true, message: 'User updated' });
  }

  if (USERS.size >= 3) {
    return res.status(403).json({ error: 'Max 3 users allowed' });
  }

  USERS.set(userId, {
    name,
    socketId: null,
    online: false,
    dnd: false,
    ghosting: new Set(),
  });

  console.log(`[REGISTER] ${name} (${userId}) — ${USERS.size}/3 users`);
  res.json({ success: true, message: 'User registered' });
});

// ─── Socket.IO events ────────────────────────────────────────────────

io.on('connection', (socket) => {
  console.log(`[SOCKET] Connected: ${socket.id}`);

  // User goes online
  socket.on('go-online', ({ userId }) => {
    const user = USERS.get(userId);
    if (!user) {
      socket.emit('error', { message: 'User not registered' });
      return;
    }

    user.socketId = socket.id;
    user.online = true;
    socket.userId = userId;
    socket.join('tenten-room');

    console.log(`[ONLINE] ${user.name} (${userId})`);
    broadcastPresence();
  });

  // WebRTC: Offer
  socket.on('webrtc-offer', ({ targetUserId, sdp }) => {
    const sender = getUserBySocketId(socket.id);
    if (!sender) return;

    const target = USERS.get(targetUserId);
    if (!target || !target.socketId) return;

    if (target.ghosting.has(sender.userId)) {
      console.log(`[GHOST] ${target.name} is ghosting ${sender.name}, blocking offer`);
      return;
    }

    io.to(target.socketId).emit('webrtc-offer', {
      fromUserId: sender.userId,
      sdp,
    });
  });

  // WebRTC: Answer
  socket.on('webrtc-answer', ({ targetUserId, sdp }) => {
    const sender = getUserBySocketId(socket.id);
    if (!sender) return;

    const target = USERS.get(targetUserId);
    if (!target || !target.socketId) return;

    io.to(target.socketId).emit('webrtc-answer', {
      fromUserId: sender.userId,
      sdp,
    });
  });

  // WebRTC: ICE candidate
  socket.on('webrtc-ice-candidate', ({ targetUserId, candidate }) => {
    const sender = getUserBySocketId(socket.id);
    if (!sender) return;

    const target = USERS.get(targetUserId);
    if (!target || !target.socketId) return;

    io.to(target.socketId).emit('webrtc-ice-candidate', {
      fromUserId: sender.userId,
      candidate,
    });
  });

  // Push-to-talk signaling
  socket.on('talk-start', () => {
    const sender = getUserBySocketId(socket.id);
    if (!sender) return;

    socket.to('tenten-room').emit('talk-start', {
      userId: sender.userId,
      name: sender.name,
    });
  });

  socket.on('talk-stop', () => {
    const sender = getUserBySocketId(socket.id);
    if (!sender) return;

    socket.to('tenten-room').emit('talk-stop', {
      userId: sender.userId,
    });
  });

  // Video toggle
  socket.on('video-toggle', ({ enabled }) => {
    const sender = getUserBySocketId(socket.id);
    if (!sender) return;

    socket.to('tenten-room').emit('video-toggle', {
      userId: sender.userId,
      enabled,
    });
  });

  // Poke system
  socket.on('poke', ({ targetUserId, pokeType }) => {
    const sender = getUserBySocketId(socket.id);
    if (!sender) return;

    if (!POKE_TYPES.includes(pokeType)) {
      socket.emit('error', { message: 'Invalid poke type' });
      return;
    }

    const target = USERS.get(targetUserId);
    if (!target || !target.socketId) return;

    if (target.dnd) {
      socket.emit('poke-blocked', {
        targetUserId,
        reason: 'dnd',
        message: `${target.name} is in Do Not Disturb mode`,
      });
      return;
    }

    if (target.ghosting.has(sender.userId)) {
      socket.emit('poke-blocked', {
        targetUserId,
        reason: 'ghosted',
        message: `${target.name} has ghosted you`,
      });
      return;
    }

    io.to(target.socketId).emit('poke-received', {
      fromUserId: sender.userId,
      fromName: sender.name,
      pokeType,
      timestamp: Date.now(),
    });

    console.log(`[POKE] ${sender.name} -> ${target.name} (${pokeType})`);
  });

  // DND
  socket.on('set-dnd', ({ enabled }) => {
    const sender = getUserBySocketId(socket.id);
    if (!sender) return;

    const user = USERS.get(sender.userId);
    if (user) {
      user.dnd = enabled;
      console.log(`[DND] ${user.name} -> ${enabled ? 'ON' : 'OFF'}`);
      broadcastPresence();
    }
  });

  // Ghost mode
  socket.on('ghost-user', ({ targetUserId, ghost }) => {
    const sender = getUserBySocketId(socket.id);
    if (!sender) return;

    const user = USERS.get(sender.userId);
    if (!user) return;

    if (ghost) {
      user.ghosting.add(targetUserId);
      console.log(`[GHOST] ${user.name} ghosted ${targetUserId}`);
    } else {
      user.ghosting.delete(targetUserId);
      console.log(`[UNGHOST] ${user.name} un-ghosted ${targetUserId}`);
    }

    socket.emit('ghost-list-updated', {
      ghosting: Array.from(user.ghosting),
    });
  });

  // Disconnect
  socket.on('disconnect', () => {
    const user = getUserBySocketId(socket.id);
    if (user) {
      const userData = USERS.get(user.userId);
      if (userData) {
        userData.online = false;
        userData.socketId = null;
      }
      console.log(`[OFFLINE] ${user.name} (${user.userId})`);
      broadcastPresence();
    }
  });
});

// ─── Start server ────────────────────────────────────────────────────

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`
  ╔═══════════════════════════════════════════╗
  ║   TenTen Clone — Signaling Server         ║
  ║   Running on port ${PORT}                    ║
  ║   Max users: 3                            ║
  ║   WebRTC: peer-to-peer                    ║
  ║   Storage: none (ephemeral)               ║
  ╚═══════════════════════════════════════════╝
  `);
});
