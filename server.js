const http  = require('http');
const https = require('https');
const os    = require('os');
const crypto = require('crypto');

// ── Morning (Green Invoice) API ────────────────────────────
const MORNING_API_ID     = process.env.MORNING_API_ID     || '';
const MORNING_API_SECRET = process.env.MORNING_API_SECRET || '';
const MORNING_BASE       = 'https://api.greeninvoice.co.il/api/v1';
const MORNING_PRICE      = Number(process.env.MORNING_PRICE || '99');   // ₪/month
const APP_URL            = process.env.APP_URL || 'https://studiosync-nxu0.onrender.com';

let morningToken = null;
let morningTokenExp = 0;

async function morningRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const options = {
      hostname: 'api.greeninvoice.co.il',
      path: '/api/v1' + path,
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(morningToken ? { Authorization: 'Bearer ' + morningToken } : {}),
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {})
      }
    };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { resolve({ error: data }); }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function getMorningToken() {
  if (morningToken && Date.now() < morningTokenExp) return morningToken;
  const res = await morningRequest('POST', '/account/token', { id: MORNING_API_ID, secret: MORNING_API_SECRET });
  if (!res.token) throw new Error('Morning auth failed: ' + JSON.stringify(res));
  morningToken = res.token;
  morningTokenExp = Date.now() + 23 * 60 * 60 * 1000; // 23h
  return morningToken;
}

async function createMorningPaymentLink(email, name) {
  await getMorningToken();
  const doc = await morningRequest('POST', '/documents', {
    description: 'StudioSync Pro — מנוי חודשי',
    type: 400,
    date: new Date().toISOString().slice(0, 10),
    dueDate: new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10),
    lang: 'he',
    currency: 'ILS',
    vatType: 0,
    discount: 0,
    client: { name: name || 'StudioSync User', emails: email ? [email] : [] },
    income: [{
      catalogNum: 'SS-PRO-MONTHLY',
      description: 'StudioSync Pro — שליטה מרחוק + שמע + שיתוף מסך ללא הגבלה',
      quantity: 1,
      price: MORNING_PRICE,
      currency: 'ILS',
      vatType: 1
    }],
    remarks: 'לאחר התשלום תקבל קוד רישיון לאפליקציה'
  });
  if (doc.errorCode) throw new Error('Morning doc error: ' + doc.message);
  return doc.url || doc.paymentUrl || doc.editUrl || null;
}

// ── License System ─────────────────────────────────────────
const VALID_LICENSES = new Set(
  (process.env.VALID_LICENSES || '').split(',').map(k => k.trim()).filter(Boolean)
);
const runtimeLicenses = new Map(); // key → { email, createdAt }
const trialSessions   = new Map(); // ip → { count, date }

function genLicenseKey() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const seg = () => Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  return 'SS-' + seg() + '-' + seg() + '-' + seg();
}

function checkLicense(key) {
  if (!key) return false;
  const k = key.trim().toUpperCase();
  return VALID_LICENSES.has(k) || runtimeLicenses.has(k);
}

function checkTrial(ip) {
  const today = new Date().toISOString().slice(0, 10);
  const rec = trialSessions.get(ip);
  if (!rec || rec.date !== today) return true;
  return rec.count < 3;
}

function useTrial(ip) {
  const today = new Date().toISOString().slice(0, 10);
  const rec = trialSessions.get(ip);
  if (!rec || rec.date !== today) { trialSessions.set(ip, { count: 1, date: today }); return; }
  rec.count++;
}

// ── Sessions ──────────────────────────────────────────────
const sessions = new Map(); // code → { peers: Set<clientId>, daw, created }
const queues   = new Map(); // clientId → [messages]
const clients  = new Map(); // clientId → { code, name, color, instrument, res, seen }

function genCode() {
  const c = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 6; i++) s += c[Math.floor(Math.random() * c.length)];
  return s.slice(0, 3) + '-' + s.slice(3);
}

function getIP() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list) {
      if (i.family === 'IPv4' && !i.internal) return i.address;
    }
  }
  return 'localhost';
}

function push(clientId, msg) {
  if (!queues.has(clientId)) queues.set(clientId, []);
  queues.get(clientId).push(msg);
  const c = clients.get(clientId);
  if (c?.res) flush(clientId);
}

function pushAll(code, msg, exceptId) {
  for (const [id, c] of clients) {
    if (c.code === code && id !== exceptId) push(id, msg);
  }
}

function flush(clientId) {
  const c = clients.get(clientId);
  const q = queues.get(clientId) || [];
  if (!c?.res || q.length === 0) return;
  const res = c.res; c.res = null;
  res.writeHead(200, hdrs({ 'Content-Type': 'application/json' }));
  res.end(JSON.stringify({ messages: q }));
  queues.set(clientId, []);
}

function hdrs(extra = {}) {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    ...extra
  };
}

function body(req) {
  return new Promise(resolve => {
    let s = '';
    req.on('data', d => s += d);
    req.on('end', () => { try { resolve(JSON.parse(s || '{}')); } catch { resolve({}); } });
  });
}

function json(res, data, code = 200) {
  res.writeHead(code, hdrs({ 'Content-Type': 'application/json' }));
  res.end(JSON.stringify(data));
}

// ── Cleanup stale clients every 30s ──────────────────────
setInterval(() => {
  const now = Date.now();
  for (const [id, c] of clients) {
    if (now - c.seen > 45000) {
      const sess = sessions.get(c.code);
      if (sess) {
        sess.peers.delete(id);
        pushAll(c.code, { type: 'peer:left', peerId: id, name: c.name }, id);
        if (sess.peers.size === 0) {
          sessions.delete(c.code);
        }
      }
      clients.delete(id);
      queues.delete(id);
    }
  }
}, 30000);

