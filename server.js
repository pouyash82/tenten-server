/**
 * TenTen Clone - Signaling Server v2
 *
 * Now with PIN-based friend system:
 * - Each user gets a unique 4-digit PIN on registration
 * - Users add friends by entering their PIN
 * - Only friends can see each other, talk, and poke
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

// ─── In-memory state ─────────────────────────────────────────────────

const USERS = new Map();
// userId -> { name, pin, socketId, online, dnd, friends: Set<userId>, ghosting: Set<userId> }

const PIN_TO_USER = new Map();
// pin -> userId (reverse lookup)

const POKE_TYPES = ['wave', 'alert', 'poop', 'heart', 'laugh'];

// ─── Helpers ─────────────────────────────────────────────────────────

function generatePin() {
  let pin;
  do {
    pin = Math.floor(1000 + Math.random() * 9000).toString();
  } while (PIN_TO_USER.has(pin));
  return pin;
}

function broadcastPresenceToUser(userId) {
  const user = USERS.get(userId);
  if (!user || !user.socketId) return;

  const presence = {};
  for (const friendId of user.friends) {
    const friend = USERS.get(friendId);
    if (friend) {
      presence[friendId] = {
        name: friend.name,
        online: friend.online,
        dnd: friend.dnd,
      };
    }
  }

  io.to(user.socketId).emit('presence-update', presence);
}

function broadcastPresenceToAll() {
  for (const [userId] of USERS) {
    broadcastPresenceToUser(userId);
  }
}

function getUserBySocketId(socketId) {
  for (const [userId, user] of USERS) {
    if (user.socketId === socketId) return { userId, ...user };
  }
  return null;
}

function areFriends(userId1, userId2) {
  const user1 = USERS.get(userId1);
  return user1 && user1.friends.has(userId2);
}

// ─── REST endpoints ──────────────────────────────────────────────────

app.get('/health', (req, res) => {
  res.json({ status: 'ok', users: USERS.size });
});

// Register a new user — returns their unique PIN
app.post('/register', (req, res) => {
  const { userId, name } = req.body;

  if (!userId || !name) {
    return res.status(400).json({ error: 'userId and name required' });
  }

  // Re-registration
  if (USERS.has(userId)) {
    const user = USERS.get(userId);
    user.name = name;
    return res.json({
      success: true,
      message: 'User updated',
      pin: user.pin,
      friends: Array.from(user.friends).map((fId) => {
        const f = USERS.get(fId);
        return f ? { userId: fId, name: f.name } : null;
      }).filter(Boolean),
    });
  }

  if (USERS.size >= 10) {
    return res.status(403).json({ error: 'Server is full' });
  }

  const pin = generatePin();

  USERS.set(userId, {
    name,
    pin,
    socketId: null,
    online: false,
    dnd: false,
    friends: new Set(),
    ghosting: new Set(),
  });

  PIN_TO_USER.set(pin, userId);

  console.log(`[REGISTER] ${name} (${userId}) PIN: ${pin} — ${USERS.size} users`);
  res.json({ success: true, pin, friends: [] });
});

// Add a friend by PIN
app.post('/add-friend', (req, res) => {
  const { userId, friendPin } = req.body;

  if (!userId || !friendPin) {
    return res.status(400).json({ error: 'userId and friendPin required' });
  }

  const user = USERS.get(userId);
  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }

  // Can't add yourself
  if (user.pin === friendPin) {
    return res.status(400).json({ error: "That's your own PIN!" });
  }

  const friendUserId = PIN_TO_USER.get(friendPin);
  if (!friendUserId) {
    return res.status(404).json({ error: 'No user found with that PIN' });
  }

  const friend = USERS.get(friendUserId);
  if (!friend) {
    return res.status(404).json({ error: 'Friend not found' });
  }

  // Already friends
  if (user.friends.has(friendUserId)) {
    return res.json({
      success: true,
      message: 'Already friends',
      friend: { userId: friendUserId, name: friend.name },
    });
  }

  // Max 2 friends (3 people total)
  if (user.friends.size >= 2) {
    return res.status(403).json({ error: 'Max 2 friends allowed' });
  }

  if (friend.friends.size >= 2) {
    return res.status(403).json({ error: 'This person already has 2 friends' });
  }

  // Add both ways (mutual friendship)
  user.friends.add(friendUserId);
  friend.friends.add(userId);

  console.log(`[FRIENDS] ${user.name} <-> ${friend.name}`);

  // Update presence for both
  broadcastPresenceToUser(userId);
  broadcastPresenceToUser(friendUserId);

  res.json({
    success: true,
    message: `You and ${friend.name} are now friends!`,
    friend: { userId: friendUserId, name: friend.name },
  });
});

// Get user info (for app reload)
app.get('/user/:userId', (req, res) => {
  const user = USERS.get(req.params.userId);
  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }

  res.json({
    name: user.name,
    pin: user.pin,
    friends: Array.from(user.friends).map((fId) => {
      const f = USERS.get(fId);
      return f ? { userId: fId, name: f.name } : null;
    }).filter(Boolean),
  });
});

// ─── Socket.IO events ────────────────────────────────────────────────

io.on('connection', (socket) => {
  console.log(`[SOCKET] Connected: ${socket.id}`);

  socket.on('go-online', ({ userId }) => {
    const user = USERS.get(userId);
    if (!user) {
      socket.emit('error', { message: 'User not registered' });
      return;
    }

    user.socketId = socket.id;
    user.online = true;
    socket.userId = userId;
    socket.join('room-' + userId);

    console.log(`[ONLINE] ${user.name} (${userId})`);
    broadcastPresenceToAll();
  });

  // WebRTC: Offer (friends only)
  socket.on('webrtc-offer', ({ targetUserId, sdp }) => {
    const sender = getUserBySocketId(socket.id);
    if (!sender || !areFriends(sender.userId, targetUserId)) return;

    const target = USERS.get(targetUserId);
    if (!target || !target.socketId) return;

    if (target.ghosting.has(sender.userId)) return;

    io.to(target.socketId).emit('webrtc-offer', {
      fromUserId: sender.userId,
      sdp,
    });
  });

  socket.on('webrtc-answer', ({ targetUserId, sdp }) => {
    const sender = getUserBySocketId(socket.id);
    if (!sender || !areFriends(sender.userId, targetUserId)) return;

    const target = USERS.get(targetUserId);
    if (!target || !target.socketId) return;

    io.to(target.socketId).emit('webrtc-answer', {
      fromUserId: sender.userId,
      sdp,
    });
  });

  socket.on('webrtc-ice-candidate', ({ targetUserId, candidate }) => {
    const sender = getUserBySocketId(socket.id);
    if (!sender || !areFriends(sender.userId, targetUserId)) return;

    const target = USERS.get(targetUserId);
    if (!target || !target.socketId) return;

    io.to(target.socketId).emit('webrtc-ice-candidate', {
      fromUserId: sender.userId,
      candidate,
    });
  });

  // Talk (friends only)
  socket.on('talk-start', () => {
    const sender = getUserBySocketId(socket.id);
    if (!sender) return;

    const user = USERS.get(sender.userId);
    for (const friendId of user.friends) {
      const friend = USERS.get(friendId);
      if (friend && friend.socketId) {
        io.to(friend.socketId).emit('talk-start', {
          userId: sender.userId,
          name: sender.name,
        });
      }
    }
  });

  socket.on('talk-stop', () => {
    const sender = getUserBySocketId(socket.id);
    if (!sender) return;

    const user = USERS.get(sender.userId);
    for (const friendId of user.friends) {
      const friend = USERS.get(friendId);
      if (friend && friend.socketId) {
        io.to(friend.socketId).emit('talk-stop', {
          userId: sender.userId,
        });
      }
    }
  });

  // Video toggle (friends only)
  socket.on('video-toggle', ({ enabled }) => {
    const sender = getUserBySocketId(socket.id);
    if (!sender) return;

    const user = USERS.get(sender.userId);
    for (const friendId of user.friends) {
      const friend = USERS.get(friendId);
      if (friend && friend.socketId) {
        io.to(friend.socketId).emit('video-toggle', {
          userId: sender.userId,
          enabled,
        });
      }
    }
  });

  // Poke (friends only)
  socket.on('poke', ({ targetUserId, pokeType }) => {
    const sender = getUserBySocketId(socket.id);
    if (!sender || !areFriends(sender.userId, targetUserId)) return;

    if (!POKE_TYPES.includes(pokeType)) return;

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
      broadcastPresenceToAll();
    }
  });

  // Ghost
  socket.on('ghost-user', ({ targetUserId, ghost }) => {
    const sender = getUserBySocketId(socket.id);
    if (!sender) return;

    const user = USERS.get(sender.userId);
    if (!user) return;

    if (ghost) {
      user.ghosting.add(targetUserId);
    } else {
      user.ghosting.delete(targetUserId);
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
      broadcastPresenceToAll();
    }
  });
});

// ─── Start ───────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`
  ╔═══════════════════════════════════════════╗
  ║   TenTen Clone — Signaling Server v2      ║
  ║   Running on port ${PORT}                    ║
  ║   PIN-based friend system                 ║
  ║   WebRTC: peer-to-peer                    ║
  ╚═══════════════════════════════════════════╝
  `);
});
