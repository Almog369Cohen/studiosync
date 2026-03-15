/**
 * StudioSync — Signaling Server
 * ==============================
 * Pure WebRTC signaling — no audio passes through here.
 * Only SDP offer/answer and ICE candidates for P2P negotiation.
 *
 * Stack: Node.js + Socket.io + Express
 * Deploy: Railway / Fly.io / Render (free tier)
 *
 * npm install express socket.io cors
 */

const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');
const crypto  = require('crypto');

const app    = express();
const server = http.createServer(app);

// ── CORS: allow browser clients ──────────────────────────────
const io = new Server(server, {
  cors: {
    origin: '*',           // lock down to your domain in production
    methods: ['GET', 'POST']
  }
});

app.use(express.json());

// ── In-memory session store ───────────────────────────────────
// session = { code, hostId, peers: Set<socketId>, created, daw, perms }
const sessions = new Map();

// ── Helpers ───────────────────────────────────────────────────
function generateCode() {
  // e.g. K7M-4RX
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let c = '';
  for (let i = 0; i < 6; i++) c += chars[Math.floor(Math.random() * chars.length)];
  return c.slice(0, 3) + '-' + c.slice(3);
}

function cleanSessions() {
  const TTL = 8 * 60 * 60 * 1000; // 8 hours
  const now = Date.now();
  for (const [code, sess] of sessions) {
    if (now - sess.created > TTL) sessions.delete(code);
  }
}
setInterval(cleanSessions, 60 * 60 * 1000);

// ── REST: health check ────────────────────────────────────────
app.get('/health', (_, res) => res.json({
  status: 'ok',
  sessions: sessions.size,
  uptime: process.uptime()
}));

// ── Socket.io ─────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log(`[+] ${socket.id} connected`);

  // ── HOST: create session ──────────────────────────────────
  socket.on('host:create', ({ daw, audioTool }, ack) => {
    const code = generateCode();
    const session = {
      code,
      hostId:  socket.id,
      peers:   new Set([socket.id]),
      created: Date.now(),
      daw,
      audioTool,
      perms: { transport: true, faders: true, mute: false, midi: false, screen: false }
    };
    sessions.set(code, session);
    socket.join(code);
    socket.data.code = code;
    socket.data.role = 'host';

    console.log(`[Session] Created ${code} (${daw}) by ${socket.id}`);
    ack({ ok: true, code });
  });

  // ── REMOTE: join session ──────────────────────────────────
  socket.on('remote:join', ({ code, name }, ack) => {
    const clean = code.replace(/[^A-Z0-9]/gi, '').toUpperCase();
    const lookup = clean.slice(0,3) + '-' + clean.slice(3);
    const session = sessions.get(lookup);

    if (!session) { ack({ ok: false, error: 'Session not found' }); return; }
    if (session.peers.size >= 4) { ack({ ok: false, error: 'Session full' }); return; }

    session.peers.add(socket.id);
    socket.join(lookup);
    socket.data.code = lookup;
    socket.data.role = 'remote';
    socket.data.name = name || 'Remote_' + Math.floor(Math.random() * 100);

    console.log(`[Session] ${socket.data.name} joined ${lookup}`);

    // Tell host someone joined
    io.to(session.hostId).emit('peer:joined', {
      peerId: socket.id,
      name: socket.data.name
    });

    ack({
      ok: true,
      code: lookup,
      daw: session.daw,
      perms: session.perms,
      hostId: session.hostId
    });

    // Start WebRTC: tell host to create offer for new peer
    io.to(session.hostId).emit('webrtc:create-offer', { peerId: socket.id });
  });

  // ── WebRTC Signaling ──────────────────────────────────────
  socket.on('webrtc:offer', ({ peerId, offer }) => {
    io.to(peerId).emit('webrtc:offer', { peerId: socket.id, offer });
  });

  socket.on('webrtc:answer', ({ peerId, answer }) => {
    io.to(peerId).emit('webrtc:answer', { peerId: socket.id, answer });
  });

  socket.on('webrtc:ice', ({ peerId, candidate }) => {
    io.to(peerId).emit('webrtc:ice', { peerId: socket.id, candidate });
  });

  // ── DAW State Sync (via DataChannel is preferred, fallback via WS) ──
  socket.on('daw:state', (payload) => {
    const code = socket.data.code;
    if (!code) return;
    socket.to(code).emit('daw:state', payload);
  });

  // ── Permissions update (host only) ───────────────────────
  socket.on('session:perms', (perms) => {
    const code = socket.data.code;
    const sess = sessions.get(code);
    if (!sess || sess.hostId !== socket.id) return;
    sess.perms = perms;
    socket.to(code).emit('session:perms', perms);
  });

  // ── Chat ─────────────────────────────────────────────────
  socket.on('chat:msg', ({ text }) => {
    const code = socket.data.code;
    if (!code) return;
    io.to(code).emit('chat:msg', {
      from:   socket.data.name || (socket.data.role === 'host' ? 'Host' : 'Remote'),
      role:   socket.data.role,
      text,
      ts:     Date.now()
    });
  });

  // ── Talkback signal ───────────────────────────────────────
  socket.on('talkback:start', () => {
    socket.to(socket.data.code).emit('talkback:start', { from: socket.id });
  });
  socket.on('talkback:stop', () => {
    socket.to(socket.data.code).emit('talkback:stop', { from: socket.id });
  });

  // ── Ping/Latency ─────────────────────────────────────────
  socket.on('ping:req', (ts) => {
    socket.emit('ping:res', ts);
  });

  // ── Disconnect ───────────────────────────────────────────
  socket.on('disconnect', () => {
    const code = socket.data.code;
    const sess = sessions.get(code);
    if (!sess) return;

    sess.peers.delete(socket.id);
    console.log(`[-] ${socket.id} left ${code}`);

    if (sess.hostId === socket.id) {
      // Host left — end session
      io.to(code).emit('session:ended', { reason: 'Host disconnected' });
      sessions.delete(code);
    } else {
      io.to(sess.hostId).emit('peer:left', { peerId: socket.id });
    }
  });
});

// ── Start ─────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`\n🚀 StudioSync Signaling Server`);
  console.log(`   Port  : ${PORT}`);
  console.log(`   Status: Ready\n`);
});