// ── HTTP Server ───────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const url  = new URL(req.url, 'http://localhost');
  const path = url.pathname;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, hdrs()); res.end(); return;
  }

  // ── ICE config ──
  if (path === '/api/ice') {
    return json(res, { iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun.relay.metered.ca:80' },
      { urls: 'turn:global.relay.metered.ca:80',             username: 'open', credential: 'open' },
      { urls: 'turn:global.relay.metered.ca:80?transport=tcp', username: 'open', credential: 'open' },
      { urls: 'turn:global.relay.metered.ca:443',            username: 'open', credential: 'open' },
      { urls: 'turn:global.relay.metered.ca:443?transport=tcp', username: 'open', credential: 'open' }
    ]});
  }

  // ── License verification ──
  if (path === '/api/verify-license' && req.method === 'POST') {
    const data = await body(req);
    const valid = checkLicense(data.license);
    return json(res, { ok: valid, plan: valid ? 'pro' : 'invalid' });
  }

  // ── Create Morning payment link ──
  if (path === '/api/create-payment' && req.method === 'POST') {
    if (!MORNING_API_ID) return json(res, { ok: false, error: 'payment_not_configured' });
    const data = await body(req);
    try {
      const payUrl = await createMorningPaymentLink(data.email, data.name);
      return json(res, { ok: true, url: payUrl });
    } catch(e) {
      console.error('Morning error:', e.message);
      return json(res, { ok: false, error: e.message }, 500);
    }
  }

  // ── Morning Webhook (payment confirmation) ──
  if (path === '/api/morning-webhook' && req.method === 'POST') {
    const data = await body(req);
    console.log('[Morning webhook]', JSON.stringify(data).slice(0, 300));
    const isPaid = data.status === 'paid' || data.payment?.length > 0 || data.type === 400;
    if (isPaid) {
      const email = data.client?.emails?.[0] || data.client?.email || '';
      const name  = data.client?.name || '';
      const key   = genLicenseKey();
      runtimeLicenses.set(key, { email, name, createdAt: new Date().toISOString() });
      VALID_LICENSES.add(key);
      console.log('[License issued]', key, 'for', email);
    }
    return json(res, { ok: true });
  }

  // ── Admin: list active licenses ──
  if (path === '/api/admin/licenses' && req.method === 'GET') {
    const adminPass = process.env.ADMIN_PASS || 'studiosync-admin';
    if (url.searchParams.get('pass') !== adminPass) return json(res, { ok: false }, 403);
    const list = [...runtimeLicenses.entries()].map(([k, v]) => ({ key: k, ...v }));
    return json(res, { ok: true, count: list.length, licenses: list });
  }

  // ── Create session ──
  if ((path === '/api/create' || path === '/api/host') && req.method === 'POST') {
    const data = await body(req);
    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || 'unknown';
    const licensed = checkLicense(data.license);

    if (!licensed) {
      if (!checkTrial(ip)) {
        return json(res, { ok: false, error: 'trial_limit', message: 'You have reached 3 free sessions today. Upgrade to Pro to continue.' }, 402);
      }
      useTrial(ip);
    }

    const id   = 'p_' + Date.now() + crypto.randomBytes(3).toString('hex');
    const code = genCode();
    const name = data.name || 'Producer';
    const color = data.color || '#6c47ff';
    const instrument = data.instrument || 'Producer';
    clients.set(id, { code, name, color, instrument, res: null, seen: Date.now() });
    queues.set(id, []);
    sessions.set(code, { peers: new Set([id]), daw: data.daw, created: Date.now(), licensed });
    console.log('[+] Session created:', code, licensed ? '(PRO)' : '(trial)');
    return json(res, { ok: true, code, clientId: id, peerNumber: 1, plan: licensed ? 'pro' : 'trial' });
  }

  // ── Join session ──
  if (path === '/api/join' && req.method === 'POST') {
    const data = await body(req);
    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || 'unknown';
    const raw  = (data.code || '').replace(/[^A-Z0-9]/gi, '').toUpperCase();
    const code = raw.slice(0, 3) + '-' + raw.slice(3);
    const sess = sessions.get(code);
    if (!sess) return json(res, { ok: false, error: 'Session not found — check the code and try again' }, 404);
    if (sess.peers.size >= 10) return json(res, { ok: false, error: 'Session is full (max 10 peers)' }, 403);

    const licensed = checkLicense(data.license);
    if (!licensed && !sess.licensed) {
      if (!checkTrial(ip)) {
        return json(res, { ok: false, error: 'trial_limit', message: 'You have reached 3 free sessions today. Upgrade to Pro to continue.' }, 402);
      }
    }

    const id         = 'p_' + Date.now() + crypto.randomBytes(3).toString('hex');
    const name       = data.name || 'Musician_' + Math.floor(Math.random() * 100);
    const color      = data.color || '#12b76a';
    const instrument = data.instrument || 'Keys';

    clients.set(id, { code, name, color, instrument, res: null, seen: Date.now() });
    queues.set(id, []);
    sess.peers.add(id);

    // Collect existing peers info for the welcome message
    const existingPeers = [];
    for (const pid of sess.peers) {
      if (pid === id) continue;
      const pc = clients.get(pid);
      if (pc) existingPeers.push({ id: pid, name: pc.name, color: pc.color, instrument: pc.instrument });
    }

    // Send welcome to joiner with list of existing peers
    push(id, { type: 'session:welcome', peers: existingPeers, code });

    // Tell ALL existing peers to create an offer to the new joiner
    for (const pid of sess.peers) {
      if (pid === id) continue;
      push(pid, { type: 'webrtc:create-offer', peerId: id, name, color, instrument });
      push(pid, { type: 'peer:joined', peerId: id, name, color, instrument });
    }

    console.log('[+] Joined:', name, '->', code, '(peer', sess.peers.size, ')');
    return json(res, { ok: true, code, clientId: id, peerNumber: sess.peers.size });
  }

  // ── Send / relay messages ──
  if (path === '/api/send' && req.method === 'POST') {
    const cid  = url.searchParams.get('cid');
    const data = await body(req);
    const c    = clients.get(cid);
    if (!c) return json(res, { ok: false });
    c.seen = Date.now();
    // Accept message directly (not wrapped in msg)
    const msg = data.type ? data : (data.msg || {});

    if      (msg.type === 'webrtc:offer')   push(msg.peerId, { ...msg, peerId: cid });
    else if (msg.type === 'webrtc:answer')  push(msg.peerId, { ...msg, peerId: cid });
    else if (msg.type === 'webrtc:ice')     push(msg.peerId, { ...msg, peerId: cid });
    else if (msg.type === 'remote:input')   pushAll(c.code, msg, cid);
    else if (msg.type === 'daw:state')      pushAll(c.code, msg, cid);
    else if (msg.type === 'chat:msg')       pushAll(c.code, { ...msg, name: msg.name || c.name, color: msg.color || c.color }, cid);
    else if (msg.type === 'ping:req')       push(cid, { type: 'ping:res', ts: msg.ts });
    else                                    pushAll(c.code, msg, cid);

    return json(res, { ok: true });
  }

  // ── Long-poll ──
  if (path === '/api/poll') {
    const cid = url.searchParams.get('cid');
    const c   = clients.get(cid);
    if (!c) { res.writeHead(404, hdrs()); res.end('{"messages":[]}'); return; }
    c.seen = Date.now();
    const q = queues.get(cid) || [];
    if (q.length > 0) {
      res.writeHead(200, hdrs({ 'Content-Type': 'application/json' }));
      res.end(JSON.stringify({ messages: q }));
      queues.set(cid, []);
    } else {
      c.res = res;
      setTimeout(() => {
        if (c.res === res) {
          c.res = null;
          res.writeHead(200, hdrs({ 'Content-Type': 'application/json' }));
          res.end('{"messages":[]}');
        }
      }, 28000);
    }
    return;
  }

  // ── Serve HTML app ─────────────────────────────────────
  res.writeHead(200, hdrs({ 'Content-Type': 'text/html; charset=utf-8' }));
  res.end(APP_HTML);
});

// ── Start ─────────────────────────────────────────────────
const PORT = process.env.PORT || 4444;
server.listen(PORT, '0.0.0.0', () => {
  const ip = getIP();
  console.log('\n🎛  StudioSync — Ready!\n');
  console.log('   Local:   http://localhost:' + PORT);
  console.log('   Network: http://' + ip + ':' + PORT);
  console.log('\n   For internet access: npx localtunnel --port ' + PORT + '\n');
});

// ══════════════════════════════════════════════════════════
// APP HTML — entire client embedded as template literal
// ══════════════════════════════════════════════════════════
const APP_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>StudioSync</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap');

:root {
  --bg: #ffffff; --s1: #f8f9fa; --s2: #f1f3f5; --s3: #e9ecef;
  --b1: #dee2e6; --b2: #ced4da;
  --txt: #1a1a2e; --hi: #0d0d1a; --mid: #6c757d; --dim: #adb5bd;
  --accent: #6c47ff; --accentD: rgba(108,71,255,.10); --accentH: rgba(108,71,255,.06);
  --green: #12b76a; --gD: rgba(18,183,106,.10);
  --red: #f04438; --rD: rgba(240,68,56,.10);
  --amber: #f79009; --aD: rgba(247,144,9,.10);
  --shadow: 0 1px 3px rgba(0,0,0,.08), 0 1px 2px rgba(0,0,0,.06);
  --shadowM: 0 4px 16px rgba(0,0,0,.12);
  --radius: 8px; --radiusL: 12px;
  --mono: 'Fira Code','Cascadia Code',monospace;
  --sans: 'Inter',system-ui,-apple-system,sans-serif;
}
* { box-sizing:border-box; margin:0; padding:0; }
body { font-family:var(--sans); background:var(--bg); color:var(--txt); overflow:hidden; height:100vh; }
.screen { display:none; height:100vh; flex-direction:column; }
.screen.on { display:flex; }

/* ── Landing ─────────────────────────────────────────── */
.land-nav { padding:16px 32px; display:flex; align-items:center; border-bottom:1px solid var(--b1); }
.brand { font-size:18px; font-weight:700; color:var(--hi); }
.brand span { color:var(--accent); }
.hero { flex:1; display:flex; flex-direction:column; align-items:center; justify-content:center; text-align:center; padding:40px 24px; }
.hero-badge { background:var(--accentD); color:var(--accent); padding:6px 14px; border-radius:100px; font-size:13px; font-weight:600; margin-bottom:24px; display:inline-block; }
.hero h1 { font-size:clamp(28px,5vw,52px); font-weight:700; line-height:1.15; margin-bottom:16px; color:var(--hi); }
.hero-sub { font-size:16px; color:var(--mid); max-width:520px; line-height:1.6; margin-bottom:36px; }
.hero-ctas { display:flex; gap:12px; flex-wrap:wrap; justify-content:center; }
.features { display:flex; gap:16px; justify-content:center; padding:0 24px 40px; flex-wrap:wrap; }
.feat-card { background:var(--s1); border:1px solid var(--b1); border-radius:var(--radiusL); padding:24px; max-width:200px; text-align:center; }
.feat-icon { font-size:28px; margin-bottom:12px; }
.feat-title { font-weight:600; font-size:14px; margin-bottom:6px; color:var(--hi); }
.feat-desc { font-size:12px; color:var(--mid); line-height:1.5; }

/* ── Buttons ─────────────────────────────────────────── */
.btn-accent { background:var(--accent); color:#fff; border:none; border-radius:var(--radius); padding:12px 28px; font-size:15px; font-weight:600; cursor:pointer; font-family:var(--sans); transition:opacity .15s; }
.btn-accent:hover { opacity:.9; }
.btn-ghost { background:transparent; color:var(--accent); border:1.5px solid var(--accent); border-radius:var(--radius); padding:12px 28px; font-size:15px; font-weight:600; cursor:pointer; font-family:var(--sans); }
.btn-ghost:hover { background:var(--accentH); }
.btn-full { width:100%; }
.btn-link { background:none; border:none; color:var(--mid); cursor:pointer; font-size:13px; text-align:center; margin-top:8px; font-family:var(--sans); }

/* ── Lobby ───────────────────────────────────────────── */
#lobby { overflow-y:auto; background:var(--s1); }
.lobby-wrap { max-width:480px; margin:0 auto; padding:40px 16px; display:flex; flex-direction:column; gap:16px; }
.lobby-brand { font-size:20px; font-weight:700; text-align:center; color:var(--hi); margin-bottom:8px; }
.lobby-brand span { color:var(--accent); }
.lobby-card { background:var(--bg); border:1px solid var(--b1); border-radius:var(--radiusL); padding:24px; box-shadow:var(--shadow); }
.lc-header { display:flex; align-items:flex-start; gap:14px; margin-bottom:20px; }
.lc-icon { font-size:24px; }
.lc-title { font-weight:600; font-size:15px; color:var(--hi); }
.lc-sub { font-size:12px; color:var(--mid); margin-top:2px; }
.lob-input { width:100%; padding:10px 12px; border:1.5px solid var(--b1); border-radius:var(--radius); font-size:14px; font-family:var(--sans); color:var(--txt); background:var(--bg); margin-bottom:14px; outline:none; transition:border .15s; }
.lob-input:focus { border-color:var(--accent); }
.code-input { font-family:var(--mono); font-size:18px; text-transform:uppercase; letter-spacing:2px; text-align:center; }
.color-label,.instr-label { font-size:12px; font-weight:600; color:var(--mid); text-transform:uppercase; letter-spacing:.5px; margin-bottom:8px; }
.color-picker { display:flex; gap:8px; flex-wrap:wrap; margin-bottom:14px; }
.color-swatch { width:28px; height:28px; border-radius:50%; cursor:pointer; border:3px solid transparent; transition:transform .1s; }
.color-swatch:hover { transform:scale(1.1); }
.color-swatch.selected { border-color:var(--hi); }
.instr-grid { display:flex; flex-wrap:wrap; gap:6px; margin-bottom:16px; }
.instr-btn { padding:6px 12px; border:1.5px solid var(--b1); border-radius:100px; background:var(--bg); color:var(--mid); font-size:12px; font-weight:500; cursor:pointer; font-family:var(--sans); transition:all .15s; }
.instr-btn:hover { border-color:var(--accent); color:var(--accent); }
.instr-btn.selected { background:var(--accentD); border-color:var(--accent); color:var(--accent); font-weight:600; }
.lobby-divider { text-align:center; color:var(--dim); font-size:13px; padding:4px 0; }

/* ── Connecting ──────────────────────────────────────── */
#connecting { align-items:center; justify-content:center; gap:16px; background:var(--s1); }
.spin { width:32px; height:32px; border:3px solid var(--b1); border-top-color:var(--accent); border-radius:50%; animation:spin .8s linear infinite; }
@keyframes spin { to { transform:rotate(360deg); } }

/* ── Session layout ─────────────────────────────────── */
#session { overflow:hidden; }
.topbar { height:52px; display:flex; align-items:center; gap:10px; padding:0 16px; border-bottom:1px solid var(--b1); background:var(--bg); flex-shrink:0; }
.tb-brand { font-size:15px; font-weight:700; color:var(--hi); white-space:nowrap; }
.tb-brand span { color:var(--accent); }
.tb-sep { width:1px; height:24px; background:var(--b1); }
.session-code-chip { display:flex; align-items:center; gap:6px; background:var(--s1); border:1px solid var(--b1); border-radius:6px; padding:4px 10px; cursor:pointer; font-family:var(--mono); font-size:13px; font-weight:600; color:var(--hi); }
.session-code-chip:hover { border-color:var(--accent); color:var(--accent); }
.copy-icon { font-size:14px; color:var(--mid); }
.peer-avatars { display:flex; margin-left:4px; }
.peer-avatar { width:28px; height:28px; border-radius:50%; border:2px solid var(--bg); display:flex; align-items:center; justify-content:center; font-size:11px; font-weight:700; color:#fff; cursor:default; margin-left:-6px; }
.peer-avatar.self { margin-left:0; }
.tb-flex { flex:1; }
.tb-status { font-size:12px; color:var(--mid); white-space:nowrap; }
.tb-btn { background:none; border:1px solid var(--b1); border-radius:6px; padding:4px 10px; cursor:pointer; font-size:13px; color:var(--txt); font-family:var(--sans); }
.tb-btn:hover { border-color:var(--accent); color:var(--accent); }
.tb-leave { color:var(--red); border-color:var(--rD); }
.tb-leave:hover { border-color:var(--red); background:var(--rD); }

/* ── Workspace ───────────────────────────────────────── */
.workspace { flex:1; display:flex; overflow:hidden; }
.track-panel { flex:1; overflow-y:auto; padding-bottom:56px; display:flex; flex-direction:column; }
.marker-ruler { height:24px; border-bottom:1px solid var(--b1); position:relative; background:var(--s1); flex-shrink:0; }
.participant-panel { width:260px; border-left:1px solid var(--b1); display:flex; flex-direction:column; flex-shrink:0; }
.panel-tabs { display:flex; border-bottom:1px solid var(--b1); flex-shrink:0; }
.ptab { flex:1; padding:10px; background:none; border:none; border-bottom:2px solid transparent; font-size:13px; font-weight:500; cursor:pointer; color:var(--mid); font-family:var(--sans); }
.ptab.active { color:var(--accent); border-bottom-color:var(--accent); }
.tab-content { flex:1; overflow-y:auto; display:flex; flex-direction:column; }

/* ── Peer cards ──────────────────────────────────────── */
#peerList { display:flex; flex-direction:column; gap:0; }
.peer-card { display:flex; align-items:center; gap:10px; padding:10px 12px; border-bottom:1px solid var(--b1); }
.pc-avatar { width:32px; height:32px; border-radius:50%; display:flex; align-items:center; justify-content:center; font-size:13px; font-weight:700; color:#fff; flex-shrink:0; }
.pc-info { flex:1; min-width:0; }
.pc-name { font-size:13px; font-weight:600; color:var(--hi); display:flex; align-items:center; gap:6px; }
.you-badge { background:var(--accentD); color:var(--accent); font-size:10px; padding:1px 6px; border-radius:10px; font-weight:600; }
.pc-meta { font-size:11px; color:var(--mid); margin-top:2px; }
.pc-status { color:var(--green); }
.pc-lat { font-size:11px; color:var(--dim); font-family:var(--mono); }

/* ── Chat ────────────────────────────────────────────── */
#chatArea { flex:1; overflow-y:auto; padding:8px; display:flex; flex-direction:column; gap:6px; }
.chat-msg { display:flex; flex-direction:column; gap:2px; }
.chat-name { font-size:11px; font-weight:600; }
.chat-text { font-size:13px; color:var(--txt); line-height:1.4; }
.chat-input-row { display:flex; gap:6px; padding:8px; border-top:1px solid var(--b1); flex-shrink:0; }
.chat-input-row input { flex:1; padding:7px 10px; border:1.5px solid var(--b1); border-radius:6px; font-size:13px; font-family:var(--sans); color:var(--txt); background:var(--bg); outline:none; }
.chat-input-row input:focus { border-color:var(--accent); }
.chat-input-row button { background:var(--accent); color:#fff; border:none; border-radius:6px; width:32px; cursor:pointer; font-size:16px; }

/* ── Track rows ──────────────────────────────────────── */
.track-row { display:flex; align-items:center; gap:10px; padding:8px 12px; border-bottom:1px solid var(--b1); min-height:48px; }
.track-row:hover { background:var(--s1); }
.tr-num { width:20px; font-size:11px; color:var(--dim); text-align:right; flex-shrink:0; }
.tr-color { width:4px; height:32px; border-radius:2px; flex-shrink:0; }
.tr-info { flex:0 0 140px; }
.tr-name { font-size:13px; font-weight:500; color:var(--hi); }
.tr-type { font-size:10px; color:var(--mid); text-transform:uppercase; letter-spacing:.5px; margin-top:1px; }
.tr-btns { display:flex; gap:4px; flex-shrink:0; }
.trb { width:26px; height:22px; border:1.5px solid var(--b1); background:none; border-radius:4px; font-size:10px; font-weight:700; cursor:pointer; color:var(--mid); font-family:var(--sans); }
.trb:hover { border-color:var(--accent); color:var(--accent); }
.trb.active-mute { background:var(--aD); border-color:var(--amber); color:var(--amber); }
.trb.active-solo { background:var(--accentD); border-color:var(--accent); color:var(--accent); }
.trb.active-rec { background:var(--rD); border-color:var(--red); color:var(--red); }
.tr-fader { flex:1; display:flex; align-items:center; gap:8px; }
.tr-fader input[type=range] { flex:1; height:3px; -webkit-appearance:none; appearance:none; background:var(--b1); border-radius:2px; outline:none; cursor:pointer; }
.tr-fader input[type=range]::-webkit-slider-thumb { -webkit-appearance:none; width:12px; height:12px; border-radius:50%; background:var(--accent); border:none; }
.tr-db { font-size:10px; color:var(--mid); font-family:var(--mono); width:40px; text-align:right; flex-shrink:0; }
.add-track-btn { margin:8px 12px; padding:8px; border:1.5px dashed var(--b2); border-radius:var(--radius); background:none; color:var(--mid); cursor:pointer; font-size:13px; font-family:var(--sans); text-align:center; }
.add-track-btn:hover { border-color:var(--accent); color:var(--accent); background:var(--accentH); }

/* ── Virtual Piano ───────────────────────────────────── */
#pianoWrap { position:fixed; bottom:56px; left:0; right:0; background:var(--bg); border-top:1px solid var(--b1); z-index:48; display:none; flex-direction:column; }
#pianoWrap.open { display:flex; }
.piano-header { display:flex; align-items:center; gap:10px; padding:6px 16px; border-bottom:1px solid var(--b1); }
.piano-header-label { font-size:12px; font-weight:600; color:var(--mid); flex:1; }
.piano-oct { padding:3px 10px; font-size:11px; border:1px solid var(--b1); border-radius:4px; background:none; cursor:pointer; color:var(--mid); }
.piano-oct:hover { border-color:var(--accent); color:var(--accent); }
.piano-close { background:none; border:none; cursor:pointer; color:var(--mid); font-size:16px; padding:0 4px; }
.piano-ch select { font-size:11px; border:1px solid var(--b1); border-radius:4px; padding:2px 4px; color:var(--txt); background:var(--bg); }
.piano-keys { position:relative; height:84px; display:flex; padding:6px 16px 0; overflow-x:auto; user-select:none; }
.pk-w { width:32px; height:72px; background:#fff; border:1px solid #bbb; border-radius:0 0 4px 4px; cursor:pointer; flex-shrink:0; transition:background .05s; position:relative; z-index:1; display:flex; align-items:flex-end; justify-content:center; padding-bottom:4px; }
.pk-w:hover,.pk-w.on { background:#e0d8ff; border-color:var(--accent); }
.pk-b { width:22px; height:46px; background:#222; border-radius:0 0 3px 3px; cursor:pointer; flex-shrink:0; position:relative; z-index:2; margin:0 -11px; transition:background .05s; display:flex; align-items:flex-end; justify-content:center; padding-bottom:3px; }
.pk-b:hover,.pk-b.on { background:var(--accent); }
.pk-label { font-size:8px; color:#aaa; pointer-events:none; }
.pk-w .pk-label { color:var(--mid); }
.piano-vel { display:flex; align-items:center; gap:8px; padding:4px 16px; font-size:11px; color:var(--mid); border-top:1px solid var(--b1); }
.piano-vel input[type=range] { width:100px; height:3px; -webkit-appearance:none; appearance:none; background:var(--b1); border-radius:2px; }
.piano-vel input[type=range]::-webkit-slider-thumb { -webkit-appearance:none; width:10px; height:10px; border-radius:50%; background:var(--accent); }

/* ── Permissions badges in peer card ──────────────────── */
.perm-row { display:flex; gap:4px; margin-top:4px; }
.perm-badge { padding:2px 7px; border-radius:10px; font-size:10px; font-weight:600; cursor:pointer; border:1px solid var(--b1); color:var(--mid); background:var(--s1); user-select:none; }
.perm-badge.on { background:var(--accentD); border-color:var(--accent); color:var(--accent); }
.perm-badge.on-green { background:var(--gD); border-color:var(--green); color:var(--green); }

/* ── Transport bar ───────────────────────────────────── */
.transport-bar { height:56px; border-top:1px solid var(--b1); display:flex; align-items:center; gap:8px; padding:0 16px; background:var(--bg); flex-shrink:0; position:fixed; bottom:0; left:0; right:0; z-index:50; }
.tc { width:34px; height:34px; border:1.5px solid var(--b1); border-radius:6px; background:none; cursor:pointer; font-size:14px; display:flex; align-items:center; justify-content:center; color:var(--txt); }
.tc:hover { border-color:var(--accent); color:var(--accent); }
.play-btn { background:var(--accent); border-color:var(--accent); color:#fff; }
.play-btn:hover { opacity:.9; }
.bpm-ctrl { display:flex; align-items:center; gap:2px; background:var(--s1); border:1px solid var(--b1); border-radius:6px; overflow:hidden; }
.bpm-btn { width:24px; height:34px; border:none; background:none; cursor:pointer; color:var(--mid); font-size:16px; font-family:var(--sans); }
.bpm-btn:hover { color:var(--accent); background:var(--accentH); }
.bpm-val { font-size:16px; font-weight:700; color:var(--hi); min-width:36px; text-align:center; font-family:var(--mono); }
.bpm-lbl { font-size:10px; color:var(--mid); padding-right:8px; }
.pos-display { font-family:var(--mono); font-size:13px; color:var(--mid); min-width:50px; }
.latency-pill { background:var(--s1); border:1px solid var(--b1); border-radius:100px; padding:3px 10px; font-size:11px; font-family:var(--mono); color:var(--mid); }
.share-btn { padding:0 14px; font-size:13px; font-family:var(--sans); white-space:nowrap; }

/* ── Settings panel ──────────────────────────────────── */
#settingsOverlay { position:fixed; inset:0; background:rgba(0,0,0,.4); z-index:200; display:flex; justify-content:flex-end; }
#settingsPanel { width:320px; height:100%; background:var(--bg); border-left:1px solid var(--b1); overflow-y:auto; display:flex; flex-direction:column; }
.sp-header { display:flex; align-items:center; justify-content:space-between; padding:16px; border-bottom:1px solid var(--b1); flex-shrink:0; }
.sp-title { font-weight:600; font-size:15px; color:var(--hi); }
.sp-close { background:none; border:none; cursor:pointer; font-size:20px; color:var(--mid); }
.sp-section { padding:16px; border-bottom:1px solid var(--b1); }
.sp-section-title { font-size:11px; font-weight:700; text-transform:uppercase; letter-spacing:.5px; color:var(--mid); margin-bottom:12px; }
.sp-row { display:flex; justify-content:space-between; align-items:center; font-size:13px; color:var(--txt); padding:4px 0; }
.sp-row span:last-child { color:var(--mid); font-family:var(--mono); font-size:12px; }
#dawLog { max-height:200px; overflow-y:auto; }
.dlog-entry { font-size:11px; font-family:var(--mono); color:var(--mid); padding:2px 0; border-bottom:1px solid var(--b1); }

/* ── Toast ───────────────────────────────────────────── */
#toastEl { position:fixed; bottom:72px; left:50%; transform:translateX(-50%); background:var(--hi); color:var(--bg); padding:10px 20px; border-radius:100px; font-size:13px; font-weight:500; opacity:0; transition:opacity .2s; pointer-events:none; z-index:300; white-space:nowrap; }
#toastEl.toast-show { opacity:1; }
#toastEl.toast-g { background:var(--green); color:#fff; }
#toastEl.toast-r { background:var(--red); color:#fff; }
</style>
</head>
<body>

<!-- LANDING -->
<div id="landing" class="screen on">
  <nav class="land-nav">
    <div class="brand">🎛 <span>Studio</span>Sync</div>
  </nav>
  <div class="hero">
    <div class="hero-badge">Real-time music collaboration</div>
    <h1>Make Music Together,<br>In Real Time</h1>
    <p class="hero-sub">Share your DAW screen, stream studio-quality audio, and let anyone control your session — from anywhere in the world.</p>
    <div class="hero-ctas">
      <button class="btn-accent" onclick="showLobby('create')">Create Session</button>
      <button class="btn-ghost" onclick="showLobby('join')">Join Session</button>
    </div>
  </div>
  <div class="features">
    <div class="feat-card">
      <div class="feat-icon">🔊</div>
      <div class="feat-title">Studio Audio</div>
      <div class="feat-desc">Stream DAW audio in real time, not through a microphone</div>
    </div>
    <div class="feat-card">
      <div class="feat-icon">🖱</div>
      <div class="feat-title">Full Control</div>
      <div class="feat-desc">Any participant can control the DAW — play, stop, edit tracks</div>
    </div>
    <div class="feat-card">
      <div class="feat-icon">👥</div>
      <div class="feat-title">Up to 10 People</div>
      <div class="feat-desc">Collaborate with your whole band or class in one session</div>
    </div>
  </div>
</div>

<!-- LOBBY -->
<div id="lobby" class="screen">
  <div class="lobby-wrap">
    <div class="lobby-brand">🎛 <span>Studio</span>Sync</div>

    <div class="lobby-card" id="createCard">
      <div class="lc-header">
        <div class="lc-icon">🎛</div>
        <div>
          <div class="lc-title">Create a Session</div>
          <div class="lc-sub">You'll get a code to share with others</div>
        </div>
      </div>
      <input id="createName" placeholder="Your name" class="lob-input" />
      <div class="color-label">Pick your color</div>
      <div class="color-picker" id="createColors"></div>
      <div class="instr-label">Your instrument</div>
      <div class="instr-grid" id="createInstrs"></div>
      <button class="btn-accent btn-full" onclick="hostStart()">Create Session →</button>
    </div>

    <div class="lobby-divider">or join with a code</div>

    <div class="lobby-card" id="joinCard">
      <div class="lc-header">
        <div class="lc-icon">🎧</div>
        <div>
          <div class="lc-title">Join a Session</div>
          <div class="lc-sub">Enter the code from the session creator</div>
        </div>
      </div>
      <input id="joinNameInput" placeholder="Your name" class="lob-input" />
      <div class="color-label">Pick your color</div>
      <div class="color-picker" id="joinColors"></div>
      <div class="instr-label">Your instrument</div>
      <div class="instr-grid" id="joinInstrs"></div>
      <input id="joinCode" placeholder="ABC-123" class="lob-input code-input" />
      <button class="btn-accent btn-full" onclick="remoteJoin()">Join →</button>
    </div>

    <button class="btn-link" onclick="show('landing')">← Back</button>
  </div>
</div>

<!-- CONNECTING -->
<div id="connecting" class="screen">
  <div class="spin"></div>
  <div style="font-size:14px;color:var(--mid);font-family:var(--sans)">Connecting...</div>
</div>

<!-- SESSION -->
<div id="session" class="screen">
  <!-- Top bar -->
  <div class="topbar">
    <div class="tb-brand">🎛 <span>Studio</span>Sync</div>
    <div class="tb-sep"></div>
    <div class="session-code-chip" onclick="copyCode()">
      <span id="codeDisplay">---</span>
      <span class="copy-icon">⎘</span>
    </div>
    <div class="peer-avatars" id="peerAvatars"></div>
    <div class="tb-flex"></div>
    <div class="tb-status" id="tbStatus">0 peers</div>
    <button class="tb-btn" onclick="toggleSettings()">⚙</button>
    <button class="tb-btn tb-leave" onclick="leaveSession()">Leave</button>
  </div>

  <!-- Workspace -->
  <div class="workspace">
    <!-- Left: tracks -->
    <div class="track-panel">
      <div class="marker-ruler" id="mRow"></div>
      <div id="trackArea"></div>
      <button class="add-track-btn" onclick="addTrack()">+ Add Track</button>
    </div>

    <!-- Right: participants + chat -->
    <div class="participant-panel">
      <div class="panel-tabs">
        <button class="ptab active" id="tabPeers" onclick="switchTab('peers')">Peers</button>
        <button class="ptab" id="tabChat" onclick="switchTab('chat')">Chat</button>
      </div>
      <div id="peersTab" class="tab-content">
        <div id="peerList"></div>
      </div>
      <div id="chatTab" class="tab-content" style="display:none">
        <div id="chatArea"></div>
        <div class="chat-input-row">
          <input id="chatIn" placeholder="Send a message..." onkeydown="if(event.key==='Enter')sendChat()" />
          <button onclick="sendChat()">↑</button>
        </div>
      </div>
    </div>
  </div>

  <!-- Transport bar (fixed bottom) -->
  <!-- Virtual Piano (hidden by default) -->
  <div id="pianoWrap">
    <div class="piano-header">
      <span class="piano-header-label">🎹 Virtual Piano — MIDI to host</span>
      <button class="piano-oct" onclick="pianoOctave(-1)">Oct −</button>
      <span id="pianoOctLbl" style="font-size:11px;color:var(--mid)">C4</span>
      <button class="piano-oct" onclick="pianoOctave(1)">Oct +</button>
      <span style="font-size:11px;color:var(--dim);margin-left:8px">CH</span>
      <select id="pianoChSel" style="font-size:11px;border:1px solid var(--b1);border-radius:4px;padding:2px 4px;color:var(--txt);background:var(--bg)">
        <option>1</option><option>2</option><option>3</option><option>4</option>
        <option>5</option><option>6</option><option>7</option><option>8</option>
        <option>9</option><option>10</option><option>11</option><option>12</option>
        <option>13</option><option>14</option><option>15</option><option>16</option>
      </select>
      <button class="piano-close" onclick="togglePiano()">×</button>
    </div>
    <div class="piano-keys" id="pianoKeys"></div>
    <div class="piano-vel">
      <span>Velocity</span>
      <input type="range" id="pianoVel" min="1" max="127" value="100" />
      <span id="pianoVelVal">100</span>
      <span style="margin-left:16px;color:var(--dim)">Keyboard: Z-M (low) · Q-I (high)</span>
    </div>
  </div>

  <div class="transport-bar">
    <button class="tc" onclick="cmd('stop')">⏹</button>
    <button class="tc play-btn" id="playBtn" onclick="cmd('play')">▶</button>
    <button class="tc" id="recBtn" onclick="cmd('rec')">⏺</button>
    <div class="bpm-ctrl">
      <button class="bpm-btn" onclick="cmd('bpm',-1)">−</button>
      <div class="bpm-val" id="bpmDisp">128</div>
      <div class="bpm-lbl">BPM</div>
      <button class="bpm-btn" onclick="cmd('bpm',1)">+</button>
    </div>
    <div class="pos-display" id="posDisp">1.1.1</div>
    <div class="tb-flex"></div>
    <div class="latency-pill" id="latPill">-- ms</div>
    <button class="tc" id="pianoBtn" onclick="togglePiano()" title="Virtual Piano / MIDI">🎹</button>
    <button class="tc share-btn" onclick="doShare()">🖥 Share</button>
  </div>
</div>

<!-- Settings slide-in -->
<div id="settingsOverlay" style="display:none" onclick="if(event.target===this)toggleSettings()">
  <div id="settingsPanel">
    <div class="sp-header">
      <div class="sp-title">Settings</div>
      <button class="sp-close" onclick="toggleSettings()">×</button>
    </div>
    <div class="sp-section">
      <div class="sp-section-title">Session</div>
      <div class="sp-row"><span>Session Code</span><span id="spCode" style="font-family:var(--mono)">---</span></div>
      <div class="sp-row"><span>Peers Connected</span><span id="spPeers">0</span></div>
    </div>
    <div class="sp-section">
      <div class="sp-section-title">Network</div>
      <div class="sp-row"><span>Latency</span><span id="spLatency">-- ms</span></div>
      <div class="sp-row"><span>Connection</span><span id="spConn">--</span></div>
    </div>
    <div class="sp-section">
      <div class="sp-section-title">DAW Log</div>
      <div id="dawLog"></div>
    </div>
  </div>
</div>

<!-- Toast -->
<div id="toastEl"></div>

<script>
const SERVER = '';
const PEER_COLORS = ['#6c47ff','#12b76a','#f04438','#f79009','#0ea5e9','#ec4899','#14b8a6','#8b5cf6'];
const INSTRUMENTS = ['Keys','Drums','Guitar','Bass','Vocals','Producer','Other'];
const MCOLS = ['#6c47ff','#12b76a','#f79009','#f04438','#8b5cf6'];

const S = {
  cid: null, code: null, name: 'User', color: PEER_COLORS[0], instrument: 'Producer',
  bpm: 120, playing: false, rec: false,
  pos: { b:1, bt:1, tk:1 },
  tracks: [],
  markers: [],
  peers: new Map(), // peerId → { name, color, instrument, conn, dc, latency }
  poll: false,
  activeTab: 'peers'
};

const TDEFS = [
  { n:'Kick',    t:'AUDIO', c:'#f04438' },
  { n:'Snare',   t:'AUDIO', c:'#f79009' },
  { n:'Hi-Hat',  t:'AUDIO', c:'#f79009' },
  { n:'Bass 808',t:'MIDI',  c:'#12b76a' },
  { n:'Melody',  t:'MIDI',  c:'#6c47ff' },
  { n:'Lead Vox',t:'AUDIO', c:'#8b5cf6' },
  { n:'Pad',     t:'MIDI',  c:'#6c47ff' },
  { n:'FX',      t:'AUX',   c:'#6c757d' },
];

const ICE = { iceServers: [
  { urls:'stun:stun.l.google.com:19302' },
  { urls:'turn:global.relay.metered.ca:80', username:'open', credential:'open' },
  { urls:'turn:global.relay.metered.ca:443', username:'open', credential:'open' },
]};

// ── Screen helpers ────────────────────────────────────────
function show(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('on'));
  document.getElementById(id)?.classList.add('on');
}

function showLobby(mode) {
  show('lobby');
  initColorPicker('createColors');
  initColorPicker('joinColors');
  initInstrGrid('createInstrs');
  initInstrGrid('joinInstrs');
  if (mode === 'join') document.getElementById('joinCode')?.focus();
  else document.getElementById('createName')?.focus();
}

function initColorPicker(containerId) {
  const el = document.getElementById(containerId);
  if (!el || el.children.length > 0) return;
  PEER_COLORS.forEach((c, i) => {
    const sw = document.createElement('div');
    sw.className = 'color-swatch' + (i === 0 ? ' selected' : '');
    sw.style.background = c;
    sw.dataset.color = c;
    sw.onclick = () => {
      el.querySelectorAll('.color-swatch').forEach(s => s.classList.remove('selected'));
      sw.classList.add('selected');
    };
    el.appendChild(sw);
  });
}

function initInstrGrid(containerId) {
  const el = document.getElementById(containerId);
  if (!el || el.children.length > 0) return;
  INSTRUMENTS.forEach((instr, i) => {
    const btn = document.createElement('button');
    btn.className = 'instr-btn' + (i === 5 ? ' selected' : ''); // default: Producer
    btn.textContent = instr;
    btn.onclick = () => {
      el.querySelectorAll('.instr-btn').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
    };
    el.appendChild(btn);
  });
}

function getSelectedColor(containerId) {
  return document.querySelector('#' + containerId + ' .color-swatch.selected')?.dataset.color || PEER_COLORS[0];
}

function getSelectedInstr(containerId) {
  return document.querySelector('#' + containerId + ' .instr-btn.selected')?.textContent || 'Producer';
}

// ── Toast / log ───────────────────────────────────────────
function toast(msg, type) {
  const el = document.getElementById('toastEl');
  if (!el) return;
  el.textContent = msg;
  el.className = 'toast-show' + (type === 'g' ? ' toast-g' : type === 'r' ? ' toast-r' : '');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.className = '', 3000);
}

function dlog(msg) {
  const el = document.getElementById('dawLog');
  if (!el) return;
  const d = document.createElement('div');
  d.className = 'dlog-entry';
  d.textContent = '> ' + msg;
  el.appendChild(d);
  el.scrollTop = el.scrollHeight;
  if (el.children.length > 20) el.children[0].remove();
}

// ── Session lifecycle ─────────────────────────────────────
async function hostStart() {
  const name = (document.getElementById('createName')?.value || '').trim() || 'Producer';
  S.name = name;
  S.color = getSelectedColor('createColors');
  S.instrument = getSelectedInstr('createInstrs');
  show('connecting');
  try {
    const r = await fetch(SERVER + '/api/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: S.name, color: S.color, instrument: S.instrument, daw: 'Ableton' })
    });
    const d = await r.json();
    if (!d.ok) { toast('Error: ' + d.error, 'r'); show('lobby'); return; }
    S.cid = d.clientId;
    S.code = d.code;
    S.peerNumber = d.peerNumber || 1;
    S.tracks = TDEFS.map(t => ({ ...t, v: 100, m: 0, s: 0, a: 0 }));
    enterSession();
  } catch(e) { toast('Connection error', 'r'); show('lobby'); }
}

async function remoteJoin() {
  const raw = (document.getElementById('joinCode')?.value || '').replace(/[^A-Z0-9]/gi, '').toUpperCase();
  if (raw.length < 5) { toast('Enter a session code', 'r'); return; }
  const name = (document.getElementById('joinNameInput')?.value || '').trim() || 'Musician';
  S.name = name;
  S.color = getSelectedColor('joinColors');
  S.instrument = getSelectedInstr('joinInstrs');
  show('connecting');
  try {
    const code = raw.slice(0, 3) + '-' + raw.slice(3);
    const r = await fetch(SERVER + '/api/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, name: S.name, color: S.color, instrument: S.instrument })
    });
    const d = await r.json();
    if (!d.ok) { toast(d.error || 'Session not found', 'r'); show('lobby'); return; }
    S.cid = d.clientId;
    S.code = d.code;
    S.peerNumber = d.peerNumber || 2;
    S.tracks = TDEFS.map(t => ({ ...t, v: 100, m: 0, s: 0, a: 0 }));
    enterSession();
  } catch(e) { toast('Connection error', 'r'); show('lobby'); }
}

function enterSession() {
  document.getElementById('codeDisplay').textContent = S.code;
  document.getElementById('spCode').textContent = S.code;
  renderTracks();
  updateBPM();
  updatePeerAvatars();
  renderPeerList();
  show('session');
  startPoll();
  // Ping loop
  setInterval(() => {
    if (S.cid) send({ type: 'ping:req', ts: Date.now() });
  }, 5000);
  // Position tick
  setInterval(() => {
    if (!S.playing) return;
    S.pos.tk++;
    if (S.pos.tk > 4) { S.pos.tk = 1; S.pos.bt++; }
    if (S.pos.bt > 4) { S.pos.bt = 1; S.pos.b++; }
    updatePos();
  }, 200);
}

function leaveSession() {
  S.poll = false;
  for (const [, p] of S.peers) p.conn?.close();
  S.peers.clear();
  S.cid = null; S.code = null;
  S.playing = false; S.rec = false;
  S.pos = { b: 1, bt: 1, tk: 1 };
  S.markers = [];
  show('landing');
}

// ── Polling ───────────────────────────────────────────────
async function startPoll() {
  S.poll = true;
  while (S.poll) {
    try {
      const r = await fetch(SERVER + '/api/poll?cid=' + S.cid, { signal: AbortSignal.timeout(30000) });
      if (!r.ok) { await new Promise(r => setTimeout(r, 2000)); continue; }
      const d = await r.json();
      for (const m of (d.messages || [])) handleMsg(m);
    } catch(e) {
      if (e.name !== 'TimeoutError') await new Promise(r => setTimeout(r, 2000));
    }
  }
}

async function send(msg) {
  if (!S.cid) return;
  await fetch(SERVER + '/api/send?cid=' + S.cid, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(msg)
  }).catch(() => {});
}

// ── WebRTC PeerMesh ───────────────────────────────────────
const PeerMesh = {
  async createOffer(peerId) {
    const pc = new RTCPeerConnection(ICE);
    const peerInfo = S.peers.get(peerId) || {};
    S.peers.set(peerId, { ...peerInfo, conn: pc });
    const dc = pc.createDataChannel('daw', { ordered: true });
    dc.onopen = () => { const p = S.peers.get(peerId); if (p) p.dc = dc; dlog('DC open → ' + peerId); };
    dc.onmessage = (e) => applyRemote(JSON.parse(e.data), peerId);
    pc.ondatachannel = () => {};
    pc.onicecandidate = (e) => { if (e.candidate) send({ type: 'webrtc:ice', peerId, candidate: e.candidate }); };
    pc.onconnectionstatechange = () => { updatePeerStatus(peerId, pc.connectionState); };
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    send({ type: 'webrtc:offer', peerId, offer });
  },
  async handleOffer(peerId, offer) {
    const pc = new RTCPeerConnection(ICE);
    const peerInfo = S.peers.get(peerId) || {};
    S.peers.set(peerId, { ...peerInfo, conn: pc });
    pc.ondatachannel = (e) => {
      const dc = e.channel;
      dc.onopen = () => { const p = S.peers.get(peerId); if (p) p.dc = dc; dlog('DC open ← ' + peerId); };
      dc.onmessage = (ev) => applyRemote(JSON.parse(ev.data), peerId);
    };
    pc.onicecandidate = (e) => { if (e.candidate) send({ type: 'webrtc:ice', peerId, candidate: e.candidate }); };
    pc.onconnectionstatechange = () => { updatePeerStatus(peerId, pc.connectionState); };
    await pc.setRemoteDescription(offer);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    send({ type: 'webrtc:answer', peerId, answer });
  },
  async handleAnswer(peerId, answer) {
    await S.peers.get(peerId)?.conn?.setRemoteDescription(answer).catch(() => {});
  },
  async handleIce(peerId, candidate) {
    await S.peers.get(peerId)?.conn?.addIceCandidate(candidate).catch(() => {});
  }
};

function broadcast(msg, skipPeer) {
  const data = JSON.stringify(msg);
  let sent = false;
  for (const [pid, p] of S.peers) {
    if (pid === skipPeer) continue;
    if (p.dc?.readyState === 'open') { p.dc.send(data); sent = true; }
  }
  if (!sent) send(msg);
}

function applyRemote(msg, fromPeerId) {
  if (msg.type === 'daw:state') applyDAW(msg, fromPeerId);
  if (msg.type === 'chat:msg') appendChat(msg.name || 'Peer', msg.text, msg.color);
}

// ── Message router ────────────────────────────────────────
function handleMsg(msg) {
  switch (msg.type) {
    case 'session:welcome':
      for (const p of (msg.peers || [])) {
        S.peers.set(p.id, { name: p.name, color: p.color, instrument: p.instrument, dc: null, conn: null, latency: 0 });
      }
      updatePeerAvatars(); renderPeerList();
      break;
    case 'peer:joined':
      S.peers.set(msg.peerId, { name: msg.name, color: msg.color, instrument: msg.instrument, dc: null, conn: null, latency: 0 });
      updatePeerAvatars(); renderPeerList();
      toast(msg.name + ' joined', 'g');
      break;
    case 'peer:left':
      S.peers.get(msg.peerId)?.conn?.close();
      S.peers.delete(msg.peerId);
      updatePeerAvatars(); renderPeerList();
      toast((msg.name || 'Peer') + ' left', '');
      break;
    case 'webrtc:create-offer':
      S.peers.set(msg.peerId, { name: msg.name || '', color: msg.color || PEER_COLORS[0], instrument: msg.instrument || '', dc: null, conn: null, latency: 0 });
      PeerMesh.createOffer(msg.peerId);
      break;
    case 'webrtc:offer':
      PeerMesh.handleOffer(msg.peerId, msg.offer);
      break;
    case 'webrtc:answer':
      PeerMesh.handleAnswer(msg.peerId, msg.answer);
      break;
    case 'webrtc:ice':
      PeerMesh.handleIce(msg.peerId, msg.candidate);
      break;
    case 'daw:state':
      applyDAW(msg, msg.from);
      break;
    case 'chat:msg':
      appendChat(msg.name || 'Peer', msg.text, msg.color);
      break;
    case 'ping:res': {
      const lat = Date.now() - msg.ts;
      const lp = document.getElementById('latPill');
      if (lp) lp.textContent = lat + 'ms';
      const sl = document.getElementById('spLatency');
      if (sl) sl.textContent = lat + 'ms';
      break;
    }
    case 'perms:update': {
      const pp = S.peers.get(msg.peerId);
      if (pp) { pp.perms = msg.perms; renderPeerList(); }
      break;
    }
    case 'remote:midi':
      // Browser can't inject MIDI itself — agent.js handles this
      // But we echo it so creator sees it in log
      dlog('🎹 MIDI ' + msg.action + ' note=' + (msg.note||'-') + ' from ' + (msg.fromName||'peer'));
      break;
  }
}

// ── DAW state ─────────────────────────────────────────────
function applyDAW(msg, fromPeer) {
  const a = msg.action;
  if (a === 'snapshot') {
    S.tracks = msg.tracks || S.tracks;
    S.bpm = msg.bpm || S.bpm;
    S.markers = msg.markers || S.markers;
    renderTracks(); renderMarkers(); updateBPM();
  } else if (a === 'play') {
    S.playing = msg.playing; S.rec = msg.rec || false;
    const pb = document.getElementById('playBtn');
    if (pb) pb.textContent = S.playing ? '⏸' : '▶';
  } else if (a === 'bpm') {
    S.bpm = msg.bpm; updateBPM();
  } else if (a === 'track_toggle') {
    const tr = S.tracks[msg.i]; if (!tr) return;
    tr[msg.k] = msg.v; renderTracks();
  } else if (a === 'track_vol') {
    const tr = S.tracks[msg.i]; if (!tr) return;
    tr.v = msg.v; renderTracks();
  } else if (a === 'pos') {
    S.pos = msg.pos; updatePos();
  } else if (a === 'marker_add') {
    S.markers.push(msg.marker); renderMarkers();
  } else if (a === 'track_add') {
    S.tracks.push(msg.track); renderTracks();
  }
}

function cmd(action, val) {
  let msg = { type: 'daw:state', action, from: S.cid, ts: Date.now() };
  if (action === 'play') {
    S.playing = !S.playing; msg.playing = S.playing;
    const pb = document.getElementById('playBtn');
    if (pb) pb.textContent = S.playing ? '⏸' : '▶';
  } else if (action === 'stop') {
    S.playing = false; S.pos = { b:1, bt:1, tk:1 };
    msg.playing = false; msg.pos = S.pos;
    const pb = document.getElementById('playBtn');
    if (pb) pb.textContent = '▶';
    updatePos();
  } else if (action === 'bpm') {
    S.bpm = Math.max(40, Math.min(300, S.bpm + (val || 0)));
    msg.bpm = S.bpm; msg.action = 'bpm';
    updateBPM();
  } else if (action === 'rec') {
    S.rec = !S.rec; msg.rec = S.rec;
    const rb = document.getElementById('recBtn');
    if (rb) rb.style.background = S.rec ? 'var(--red)' : '';
  }
  broadcast(msg);
}

// ── Track rendering ───────────────────────────────────────
function renderTracks() {
  const area = document.getElementById('trackArea');
  if (!area) return;
  area.innerHTML = '';
  S.tracks.forEach((tr, i) => {
    const div = document.createElement('div');
    div.className = 'track-row';
    const db = tr.v > 0 ? (20 * Math.log10(tr.v / 100)).toFixed(1) : '-\u221e';
    div.innerHTML = \`
      <div class="tr-num">\${i + 1}</div>
      <div class="tr-color" style="background:\${tr.c}"></div>
      <div class="tr-info">
        <div class="tr-name">\${tr.n}</div>
        <div class="tr-type">\${tr.t}</div>
      </div>
      <div class="tr-btns">
        <button class="trb \${tr.m ? 'active-mute' : ''}" onclick="trT(\${i},'m')" title="Mute">M</button>
        <button class="trb \${tr.s ? 'active-solo' : ''}" onclick="trT(\${i},'s')" title="Solo">S</button>
        <button class="trb \${tr.a ? 'active-rec' : ''}" onclick="trT(\${i},'a')" title="Record">R</button>
      </div>
      <div class="tr-fader">
        <input type="range" min="0" max="127" value="\${tr.v || 100}"
          onchange="trV(\${i},+this.value)"
          oninput="this.nextElementSibling.textContent=(+this.value>0?(20*Math.log10(+this.value/100)).toFixed(1)+'dB':'-\u221e')" />
        <span class="tr-db">\${db}dB</span>
      </div>
    \`;
    area.appendChild(div);
  });
}

function trT(i, k) {
  S.tracks[i][k] = S.tracks[i][k] ? 0 : 1;
  renderTracks();
  broadcast({ type: 'daw:state', action: 'track_toggle', i, k, v: S.tracks[i][k], from: S.cid, ts: Date.now() });
}

function trV(i, v) {
  S.tracks[i].v = v;
  broadcast({ type: 'daw:state', action: 'track_vol', i, v, from: S.cid, ts: Date.now() });
}

function addTrack() {
  const colors = ['#f04438','#f79009','#12b76a','#6c47ff','#0ea5e9','#8b5cf6'];
  const track = { n: 'Track ' + (S.tracks.length + 1), t: 'AUDIO', c: colors[S.tracks.length % colors.length], v: 100, m: 0, s: 0, a: 0 };
  S.tracks.push(track);
  renderTracks();
  broadcast({ type: 'daw:state', action: 'track_add', track, from: S.cid, ts: Date.now() });
}

// ── Markers ───────────────────────────────────────────────
function renderMarkers() {
  const el = document.getElementById('mRow');
  if (!el) return;
  el.innerHTML = '';
  S.markers.forEach((m, i) => {
    const d = document.createElement('div');
    d.style.cssText = \`position:absolute;left:\${m.pos || 0}%;top:0;bottom:0;width:2px;background:\${MCOLS[i % 5]};cursor:pointer;\`;
    d.title = m.label || '';
    el.appendChild(d);
  });
}

// ── Peers UI ──────────────────────────────────────────────
function updatePeerAvatars() {
  const el = document.getElementById('peerAvatars');
  if (!el) return;
  el.innerHTML = '';
  const self = document.createElement('div');
  self.className = 'peer-avatar self';
  self.style.background = S.color;
  self.textContent = (S.name || '?')[0].toUpperCase();
  self.title = S.name + ' (you)';
  el.appendChild(self);
  for (const [, p] of S.peers) {
    const av = document.createElement('div');
    av.className = 'peer-avatar';
    av.style.background = p.color || '#adb5bd';
    av.textContent = (p.name || '?')[0].toUpperCase();
    av.title = p.name;
    el.appendChild(av);
  }
  const count = S.peers.size;
  const ts = document.getElementById('tbStatus');
  if (ts) ts.textContent = count + ' peer' + (count !== 1 ? 's' : '');
  const sp = document.getElementById('spPeers');
  if (sp) sp.textContent = count;
}

function renderPeerList() {
  const el = document.getElementById('peerList');
  if (!el) return;
  el.innerHTML = '';
  el.appendChild(mkPeerCard(S.cid, S.name, S.color, S.instrument, '(you)', true));
  for (const [pid, p] of S.peers) {
    const st = p.connState || p.conn?.connectionState || 'connecting';
    el.appendChild(mkPeerCard(pid, p.name, p.color, p.instrument, st, false));
  }
}

function mkPeerCard(id, name, color, instrument, status, isSelf) {
  const d = document.createElement('div');
  d.className = 'peer-card';
  d.style.flexDirection = 'column';
  d.style.alignItems = 'stretch';
  const p = S.peers.get(id);
  const latency = p?.latency;
  const perms = p?.perms || { mouse: true, keyboard: true, midi: true };
  const isCreator = S.peerNumber === 1; // only creator can manage permissions

  const topRow = document.createElement('div');
  topRow.style.cssText = 'display:flex;align-items:center;gap:10px;';
  topRow.innerHTML = \`
    <div class="pc-avatar" style="background:\${color || '#adb5bd'}">\${(name || '?')[0].toUpperCase()}</div>
    <div class="pc-info" style="flex:1">
      <div class="pc-name">\${name || 'Peer'}\${isSelf ? ' <span class="you-badge">you</span>' : ''}</div>
      <div class="pc-meta">\${instrument || ''} &middot; <span class="pc-status">\${status || 'connecting'}</span></div>
    </div>
    \${latency != null ? \`<div class="pc-lat">\${latency}ms</div>\` : ''}
  \`;
  d.appendChild(topRow);

  // Permission badges (only show for remote peers, and only creator can toggle)
  if (!isSelf) {
    const permRow = document.createElement('div');
    permRow.className = 'perm-row';
    permRow.style.paddingLeft = '42px';

    const mkBadge = (key, label, cls) => {
      const b = document.createElement('span');
      b.className = 'perm-badge ' + (perms[key] ? cls : '');
      b.textContent = label;
      b.title = isCreator ? 'Click to toggle' : '';
      if (isCreator) {
        b.style.cursor = 'pointer';
        b.onclick = () => togglePerm(id, key, b, cls);
      }
      return b;
    };

    permRow.appendChild(mkBadge('mouse',    '🖱 Mouse',    'on'));
    permRow.appendChild(mkBadge('keyboard', '⌨ Keys',     'on'));
    permRow.appendChild(mkBadge('midi',     '🎹 MIDI',     'on-green'));
    d.appendChild(permRow);
  }
  return d;
}

function togglePerm(peerId, key, badge, cls) {
  const p = S.peers.get(peerId);
  if (!p) return;
  if (!p.perms) p.perms = { mouse:true, keyboard:true, midi:true };
  p.perms[key] = !p.perms[key];
  badge.classList.toggle(cls, p.perms[key]);
  // Broadcast permission update to all peers
  broadcast({ type:'perms:update', peerId, perms: p.perms, from: S.cid });
  toast((p.name || 'Peer') + ': ' + key + ' ' + (p.perms[key] ? 'on' : 'off'), p.perms[key] ? 'g' : '');
}

function updatePeerStatus(peerId, state) {
  const p = S.peers.get(peerId);
  if (p) p.connState = state;
  renderPeerList();
  const sc = document.getElementById('spConn');
  if (sc) sc.textContent = state;
}

// ── Chat ──────────────────────────────────────────────────
function switchTab(tab) {
  S.activeTab = tab;
  document.getElementById('peersTab').style.display = tab === 'peers' ? 'flex' : 'none';
  document.getElementById('chatTab').style.display = tab === 'chat' ? 'flex' : 'none';
  document.getElementById('tabPeers').classList.toggle('active', tab === 'peers');
  document.getElementById('tabChat').classList.toggle('active', tab === 'chat');
}

function sendChat() {
  const inp = document.getElementById('chatIn');
  const text = (inp?.value || '').trim();
  if (!text) return;
  inp.value = '';
  const msg = { type: 'chat:msg', text, name: S.name, color: S.color };
  appendChat(S.name, text, S.color);
  broadcast(msg);
}

function appendChat(name, text, color) {
  const area = document.getElementById('chatArea');
  if (!area) return;
  const d = document.createElement('div');
  d.className = 'chat-msg';
  d.innerHTML = \`<span class="chat-name" style="color:\${color || 'var(--accent)'}">\${name}</span><span class="chat-text">\${text}</span>\`;
  area.appendChild(d);
  area.scrollTop = area.scrollHeight;
}

// ── Misc helpers ──────────────────────────────────────────
function updateBPM() {
  const el = document.getElementById('bpmDisp');
  if (el) el.textContent = S.bpm;
}

function updatePos() {
  const el = document.getElementById('posDisp');
  if (el) el.textContent = S.pos.b + '.' + S.pos.bt + '.' + S.pos.tk;
}

function copyCode() {
  navigator.clipboard?.writeText(S.code || '').then(() => toast('Code copied!', 'g'));
}

function toggleSettings() {
  const ov = document.getElementById('settingsOverlay');
  if (ov) ov.style.display = ov.style.display === 'flex' ? 'none' : 'flex';
}

async function doShare() {
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    toast('Screen shared!', 'g');
    for (const [, p] of S.peers) {
      if (p.conn) stream.getTracks().forEach(t => p.conn.addTrack(t, stream));
    }
  } catch(e) { toast('Screen share cancelled', ''); }
}

// ══════════════════════════════════════════════════════════
// Virtual Piano + MIDI
// ══════════════════════════════════════════════════════════
const PIANO = {
  octave: 4,   // base octave
  active: new Set(),
  // computer keyboard → semitone offset from C (lower row = octave, upper row = octave+1)
  keyMap: {
    'z':0,'s':1,'x':2,'d':3,'c':4,'v':5,'g':6,'b':7,'h':8,'n':9,'j':10,'m':11,
    'q':12,'2':13,'w':14,'3':15,'e':16,'r':17,'5':18,'t':19,'6':20,'y':21,'7':22,'u':23,'i':24
  }
};

function togglePiano() {
  const w = document.getElementById('pianoWrap');
  const btn = document.getElementById('pianoBtn');
  if (!w) return;
  const open = w.classList.toggle('open');
  if (btn) btn.style.background = open ? 'var(--accentD)' : '';
  if (open && !w.dataset.built) { buildPianoKeys(); w.dataset.built = '1'; }
}

function pianoOctave(dir) {
  PIANO.octave = Math.max(0, Math.min(8, PIANO.octave + dir));
  document.getElementById('pianoOctLbl').textContent = 'C' + PIANO.octave;
  buildPianoKeys();
}

function buildPianoKeys() {
  const el = document.getElementById('pianoKeys');
  if (!el) return;
  el.innerHTML = '';
  // 2 octaves starting from PIANO.octave
  const layout = [0,null,1,null,2,3,null,4,null,5,null,6]; // null = black key gap
  const noteNames = ['C','','D','','E','F','','G','','A','','B'];
  for (let oct = 0; oct < 2; oct++) {
    const whites = [0,2,4,5,7,9,11];
    const blacks = [1,3,-1,6,8,10,-1]; // -1 = no black key after E and B
    const baseNote = (PIANO.octave + oct) * 12;

    // Build white keys
    const octEl = document.createElement('div');
    octEl.style.cssText = 'display:flex;position:relative;';
    whites.forEach(semi => {
      const note = baseNote + semi;
      const key = document.createElement('div');
      key.className = 'pk-w';
      key.dataset.note = note;
      const label = semi === 0 ? \`<span class="pk-label">C\${PIANO.octave+oct}</span>\` : '';
      key.innerHTML = label;
      key.onmousedown = () => pianoNoteOn(note, key);
      key.onmouseup = key.onmouseleave = () => pianoNoteOff(note, key);
      octEl.appendChild(key);
    });

    // Overlay black keys
    const blackOffsets = [0.6, 1.6, -1, 3.6, 4.6, 5.6, -1]; // fractional white key units
    const blackSemis   = [1,   3,   -1, 6,   8,   10,  -1];
    blackSemis.forEach((semi, i) => {
      if (semi === -1) return;
      const note = baseNote + semi;
      const bk = document.createElement('div');
      bk.className = 'pk-b';
      bk.dataset.note = note;
      bk.style.position = 'absolute';
      bk.style.left = (blackOffsets[i] * 32 + 11) + 'px'; // 32px per white key
      bk.onmousedown = (e) => { e.stopPropagation(); pianoNoteOn(note, bk); };
      bk.onmouseup = bk.onmouseleave = () => pianoNoteOff(note, bk);
      octEl.appendChild(bk);
    });
    el.appendChild(octEl);
  }

  // Velocity slider label sync
  const vel = document.getElementById('pianoVel');
  const velVal = document.getElementById('pianoVelVal');
  if (vel && velVal) vel.oninput = () => velVal.textContent = vel.value;
}

function pianoNoteOn(note, el) {
  if (PIANO.active.has(note)) return;
  PIANO.active.add(note);
  el?.classList.add('on');
  const vel = Number(document.getElementById('pianoVel')?.value || 100);
  const ch  = Number(document.getElementById('pianoChSel')?.value || 1) - 1;
  const msg = { type:'remote:midi', action:'noteon', note, velocity:vel, channel:ch,
    from:S.cid, fromName:S.name };
  broadcast(msg);
}

function pianoNoteOff(note, el) {
  if (!PIANO.active.has(note)) return;
  PIANO.active.delete(note);
  el?.classList.remove('on');
  const ch = Number(document.getElementById('pianoChSel')?.value || 1) - 1;
  broadcast({ type:'remote:midi', action:'noteoff', note, velocity:0, channel:ch,
    from:S.cid, fromName:S.name });
}

// Computer keyboard → piano
document.addEventListener('keydown', e => {
  const tag = document.activeElement?.tagName;
  const pianoOpen = document.getElementById('pianoWrap')?.classList.contains('open');
  if (pianoOpen && !e.metaKey && !e.ctrlKey) {
    const semi = PIANO.keyMap[e.key?.toLowerCase()];
    if (semi !== undefined && !e.repeat) {
      const note = PIANO.octave * 12 + semi;
      const keyEl = document.querySelector(\`[data-note="\${note}"]\`);
      pianoNoteOn(note, keyEl);
      return;
    }
  }
  if (tag === 'INPUT' || tag === 'TEXTAREA') return;
  if (e.code === 'Space' && S.code) { e.preventDefault(); cmd('play'); }
});

document.addEventListener('keyup', e => {
  const pianoOpen = document.getElementById('pianoWrap')?.classList.contains('open');
  if (pianoOpen) {
    const semi = PIANO.keyMap[e.key?.toLowerCase()];
    if (semi !== undefined) {
      const note = PIANO.octave * 12 + semi;
      const keyEl = document.querySelector(\`[data-note="\${note}"]\`);
      pianoNoteOff(note, keyEl);
    }
  }
});

// ── Keyboard shortcuts ────────────────────────────────────
document.addEventListener('keydown', e => {
  const tag = document.activeElement?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') return;
  if (e.code === 'Space' && S.code) { e.preventDefault(); cmd('play'); }
  if (e.code === 'ArrowUp') { e.preventDefault(); cmd('bpm', 1); }
  if (e.code === 'ArrowDown') { e.preventDefault(); cmd('bpm', -1); }
});

// ── Boot ──────────────────────────────────────────────────
window.onload = () => { show('landing'); };
</script>
</body>
</html>`;
