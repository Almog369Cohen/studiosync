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
const trialSessions   = new Map(); // fingerprint → { count, date }

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

function checkTrial(fp) {
  const today = new Date().toISOString().slice(0, 10);
  const rec = trialSessions.get(fp);
  if (!rec || rec.date !== today) return true;
  return rec.count < 3;
}

function useTrial(fp) {
  const today = new Date().toISOString().slice(0, 10);
  const rec = trialSessions.get(fp);
  if (!rec || rec.date !== today) { trialSessions.set(fp, { count: 1, date: today }); return; }
  rec.count++;
}

// ── Sessions ──────────────────────────────────────────────
const sessions = new Map(); // code → { peers: Set<clientId>, daw, created, password }
const queues   = new Map(); // clientId → [messages]
const clients  = new Map(); // clientId → { code, name, color, instrument, res, seen }
const onlineUsers = new Map(); // name → { name, color, instrument, ts }
const featureVotes = new Map(); // featureId → Set<fingerprint>
const VOTABLE_FEATURES = [
  { id: 'remote-audio', name: 'חיבור כלי נגינה מרחוק' },
  { id: 'ai-summary', name: 'סיכום סשן עם AI' },
  { id: 'mobile-daw', name: 'שליטה ב-DAW מהנייד' },
  { id: 'multi-track', name: 'הקלטה מרובת ערוצים' },
  { id: 'cloud-storage', name: 'אחסון הקלטות בענן' },
  { id: 'video-chat', name: 'וידאו צ׳אט מובנה' },
];

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
    const fp = (data.fingerprint && data.fingerprint.length > 4) ? data.fingerprint : ip;
    const licensed = checkLicense(data.license);

    if (!licensed) {
      if (!checkTrial(fp)) {
        return json(res, { ok: false, error: 'trial_limit', message: 'You have reached 3 free sessions today. Upgrade to Pro to continue.' }, 402);
      }
      useTrial(fp);
    }

    const id   = 'p_' + Date.now() + crypto.randomBytes(3).toString('hex');
    const code = genCode();
    const name = data.name || 'Producer';
    const color = data.color || '#6c47ff';
    const instrument = data.instrument || 'Producer';
    clients.set(id, { code, name, color, instrument, res: null, seen: Date.now() });
    queues.set(id, []);
    sessions.set(code, { peers: new Set([id]), daw: data.daw, created: Date.now(), licensed, password: data.password || null });
    console.log('[+] Session created:', code, licensed ? '(PRO)' : '(trial)', data.password ? '(password)' : '');
    return json(res, { ok: true, code, clientId: id, peerNumber: 1, plan: licensed ? 'pro' : 'trial' });
  }

  // ── Join session ──
  if (path === '/api/join' && req.method === 'POST') {
    const data = await body(req);
    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || 'unknown';
    const fp = (data.fingerprint && data.fingerprint.length > 4) ? data.fingerprint : ip;
    const raw  = (data.code || '').replace(/[^A-Z0-9]/gi, '').toUpperCase();
    const code = raw.slice(0, 3) + '-' + raw.slice(3);
    const sess = sessions.get(code);
    if (!sess) return json(res, { ok: false, error: 'Session not found — check the code and try again' }, 404);
    // Password check
    if (sess.password && data.password !== sess.password) return json(res, { ok: false, error: 'password_required' }, 403);
    const isProSession = sess.licensed || checkLicense(data.license);
    const maxPeers = isProSession ? 10 : 3;
    if (sess.peers.size >= maxPeers) return json(res, { ok: false, error: isProSession ? 'הסשן מלא (עד 10 משתתפים)' : 'הסשן החינמי מלא (עד 3). שדרג ל-Pro עבור 10 משתתפים.' }, 403);

    const licensed = checkLicense(data.license);
    if (!licensed && !sess.licensed) {
      if (!checkTrial(fp)) {
        return json(res, { ok: false, error: 'trial_limit', message: 'You have reached 3 free sessions today. Upgrade to Pro to continue.' }, 402);
      }
      useTrial(fp);
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
      push(pid, { type: 'peer:joined', peerId: id, name, color, instrument, role: data.role || 'participant' });
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

  // ── Heartbeat (online indicator) ──
  if (path === '/api/heartbeat' && req.method === 'POST') {
    const data = await body(req);
    if (data.name) onlineUsers.set(data.name, { name: data.name, color: data.color || '#6c47ff', instrument: data.instrument || '', ts: Date.now() });
    return json(res, { ok: true });
  }
  if (path === '/api/online' && req.method === 'GET') {
    const now = Date.now();
    const users = [];
    for (const [k, u] of onlineUsers) {
      if (now - u.ts > 60000) onlineUsers.delete(k);
      else users.push({ name: u.name, color: u.color, instrument: u.instrument });
    }
    return json(res, { ok: true, users });
  }

  // ── Feature voting ──
  if (path === '/api/features' && req.method === 'GET') {
    const list = VOTABLE_FEATURES.map(f => ({ id: f.id, name: f.name, votes: featureVotes.get(f.id)?.size || 0 }));
    return json(res, { ok: true, features: list });
  }
  if (path === '/api/features/vote' && req.method === 'POST') {
    const data = await body(req);
    const fp = data.fingerprint || 'anon';
    if (!featureVotes.has(data.featureId)) featureVotes.set(data.featureId, new Set());
    featureVotes.get(data.featureId).add(fp);
    return json(res, { ok: true, votes: featureVotes.get(data.featureId).size });
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

/* ── Online Indicator ───────────────────────────────── */
.online-section { max-width:600px; margin:0 auto 24px; padding:0 24px; }
.online-header { font-size:14px; font-weight:600; color:var(--hi); margin-bottom:10px; }
.online-list { display:flex; gap:8px; flex-wrap:wrap; }
.online-avatar { display:flex; align-items:center; gap:6px; background:var(--s1); border:1px solid var(--b1); border-radius:20px; padding:4px 12px 4px 6px; font-size:12px; color:var(--mid); }
.online-dot { width:8px; height:8px; border-radius:50%; flex-shrink:0; }
.online-name { font-weight:500; color:var(--hi); }
.online-instr { font-size:11px; color:var(--dim); }

/* ── Schedule Section ───────────────────────────────── */
.schedule-section { max-width:600px; margin:0 auto 24px; padding:0 24px; }
.schedule-header { font-size:14px; font-weight:600; color:var(--hi); margin-bottom:10px; }
.schedule-list { display:flex; gap:8px; flex-wrap:wrap; }
.sched-card { background:var(--s1); border:1px solid var(--b1); border-radius:var(--radius); padding:10px 14px; font-size:12px; color:var(--mid); min-width:140px; position:relative; }
.sched-card .sched-title { font-weight:600; color:var(--hi); margin-bottom:4px; }
.sched-card .sched-time { font-size:11px; color:var(--dim); }
.sched-card .sched-del { position:absolute; top:4px; left:4px; cursor:pointer; font-size:14px; color:var(--dim); opacity:.5; }
.sched-card .sched-del:hover { opacity:1; color:#e74c3c; }

/* ── Feature Voting ─────────────────────────────────── */
.voting-section { max-width:600px; margin:0 auto 32px; padding:0 24px; }
.voting-header { font-size:14px; font-weight:600; color:var(--hi); margin-bottom:10px; }
.voting-list { display:flex; flex-direction:column; gap:6px; }
.vote-row { display:flex; align-items:center; gap:10px; background:var(--s1); border:1px solid var(--b1); border-radius:var(--radius); padding:8px 14px; font-size:13px; color:var(--mid); direction:rtl; }
.vote-name { flex:1; color:var(--hi); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; text-align:right; }
.vote-count { font-weight:600; color:var(--accent); min-width:24px; text-align:center; flex-shrink:0; }
.vote-btn { background:var(--accent); color:#fff; border:none; border-radius:12px; padding:4px 12px; font-size:11px; cursor:pointer; font-family:var(--sans); flex-shrink:0; }
.vote-btn:hover { opacity:.85; }
.vote-btn.voted { background:var(--b2); color:var(--dim); cursor:default; }

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
.tb-invite-btn { color:var(--accent); border-color:var(--accentD); font-weight:600; }
.tb-invite-btn:hover { background:var(--accentD); }

/* ── Invite modal ──────────────────────────────────────── */
.modal-overlay { position:fixed; inset:0; background:rgba(0,0,0,.45); z-index:500; display:flex; align-items:center; justify-content:center; }
.modal-box { background:#fff; border-radius:var(--radiusL); padding:28px 24px; width:min(420px,92vw); max-height:90vh; overflow-y:auto; box-shadow:0 8px 32px rgba(0,0,0,.18); display:flex; flex-direction:column; gap:14px; }
.modal-title { font-size:18px; font-weight:700; color:var(--hi); }
.invite-label { font-size:11px; font-weight:600; text-transform:uppercase; letter-spacing:.06em; color:var(--mid); }
.invite-code-big { font-family:var(--mono); font-size:28px; font-weight:700; color:var(--accent); letter-spacing:.1em; background:var(--accentD); border-radius:8px; padding:10px 16px; text-align:center; }
.invite-link-row { display:flex; gap:8px; }
.invite-link-input { flex:1; border:1px solid var(--b1); border-radius:6px; padding:8px 10px; font-size:12px; color:var(--mid); font-family:var(--mono); background:var(--s1); outline:none; direction:ltr; }
.invite-share-btns { display:flex; gap:8px; }
.invite-action-btn { flex:1; padding:10px; border-radius:8px; border:none; font-size:14px; font-weight:600; cursor:pointer; }
.whatsapp-btn { background:#25d366; color:#fff; }
.whatsapp-btn:hover { background:#1fbc58; }
.email-btn { background:var(--s2); color:var(--txt); border:1px solid var(--b1); }
.email-btn:hover { background:var(--b1); }

/* ── Quick join (landing) ──────────────────────────── */
.quick-join { display:flex; gap:8px; margin-top:12px; width:100%; max-width:320px; }
.quick-join input { flex:1; border:1px solid var(--b1); border-radius:8px; padding:10px 14px; font-family:var(--mono); font-size:15px; text-align:center; letter-spacing:.12em; text-transform:uppercase; color:var(--hi); outline:none; direction:ltr; }
.quick-join input:focus { border-color:var(--accent); }
.quick-join input::placeholder { color:var(--dim); letter-spacing:0; text-transform:none; font-family:var(--sans); font-size:13px; }
.quick-join button { padding:10px 16px; border-radius:8px; background:var(--accent); color:#fff; border:none; font-weight:600; cursor:pointer; white-space:nowrap; }
.quick-join-divider { color:var(--dim); font-size:12px; margin-top:16px; }

/* ── Session timer ─────────────────────────────────── */
.session-timer { display:flex; align-items:center; gap:4px; font-family:var(--mono); font-size:12px; color:var(--mid); background:var(--s1); border:1px solid var(--b1); border-radius:100px; padding:3px 10px; }
.session-timer.warn { color:var(--amber); border-color:var(--amber); }
.session-timer.crit { color:var(--red); border-color:var(--red); animation:pulse .8s infinite; }
@keyframes pulse { 50% { opacity:.6; } }

/* ── Premium / Upgrade modal ──────────────────────── */
.upgrade-modal-box { background:#fff; border-radius:var(--radiusL); padding:32px 28px; width:min(440px,92vw); max-height:90vh; overflow-y:auto; box-shadow:0 8px 32px rgba(0,0,0,.18); display:flex; flex-direction:column; gap:16px; text-align:center; }
.upgrade-title { font-size:22px; font-weight:700; color:var(--hi); }
.upgrade-subtitle { font-size:14px; color:var(--mid); }
.upgrade-features { display:flex; flex-direction:column; gap:10px; text-align:right; direction:rtl; }
.upgrade-feat { display:flex; align-items:center; gap:8px; font-size:14px; color:var(--txt); }
.upgrade-feat .check { color:var(--accent); font-size:16px; }
.upgrade-feat.locked .check { color:var(--dim); }
.upgrade-cta { padding:14px; border-radius:10px; background:var(--accent); color:#fff; border:none; font-size:16px; font-weight:700; cursor:pointer; margin-top:8px; }
.upgrade-cta:hover { background:#5a38e0; }
.pro-badge { background:linear-gradient(135deg,#6c47ff,#a855f7); color:#fff; font-size:9px; font-weight:700; padding:2px 6px; border-radius:4px; letter-spacing:.05em; margin-left:6px; vertical-align:middle; }
.rec-btn-transport { position:relative; }
.rec-btn-transport .lock-icon { position:absolute; top:-4px; right:-4px; font-size:10px; }

/* ── History panel ─────────────────────────────────── */
.history-panel { position:fixed; top:0; right:-400px; width:min(380px,90vw); height:100vh; background:#fff; box-shadow:-4px 0 24px rgba(0,0,0,.12); z-index:400; transition:right .3s ease; display:flex; flex-direction:column; }
.history-panel.open { right:0; }
.hp-header { display:flex; align-items:center; justify-content:space-between; padding:16px 20px; border-bottom:1px solid var(--b1); }
.hp-title { font-size:16px; font-weight:700; }
.hp-list { flex:1; overflow-y:auto; padding:12px; display:flex; flex-direction:column; gap:8px; }
.hp-card { background:var(--s1); border:1px solid var(--b1); border-radius:8px; padding:12px; direction:rtl; }
.hp-card-blur { filter:blur(3px); pointer-events:none; }
.hp-date { font-size:11px; color:var(--mid); }
.hp-code { font-family:var(--mono); font-weight:600; color:var(--accent); }
.hp-info { font-size:12px; color:var(--txt); margin-top:4px; }

/* ── Workspace ───────────────────────────────────────── */
.workspace { flex:1; display:flex; overflow:hidden; }
.main-area { flex:1; display:flex; flex-direction:column; align-items:center; justify-content:center; padding:16px; padding-bottom:72px; overflow:hidden; background:var(--s1); position:relative; }
.main-area-empty { display:flex; flex-direction:column; align-items:center; gap:12px; color:var(--mid); text-align:center; }
.main-area-empty-icon { font-size:48px; opacity:.5; }
.main-area-empty-text { font-size:15px; font-weight:500; }
.main-area-empty-sub { font-size:12px; color:var(--dim); max-width:280px; line-height:1.5; }
.main-video { width:100%; height:100%; object-fit:contain; border-radius:var(--radiusL); background:#000; display:none; }
.main-video.active { display:block; }
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

/* (tracks removed — not connected to real DAW) */

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

/* ── My Controls (self-send toggles in transport bar) ─── */
.my-controls { display:flex; align-items:center; gap:5px; }
.my-ctrl-btn { display:flex; align-items:center; gap:3px; padding:4px 9px; border-radius:100px; border:1.5px solid var(--b1); background:var(--s1); color:var(--dim); font-size:12px; font-weight:500; cursor:pointer; user-select:none; transition:all .15s; font-family:var(--sans); }
.my-ctrl-btn:hover { border-color:var(--accent); color:var(--accent); }
.my-ctrl-btn.active { background:var(--accentD); border-color:var(--accent); color:var(--accent); font-weight:600; }
.my-ctrl-btn.active-g { background:var(--gD); border-color:var(--green); color:var(--green); font-weight:600; }
.my-ctrl-sep { width:1px; height:20px; background:var(--b1); margin:0 2px; }

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
.cam-btn { padding:0 14px; font-size:13px; font-family:var(--sans); white-space:nowrap; display:none; }
@media (max-width: 768px) { .cam-btn { display:flex; } }
.tap-tempo { font-size:10px; font-weight:700; }
.tap-tempo:active { background:var(--accentD); color:var(--accent); }
.metro-btn.on { background:var(--green); border-color:var(--green); color:#fff; }
.vu-wrap { display:flex; align-items:center; gap:4px; background:var(--s1); border:1px solid var(--b1); border-radius:6px; padding:0 6px; height:34px; }
.vu-label { font-size:9px; color:var(--dim); }
.vu-meter { display:flex; align-items:flex-end; gap:1px; height:24px; }
.vu-bar { width:3px; border-radius:1px; background:var(--green); transition:height 60ms linear; min-height:2px; }
.vu-bar.warn { background:#f79009; }
.vu-bar.clip { background:var(--red); }
.uptime-pill { font-size:10px; color:var(--dim); font-family:var(--mono); }
.clip-panel { position:fixed; bottom:60px; right:16px; width:280px; max-height:240px; overflow-y:auto; background:var(--s1); border:1px solid var(--b1); border-radius:var(--radiusL); padding:8px; display:none; z-index:51; }
.clip-card { display:flex; align-items:center; gap:8px; padding:6px 8px; background:var(--bg); border:1px solid var(--b1); border-radius:6px; margin-bottom:4px; }
.clip-name { flex:1; font-size:12px; font-family:var(--mono); color:var(--txt); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.clip-dl { font-size:12px; color:var(--accent); cursor:pointer; text-decoration:none; }
.share-audio-btn { padding:0 10px; font-size:12px; font-family:var(--sans); white-space:nowrap; }

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
.rvb-mute:hover { background:rgba(255,255,255,.15); }
.rvb-close { background:none; border:none; color:rgba(255,255,255,.7); cursor:pointer; font-size:18px; padding:0 2px; line-height:1; }
.rvb-close:hover { color:#fff; }

/* ── Help overlay ────────────────────────────────────── */
#helpOverlay { position:fixed; inset:0; background:rgba(0,0,0,.4); z-index:300; display:flex; align-items:center; justify-content:center; }
#helpPanel { width:min(420px,90vw); max-height:80vh; background:var(--bg); border-radius:var(--radiusL); box-shadow:var(--shadowM); overflow-y:auto; }

/* ── Connection banner ──────────────────────────────── */
#connBanner { position:fixed; top:0; left:0; right:0; z-index:500; display:none; padding:10px 16px; text-align:center; font-size:13px; font-weight:600; font-family:var(--sans); }
#connBanner.warn { display:block; background:var(--aD); color:#b25e00; border-bottom:1px solid var(--amber); }
#connBanner.err { display:block; background:var(--rD); color:var(--red); border-bottom:1px solid var(--red); }
#connBanner.ok { display:block; background:var(--gD); color:#0a7c42; border-bottom:1px solid var(--green); animation:fadeOut 2s 1s forwards; }
@keyframes fadeOut { to { opacity:0; display:none; } }

/* ── Dark mode ──────────────────────────────────────── */
[data-theme="dark"] {
  --bg:#1a1a2e; --s1:#16213e; --s2:#1f2b47; --s3:#283a5e;
  --b1:#2a3a5e; --b2:#3a4f7a;
  --txt:#e0e0e0; --hi:#f5f5f5; --mid:#9ca3af; --dim:#6b7280;
  --shadow:0 1px 3px rgba(0,0,0,.3); --shadowM:0 4px 16px rgba(0,0,0,.4);
}
[data-theme="dark"] .modal-box,
[data-theme="dark"] .upgrade-modal-box { background:#1e293b; color:#e0e0e0; }
[data-theme="dark"] .history-panel { background:#1e293b; }
[data-theme="dark"] .pk-w { background:#c8ccd0; border-color:#666; }
[data-theme="dark"] .pk-w.on { background:var(--accent); }
[data-theme="dark"] .lobby-card { background:#1e293b; }
[data-theme="dark"] .feat-card { background:#1e293b; }
[data-theme="dark"] .lob-input { background:#16213e; color:#e0e0e0; border-color:#2a3a5e; }
[data-theme="dark"] .code-input { background:#16213e; color:#e0e0e0; border-color:#2a3a5e; }
[data-theme="dark"] .instr-btn { background:#16213e; color:#9ca3af; border-color:#2a3a5e; }
[data-theme="dark"] .instr-btn.sel { background:var(--accentD); }
[data-theme="dark"] #settingsPanel { background:#1e293b; }
[data-theme="dark"] #helpPanel { background:#1e293b; }
[data-theme="dark"] .quick-join input { background:#16213e; color:#e0e0e0; border-color:#2a3a5e; }

/* ── Animations ─────────────────────────────────────── */
.peer-card { animation:slideIn .3s ease-out; }
@keyframes slideIn { from { opacity:0; transform:translateX(-20px); } to { opacity:1; transform:translateX(0); } }
.peer-card.leaving { animation:slideOut .3s ease-in forwards; }
@keyframes slideOut { to { opacity:0; transform:translateX(20px); } }
.modal-overlay { animation:fadeInModal .2s ease; }
@keyframes fadeInModal { from { opacity:0; } }
.modal-box, .upgrade-modal-box { animation:scaleIn .2s ease; }
@keyframes scaleIn { from { transform:scale(.95); opacity:0; } }
@keyframes nudgeShake { 0%,100%{transform:translateX(0)} 25%{transform:translateX(-6px)} 75%{transform:translateX(6px)} }
.nudged { animation:nudgeShake .4s ease 3; }

/* ── Countdown overlay ──────────────────────────────── */
.countdown-overlay { position:fixed; inset:0; z-index:600; background:rgba(0,0,0,.75); display:flex; align-items:center; justify-content:center; }
.countdown-num { font-size:120px; font-weight:900; color:#fff; font-family:var(--mono); animation:countPop .8s ease; }
@keyframes countPop { 0%{transform:scale(2);opacity:0} 50%{transform:scale(1);opacity:1} 100%{opacity:.3} }

/* ── Rating modal ───────────────────────────────────── */
.rating-stars { display:flex; gap:8px; justify-content:center; margin:16px 0; }
.rating-star { font-size:36px; cursor:pointer; transition:transform .1s; opacity:.3; }
.rating-star:hover, .rating-star.lit { opacity:1; transform:scale(1.15); }

/* ── Onboarding wizard ──────────────────────────────── */
.wizard-overlay { position:fixed; inset:0; background:rgba(0,0,0,.5); z-index:700; display:flex; align-items:center; justify-content:center; }
.wizard-box { background:var(--bg); border-radius:var(--radiusL); padding:32px 28px; width:min(440px,92vw); box-shadow:var(--shadowM); text-align:center; direction:rtl; }
.wizard-step { display:none; }
.wizard-step.active { display:block; }
.wizard-dots { display:flex; gap:8px; justify-content:center; margin:20px 0 0; }
.wizard-dot { width:8px; height:8px; border-radius:50%; background:var(--b1); }
.wizard-dot.active { background:var(--accent); }
.wizard-icon { font-size:48px; margin-bottom:16px; }
.wizard-title { font-size:20px; font-weight:700; color:var(--hi); margin-bottom:8px; }
.wizard-desc { font-size:14px; color:var(--mid); line-height:1.6; margin-bottom:20px; }

/* ── DND indicator ──────────────────────────────────── */
.dnd-active { position:relative; }
.dnd-active::after { content:''; position:absolute; top:2px; right:2px; width:6px; height:6px; background:var(--red); border-radius:50%; }

/* ── Search in history ──────────────────────────────── */
.hp-search { border:1px solid var(--b1); border-radius:var(--radius); padding:8px 12px; font-size:13px; font-family:var(--sans); width:calc(100% - 24px); margin:8px 12px; background:var(--s1); color:var(--txt); direction:rtl; }
[data-theme="dark"] .hp-search { background:#16213e; color:#e0e0e0; border-color:#2a3a5e; }

/* ── Tags ───────────────────────────────────────────── */
.hp-tags { display:flex; gap:4px; flex-wrap:wrap; margin-top:6px; }
.hp-tag { padding:2px 8px; border-radius:10px; font-size:10px; background:var(--accentD); color:var(--accent); font-weight:600; }
.tag-input-row { display:flex; gap:4px; margin-top:6px; }
.tag-input-row input { flex:1; border:1px solid var(--b1); border-radius:6px; padding:4px 8px; font-size:11px; font-family:var(--sans); background:var(--s1); color:var(--txt); }
.tag-input-row button { border:none; background:var(--accent); color:#fff; border-radius:6px; padding:4px 10px; font-size:11px; cursor:pointer; }

/* ── Share recording modal ──────────────────────────── */
.share-rec-btns { display:flex; gap:8px; flex-wrap:wrap; justify-content:center; margin-top:12px; }
.share-rec-btns button { padding:10px 18px; border-radius:var(--radius); border:1.5px solid var(--b1); background:var(--s1); cursor:pointer; font-size:13px; font-family:var(--sans); color:var(--txt); }
.share-rec-btns button:hover { border-color:var(--accent); color:var(--accent); }

/* ── Notes tab ──────────────────────────────────────── */
#notesTab { display:none; padding:8px; height:100%; }
#notesTab textarea { width:100%; height:calc(100% - 8px); resize:none; border:1px solid var(--b1); border-radius:var(--radius); padding:10px; font-size:13px; font-family:var(--sans); background:var(--s1); color:var(--txt); direction:rtl; }
[data-theme="dark"] #notesTab textarea { background:#16213e; color:#e0e0e0; border-color:#2a3a5e; }

/* ── Listener badge ─────────────────────────────────── */
.listener-badge { background:var(--s2); color:var(--mid); padding:2px 8px; border-radius:10px; font-size:10px; font-weight:600; }

/* ── Mute indicator ─────────────────────────────────── */
.muted-badge { background:var(--rD); color:var(--red); padding:2px 8px; border-radius:10px; font-size:10px; font-weight:600; }
.mute-btn { background:none; border:1px solid var(--b1); border-radius:6px; cursor:pointer; font-size:12px; padding:2px 6px; color:var(--mid); }
.mute-btn:hover { border-color:var(--red); color:var(--red); }

/* ── Stage mode ─────────────────────────────────────── */
.stage-badge { background:var(--gD); color:var(--green); padding:2px 8px; border-radius:10px; font-size:10px; font-weight:600; }
.stage-bar { background:var(--accentD); color:var(--accent); padding:6px 12px; text-align:center; font-size:12px; font-weight:600; border-bottom:1px solid var(--b1); }

/* ── Online indicator ───────────────────────────────── */
.online-bar { display:flex; align-items:center; gap:8px; padding:8px 0; flex-wrap:wrap; }
.online-avatar { width:28px; height:28px; border-radius:50%; display:flex; align-items:center; justify-content:center; color:#fff; font-size:11px; font-weight:700; position:relative; }
.online-dot { position:absolute; bottom:-1px; right:-1px; width:8px; height:8px; background:var(--green); border-radius:50%; border:2px solid var(--bg); }

/* ── Schedule ───────────────────────────────────────── */
.schedule-card { background:var(--accentD); border:1px solid var(--accent); border-radius:var(--radius); padding:12px 16px; margin-top:12px; direction:rtl; text-align:right; }
.schedule-card .sch-title { font-weight:600; font-size:14px; color:var(--accent); }
.schedule-card .sch-time { font-size:12px; color:var(--mid); margin-top:4px; }

/* ── Feature voting ─────────────────────────────────── */
.vote-grid { display:flex; gap:12px; flex-wrap:wrap; justify-content:center; padding:0 24px 40px; }
.vote-card { background:var(--s1); border:1px solid var(--b1); border-radius:var(--radius); padding:14px; width:180px; text-align:center; }
.vote-card .vote-name { font-weight:600; font-size:13px; margin-bottom:8px; color:var(--hi); }
.vote-btn { border:1.5px solid var(--b1); background:none; border-radius:6px; padding:4px 14px; cursor:pointer; font-size:13px; color:var(--mid); font-family:var(--sans); }
.vote-btn:hover { border-color:var(--accent); color:var(--accent); }
.vote-btn.voted { background:var(--accentD); border-color:var(--accent); color:var(--accent); }

/* ── Mobile responsive ──────────────────────────────── */
@media (max-width: 768px) {
  .land-nav { padding:12px 16px; }
  .hero h1 { font-size:clamp(24px,7vw,36px); }
  .hero-sub { font-size:14px; }
  .features { flex-direction:column; align-items:center; }
  .feat-card { max-width:100%; }

  .topbar { height:44px; gap:6px; padding:0 8px; overflow-x:auto; }
  .tb-brand { font-size:13px; }
  .tb-sep { display:none; }
  .tb-status { display:none; }
  .tb-btn { padding:4px 8px; font-size:12px; }

  .workspace { flex-direction:column; }
  .participant-panel { width:100%; height:auto; max-height:180px; border-left:none; border-top:1px solid var(--b1); }

  .transport-bar { height:auto; min-height:52px; flex-wrap:wrap; gap:4px; padding:6px 8px; position:relative; }
  .bpm-ctrl { order:10; }
  .pos-display { order:11; }
  .my-controls { order:20; width:100%; justify-content:center; padding-top:4px; }
  .my-ctrl-sep { display:none; }
  .latency-pill { order:12; }

  #pianoWrap { bottom:104px; }
  .piano-keys { padding:4px 8px 0; }
  .pk-w { width:26px; height:60px; }
  .pk-b { width:18px; height:38px; margin:0 -9px; }

  /* Mobile: hide controls not usable on phone */
  .share-btn { display:none; }
  #pianoBtn { display:none; }
  .vu-wrap { display:none; }
  .share-audio-btn { display:none; }
  .uptime-pill { display:none; }
  .clip-panel { width:100%; right:0; left:0; bottom:52px; border-radius:12px 12px 0 0; }

  .lobby-wrap { padding:20px 12px; }
}

@media (max-width: 480px) {
  .hero-ctas { flex-direction:column; width:100%; padding:0 20px; }
  .btn-accent, .btn-ghost { width:100%; text-align:center; }
  .topbar { flex-wrap:nowrap; }
  .peer-avatars { display:none; }
  .participant-panel { max-height:140px; }
}
</style>
</head>
<body>

<!-- LANDING -->
<div id="landing" class="screen on">
  <nav class="land-nav">
    <div class="brand">🎛 <span>Studio</span>Sync</div>
    <div style="flex:1"></div>
    <button class="tb-btn" onclick="showHistory()">📋 היסטוריה</button>
    <button class="tb-btn" onclick="openHelp()">? עזרה</button>
    <button class="tb-btn" id="themeToggleLand" onclick="toggleTheme()">🌙</button>
  </nav>
  <div class="hero" dir="rtl">
    <div class="hero-badge">שיתוף פעולה מוסיקלי בזמן אמת</div>
    <h1>עשו מוזיקה ביחד,<br>בזמן אמת</h1>
    <p class="hero-sub">שתפו את מסך ה-DAW שלכם, שדרו אודיו איכותי, ותנו לכולם לשלוט בסשן — מכל מקום בעולם.</p>
    <div class="hero-ctas">
      <button class="btn-accent" onclick="showLobby('create')">צור סשן</button>
      <button class="btn-ghost" onclick="showLobby('join')">הצטרף לסשן</button>
    </div>
    <div class="quick-join-divider">── או הכנס קוד ──</div>
    <div class="quick-join">
      <input id="quickJoinCode" placeholder="הכנס קוד סשן" maxlength="7" dir="ltr" onkeydown="if(event.key==='Enter')quickJoin()" />
      <button onclick="quickJoin()">הצטרף</button>
    </div>
  </div>
  <div class="features">
    <div class="feat-card" dir="rtl">
      <div class="feat-icon">🔊</div>
      <div class="feat-title">אודיו סטודיו</div>
      <div class="feat-desc">שדר אודיו DAW בזמן אמת, לא דרך מיקרופון</div>
    </div>
    <div class="feat-card" dir="rtl">
      <div class="feat-icon">🖱</div>
      <div class="feat-title">שליטה מלאה</div>
      <div class="feat-desc">כל משתתף יכול לשלוט ב-DAW — נגינה, עצירה, עריכה</div>
    </div>
    <div class="feat-card" dir="rtl">
      <div class="feat-icon">👥</div>
      <div class="feat-title">עד 10 אנשים</div>
      <div class="feat-desc">שתפו פעולה עם כל הלהקה או הכיתה בסשן אחד</div>
    </div>
  </div>

  <!-- Online Now -->
  <div id="onlineSection" class="online-section" dir="rtl" style="display:none">
    <div class="online-header">🟢 מחוברים עכשיו</div>
    <div id="onlineList" class="online-list"></div>
  </div>

  <!-- Upcoming Scheduled Sessions -->
  <div id="scheduleSection" class="schedule-section" dir="rtl" style="display:none">
    <div class="schedule-header">📅 סשנים מתוכננים</div>
    <div id="scheduleList" class="schedule-list"></div>
    <button class="btn-ghost" style="margin-top:8px;font-size:13px" onclick="showScheduleModal()">+ תזמן סשן חדש</button>
  </div>

  <!-- Feature Voting -->
  <div id="votingSection" class="voting-section" dir="rtl">
    <div class="voting-header">🗳 הצביעו לפיצ׳ר הבא</div>
    <div id="votingList" class="voting-list"></div>
  </div>
</div>

<!-- Schedule Modal -->
<div id="scheduleModal" class="modal-overlay" style="display:none" onclick="if(event.target===this)closeScheduleModal()">
  <div class="modal-box" dir="rtl" style="max-width:360px">
    <h3 style="margin:0 0 12px">📅 תזמן סשן</h3>
    <input id="schedTitle" class="lob-input" placeholder="שם הסשן" dir="rtl" />
    <input id="schedDate" class="lob-input" type="date" />
    <input id="schedTime" class="lob-input" type="time" />
    <div style="display:flex;gap:8px;margin-top:12px">
      <button class="btn-accent" style="flex:1" onclick="addSchedule()">שמור</button>
      <button class="btn-ghost" style="flex:1" onclick="closeScheduleModal()">ביטול</button>
    </div>
  </div>
</div>

<!-- LOBBY -->
<div id="lobby" class="screen">
  <div class="lobby-wrap">
    <div class="lobby-brand">🎛 <span>Studio</span>Sync</div>

    <div class="lobby-card" id="createCard" dir="rtl">
      <div class="lc-header">
        <div class="lc-icon">🎛</div>
        <div>
          <div class="lc-title">צור סשן חדש</div>
          <div class="lc-sub">תקבל קוד לשתף עם המשתתפים</div>
        </div>
      </div>
      <input id="createName" placeholder="השם שלך" class="lob-input" dir="rtl" />
      <div class="color-label">בחר צבע</div>
      <div class="color-picker" id="createColors"></div>
      <div class="instr-label">כלי נגינה</div>
      <div class="instr-grid" id="createInstrs"></div>
      <input id="createPassword" placeholder="סיסמה (אופציונלי)" class="lob-input" dir="rtl" type="password" />
      <button class="btn-accent btn-full" onclick="hostStart()">צור סשן ←</button>
    </div>

    <div class="lobby-divider">או הצטרף עם קוד</div>

    <div class="lobby-card" id="joinCard" dir="rtl">
      <div class="lc-header">
        <div class="lc-icon">🎧</div>
        <div>
          <div class="lc-title">הצטרף לסשן</div>
          <div class="lc-sub">הזן את הקוד שקיבלת מיוצר הסשן</div>
        </div>
      </div>
      <input id="joinNameInput" placeholder="השם שלך" class="lob-input" dir="rtl" />
      <div class="color-label">בחר צבע</div>
      <div class="color-picker" id="joinColors"></div>
      <div class="instr-label">כלי נגינה</div>
      <div class="instr-grid" id="joinInstrs"></div>
      <input id="joinCode" placeholder="ABC-123" class="lob-input code-input" dir="ltr" />
      <input id="joinPassword" placeholder="סיסמה (אם נדרשת)" class="lob-input" dir="rtl" type="password" style="display:none" />
      <label style="display:flex;align-items:center;gap:6px;font-size:13px;color:var(--mid);margin-top:4px;cursor:pointer"><input type="checkbox" id="joinAsListener" /> הצטרף כמאזין בלבד</label>
      <button class="btn-accent btn-full" onclick="remoteJoin()">הצטרף ←</button>
    </div>

    <button class="btn-link" onclick="show('landing')">→ חזרה</button>
  </div>
</div>

<!-- CONNECTING -->
<div id="connecting" class="screen">
  <div class="spin"></div>
  <div style="font-size:14px;color:var(--mid);font-family:var(--sans)" dir="rtl">מתחבר לסשן...</div>
  <div id="connectingCode" style="font-family:var(--mono);font-size:18px;font-weight:700;color:var(--accent);margin-top:8px"></div>
</div>

<!-- SESSION -->
<div id="session" class="screen">
  <!-- Top bar -->
  <div class="topbar">
    <div class="tb-brand">🎛 <span>Studio</span>Sync</div>
    <div class="tb-sep"></div>
    <div class="session-code-chip" onclick="openInvite()">
      <span id="codeDisplay">---</span>
      <span class="copy-icon">⎘</span>
    </div>
    <div class="peer-avatars" id="peerAvatars"></div>
    <div class="tb-flex"></div>
    <div class="session-timer" id="sessionTimer">⏱ 00:00</div>
    <div class="tb-status" id="tbStatus">0 peers</div>
    <button class="tb-btn tb-invite-btn" onclick="openInvite()">📨 הזמן</button>
    <button class="tb-btn" id="dndBtn" onclick="toggleDND()" title="מצב שקט">🔔</button>
    <button class="tb-btn" id="themeToggleSession" onclick="toggleTheme()">🌙</button>
    <button class="tb-btn" onclick="toggleSettings()">⚙</button>
    <button class="tb-btn tb-leave" onclick="leaveSession()">עזוב</button>
  </div>

  <!-- Workspace -->
  <div class="workspace">
    <!-- Main: shared screen video -->
    <div class="main-area" id="mainArea">
      <video id="mainVideo" class="main-video" autoplay playsinline></video>
      <div class="main-area-empty" id="mainEmpty" dir="rtl">
        <div class="main-area-empty-icon">🖥</div>
        <div class="main-area-empty-text">ממתין לשיתוף מסך...</div>
        <div class="main-area-empty-sub">לחץ על <b>"Share"</b> בסרגל למטה כדי לשתף את מסך ה-DAW והשמע.</div>
        <button class="btn-ghost" style="margin-top:12px;font-size:13px" onclick="doShareCam()">📷 או שתף מצלמה</button>
      </div>
    </div>

    <!-- Right: participants + chat -->
    <div class="participant-panel">
      <div class="panel-tabs">
        <button class="ptab active" id="tabPeers" onclick="switchTab('peers')">משתתפים</button>
        <button class="ptab" id="tabChat" onclick="switchTab('chat')">צ'אט</button>
        <button class="ptab" id="tabNotes" onclick="switchTab('notes')">📝 הערות</button>
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
      <div id="notesTab" class="tab-content">
        <textarea id="sharedNotes" placeholder="הערות משותפות..." oninput="onNotesInput()"></textarea>
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

  <div id="clipPanel" class="clip-panel"></div>
  <div class="transport-bar">
    <button class="tc" onclick="cmd('stop')">⏹</button>
    <button class="tc play-btn" id="playBtn" onclick="cmd('play')">▶</button>
    <button class="tc" id="recBtn" onclick="cmd('rec')">⏺</button>
    <div class="bpm-ctrl">
      <button class="bpm-btn tap-tempo" id="tapBtn" onclick="tapTempo()" title="Tap Tempo">TAP</button>
      <button class="bpm-btn" onclick="cmd('bpm',-1)">−</button>
      <div class="bpm-val" id="bpmDisp">128</div>
      <div class="bpm-lbl">BPM</div>
      <button class="bpm-btn" onclick="cmd('bpm',1)">+</button>
    </div>
    <button class="tc metro-btn" id="metroBtn" onclick="toggleMetro()" title="מטרונום">🔔</button>
    <div class="pos-display" id="posDisp">1.1.1</div>
    <div class="vu-wrap"><span class="vu-label">IN</span><div class="vu-meter" id="vuIn"></div></div>
    <div class="vu-wrap"><span class="vu-label">OUT</span><div class="vu-meter" id="vuOut"></div></div>
    <div class="tb-flex"></div>
    <div class="my-controls" id="myControls" title="What you're sending to the host">
      <span class="my-ctrl-btn active" id="myMouse" onclick="toggleMyCtrl('mouse')">🖱 Mouse</span>
      <span class="my-ctrl-btn active" id="myKeys" onclick="toggleMyCtrl('keyboard')">⌨ Keys</span>
      <span class="my-ctrl-btn active-g" id="myMidi" onclick="toggleMyCtrl('midi')">🎹 MIDI</span>
    </div>
    <div class="my-ctrl-sep"></div>
    <div class="latency-pill" id="latPill">-- ms</div>
    <span class="uptime-pill" id="uptimePill"></span>
    <button class="tc" id="pianoBtn" onclick="togglePiano()" title="Virtual Piano / MIDI">🎹</button>
    <button class="tc" onclick="toggleFullscreen()" title="מסך מלא">⛶</button>
    <button class="tc" id="clipBtn" onclick="toggleClipBoard()" title="קליפים">📋</button>
    <button class="tc rec-btn-transport" id="recSessionBtn" onclick="toggleSessionRecord()">⏺ הקלט<span class="lock-icon" id="recLock">🔒</span></button>
    <button class="tc share-audio-btn" onclick="doShareAudio()" title="שתף שמע בלבד">🔊</button>
    <button class="tc share-btn" onclick="doShare()">🖥 Share</button>
    <button class="tc cam-btn" onclick="doShareCam()">📷 Cam</button>
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

<!-- (remote video now inline in main-area) -->

<!-- Help overlay (first-time) -->
<div id="helpOverlay" style="display:none" onclick="if(event.target===this)closeHelp()">
  <div id="helpPanel">
    <div class="sp-header">
      <div class="sp-title">How it works / איך זה עובד</div>
      <button class="sp-close" onclick="closeHelp()">×</button>
    </div>
    <div style="padding:16px;display:flex;flex-direction:column;gap:14px;font-size:13px;color:var(--txt);line-height:1.6;">
      <!-- Hebrew -->
      <div dir="rtl" style="text-align:right;">
        <div style="margin-bottom:10px"><b style="color:var(--accent)">1. צור או הצטרף לסשן</b><br>אחד יוצר סשן ומשתף את הקוד. השאר מצטרפים עם הקוד.</div>
        <div style="margin-bottom:10px"><b style="color:var(--accent)">2. שתף מסך</b><br>המארח לוחץ <b>"Share"</b> כדי לשתף את מסך ה-DAW והשמע עם כולם.</div>
        <div style="margin-bottom:10px"><b style="color:var(--accent)">3. שליטה משותפת</b><br>כל המשתתפים יכולים לשלוט ב-DAW — עכבר, מקלדת, ואפילו MIDI דרך הפסנתר הוירטואלי.</div>
        <div style="margin-bottom:10px"><b style="color:var(--accent)">4. למארח</b><br>הרץ את <b>StudioSync Agent</b> על ה-Mac שלך כדי לקבל לחיצות ומקשים מהמשתתפים.</div>
        <div style="margin-bottom:10px"><b style="color:var(--accent)">5. מובייל</b><br>במובייל אפשר להצטרף, לצפות, לצ'ט ולשתף מצלמה/מיקרופון. שליטה בעכבר ומקלדת זמינה רק מדסקטופ.</div>
        <div style="padding:10px;background:var(--s1);border-radius:8px;font-size:12px;color:var(--mid);">
          <b>טיפים:</b> השתמש בכפתורי <b>MY Controls</b> בסרגל התחתון כדי לבחור מה אתה שולח. יוצר הסשן יכול לנהל הרשאות לכל משתתף.
        </div>
      </div>
      <hr style="border:none;border-top:1px solid var(--b1);">
      <!-- English -->
      <div>
        <div style="margin-bottom:10px"><b style="color:var(--accent)">1. Create or Join</b><br>One person creates the session and shares the code. Others join with that code.</div>
        <div style="margin-bottom:10px"><b style="color:var(--accent)">2. Share Screen</b><br>The host clicks <b>"Share"</b> to share their DAW screen and audio with everyone.</div>
        <div style="margin-bottom:10px"><b style="color:var(--accent)">3. Collaborate</b><br>All participants can control the DAW — mouse, keyboard, even MIDI via the virtual piano.</div>
        <div style="margin-bottom:10px"><b style="color:var(--accent)">4. For the host</b><br>Run the <b>StudioSync Agent</b> on your Mac to receive remote clicks and keystrokes.</div>
        <div style="margin-bottom:10px"><b style="color:var(--accent)">5. Mobile</b><br>On mobile you can join, watch, chat and share camera/mic. Mouse and keyboard control is desktop only.</div>
      </div>
    </div>
  </div>
</div>

<!-- Connection banner -->
<div id="connBanner"></div>

<!-- Invite modal -->
<div id="inviteModal" class="modal-overlay" style="display:none" onclick="if(event.target===this)closeInvite()">
  <div class="modal-box" dir="rtl">
    <div class="modal-title">📨 הזמן משתתפים</div>
    <div class="invite-label">קוד הסשן</div>
    <div class="invite-code-big" id="inviteCodeBig">---</div>
    <div class="invite-label">קישור להצטרפות</div>
    <div class="invite-link-row">
      <input readonly id="inviteLinkInput" class="invite-link-input" />
      <button class="btn-accent" onclick="copyInviteLink()">העתק</button>
    </div>
    <div class="invite-share-btns">
      <button class="invite-action-btn whatsapp-btn" onclick="shareWhatsApp()">📱 WhatsApp</button>
      <button class="invite-action-btn email-btn" onclick="shareEmail()">✉️ אימייל</button>
    </div>
    <button class="btn-link" onclick="closeInvite()">סגור</button>
  </div>
</div>

<!-- Upgrade modal -->
<div id="upgradeModal" class="modal-overlay" style="display:none" onclick="if(event.target===this)closeUpgrade()">
  <div class="upgrade-modal-box" dir="rtl">
    <div style="font-size:32px">👑</div>
    <div class="upgrade-title">שדרג ל-StudioSync Pro</div>
    <div class="upgrade-subtitle">קח את הסשנים שלך לשלב הבא</div>
    <div class="upgrade-features">
      <div class="upgrade-feat"><span class="check">✓</span> עד 10 משתתפים בסשן</div>
      <div class="upgrade-feat"><span class="check">✓</span> סשנים ללא הגבלת זמן</div>
      <div class="upgrade-feat"><span class="check">✓</span> הקלטת סשן + הורדה כקובץ</div>
      <div class="upgrade-feat"><span class="check">✓</span> היסטוריית סשנים מלאה</div>
      <div class="upgrade-feat"><span class="check">✓</span> סיכום סשן עם AI</div>
    </div>
    <button class="upgrade-cta" onclick="window.open('https://studiosync-nxu0.onrender.com/pricing','_blank')">שדרג עכשיו — Pro</button>
    <button class="btn-link" onclick="closeUpgrade()">אולי אחר כך</button>
  </div>
</div>

<!-- History panel -->
<div id="historyPanel" class="history-panel" dir="rtl">
  <div class="hp-header">
    <div class="hp-title">📋 היסטוריית סשנים</div>
    <button class="tb-btn" onclick="exportHistoryCSV()" style="font-size:12px;margin-left:auto;margin-right:8px">📥 CSV</button>
    <button class="sp-close" onclick="closeHistory()">×</button>
  </div>
  <input id="historySearch" class="hp-search" placeholder="חפש לפי קוד, שם..." oninput="filterHistory()" />
  <div class="hp-list" id="historyList"></div>
</div>

<!-- Rating modal -->
<div id="ratingModal" class="modal-overlay" style="display:none" onclick="if(event.target===this)skipRating()">
  <div class="modal-box" dir="rtl" style="text-align:center">
    <div style="font-size:32px">⭐</div>
    <div class="modal-title">איך היה הסשן?</div>
    <div class="rating-stars" id="ratingStars"></div>
    <div style="display:flex;gap:8px;justify-content:center">
      <button class="btn-accent" onclick="submitRating()" style="font-size:13px">שמור</button>
      <button class="btn-ghost" onclick="skipRating()" style="font-size:13px">דלג</button>
    </div>
  </div>
</div>

<!-- Share recording modal -->
<div id="shareRecModal" class="modal-overlay" style="display:none" onclick="if(event.target===this)closeShareRec()">
  <div class="modal-box" dir="rtl" style="text-align:center">
    <div style="font-size:32px">🎬</div>
    <div class="modal-title">ההקלטה מוכנה!</div>
    <div class="share-rec-btns">
      <button onclick="downloadRecBlob()">💾 הורד</button>
      <button onclick="nativeShareRec()">📤 שתף</button>
      <button onclick="shareRecWhatsApp()">📱 WhatsApp</button>
    </div>
    <button class="btn-link" onclick="closeShareRec()" style="margin-top:8px">סגור</button>
  </div>
</div>

<!-- Onboarding wizard -->
<div id="onboardingWizard" class="wizard-overlay" style="display:none">
  <div class="wizard-box">
    <div class="wizard-step active" id="wizStep0">
      <div class="wizard-icon">🎛</div>
      <div class="wizard-title">ברוכים הבאים ל-StudioSync!</div>
      <div class="wizard-desc">צרו סשן חדש ושתפו את הקוד עם החברים, או הצטרפו לסשן קיים עם קוד.</div>
    </div>
    <div class="wizard-step" id="wizStep1">
      <div class="wizard-icon">🖥</div>
      <div class="wizard-title">שתפו את ה-DAW</div>
      <div class="wizard-desc">המארח לוחץ "Share" כדי לשתף את מסך ה-DAW והשמע. כולם רואים ושומעים בזמן אמת.</div>
    </div>
    <div class="wizard-step" id="wizStep2">
      <div class="wizard-icon">🎹</div>
      <div class="wizard-title">שלטו ביחד</div>
      <div class="wizard-desc">כל המשתתפים יכולים לשלוט ב-DAW — עכבר, מקלדת, ואפילו MIDI דרך הפסנתר הוירטואלי. צ'אט והערות משותפות זמינים תמיד.</div>
    </div>
    <div class="wizard-dots">
      <div class="wizard-dot active" id="wizDot0"></div>
      <div class="wizard-dot" id="wizDot1"></div>
      <div class="wizard-dot" id="wizDot2"></div>
    </div>
    <div style="display:flex;gap:8px;justify-content:center;margin-top:16px">
      <button class="btn-ghost" id="wizPrev" onclick="wizardPrev()" style="font-size:13px;display:none">הקודם</button>
      <button class="btn-accent" id="wizNext" onclick="wizardNext()" style="font-size:13px">הבא</button>
    </div>
  </div>
</div>

<!-- Countdown overlay -->
<div id="countdownOverlay" class="countdown-overlay" style="display:none">
  <div class="countdown-num" id="countdownNum">3</div>
</div>

<!-- Toast -->
<div id="toastEl"></div>

<script>
const SERVER = '';
const PEER_COLORS = ['#6c47ff','#12b76a','#f04438','#f79009','#0ea5e9','#ec4899','#14b8a6','#8b5cf6'];
const INSTRUMENTS = ['Keys','Drums','Guitar','Bass','Vocals','Producer','Other'];
const MCOLS = ['#6c47ff','#12b76a','#f79009','#f04438','#8b5cf6'];
function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

const S = {
  cid: null, code: null, name: 'User', color: PEER_COLORS[0], instrument: 'Producer', plan: 'trial',
  bpm: 120, playing: false, rec: false,
  pos: { b:1, bt:1, tk:1 },
  peers: new Map(), // peerId → { name, color, instrument, conn, dc, latency, role, muted }
  poll: false,
  activeTab: 'peers',
  pingInterval: null,
  tickInterval: null,
  dnd: false,
  peerNumber: 0,
  role: 'participant', // 'participant' | 'listener'
  stageMode: false,
  stageHolder: null, // peerId of who is on stage
  lastNudge: 0,
  tapTimes: [],
  metro: false, metroInterval: null, metroBeat: 0,
  clips: [],
  connectedAt: null,
  analyserIn: null, analyserOut: null, vuAnim: null
};

// (track defs removed — not connected to real DAW)

const ICE = { iceServers: [
  { urls:'stun:stun.l.google.com:19302' },
  { urls:'turn:global.relay.metered.ca:80', username:'open', credential:'open' },
  { urls:'turn:global.relay.metered.ca:443', username:'open', credential:'open' },
]};

// ── Mobile detection ──────────────────────────────────────
const IS_MOBILE = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);

// ── Connection banner ─────────────────────────────────────
function showBanner(msg, type) {
  const el = document.getElementById('connBanner');
  if (!el) return;
  el.textContent = msg;
  el.className = type; // 'warn' | 'err' | 'ok' | ''
  if (type === 'ok') setTimeout(() => { el.className = ''; }, 3000);
}

// ── Browser fingerprint (trial tracking) ─────────────────
function getFingerprint() {
  let fp = localStorage.getItem('ss_fp');
  if (!fp) { fp = 'fp_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); localStorage.setItem('ss_fp', fp); }
  return fp;
}

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

function quickJoin() {
  const raw = (document.getElementById('quickJoinCode')?.value || '').replace(/[^A-Z0-9-]/gi, '').toUpperCase();
  if (raw.length < 5) { toast('הכנס קוד סשן תקין', 'r'); return; }
  showLobby('join');
  const inp = document.getElementById('joinCode');
  if (inp) inp.value = raw.includes('-') ? raw : raw.slice(0,3) + '-' + raw.slice(3);
  document.getElementById('joinNameInput')?.focus();
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
      body: JSON.stringify({ name: S.name, color: S.color, instrument: S.instrument, daw: 'Ableton', fingerprint: getFingerprint(), password: (document.getElementById('createPassword')?.value || '').trim() || undefined })
    });
    const d = await r.json();
    if (!d.ok) { toast('Error: ' + d.error, 'r'); show('lobby'); return; }
    S.cid = d.clientId;
    S.code = d.code;
    S.peerNumber = d.peerNumber || 1;
    S.plan = d.plan || 'trial';
    S.role = 'participant';
    document.getElementById('connectingCode').textContent = S.code;
    enterSession();
  } catch(e) {
    toast('Cannot reach server — check your connection', 'r');
    show('lobby');
  }
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
      body: JSON.stringify({ code, name: S.name, color: S.color, instrument: S.instrument, fingerprint: getFingerprint(), password: (document.getElementById('joinPassword')?.value || '').trim() || undefined, role: document.getElementById('joinAsListener')?.checked ? 'listener' : 'participant' })
    });
    const d = await r.json();
    if (!d.ok) {
      if (d.error === 'password_required') { document.getElementById('joinPassword').style.display = ''; toast('הסשן מוגן בסיסמה', 'r'); show('lobby'); return; }
      toast(d.error || 'Session not found', 'r'); show('lobby'); return;
    }
    S.cid = d.clientId;
    S.code = d.code;
    S.peerNumber = d.peerNumber || 2;
    S.plan = d.plan || 'trial';
    S.role = document.getElementById('joinAsListener')?.checked ? 'listener' : 'participant';
    document.getElementById('connectingCode').textContent = S.code;
    enterSession();
  } catch(e) {
    toast('Cannot reach server — check your connection', 'r');
    show('lobby');
  }
}

function enterSession() {
  S.connectedAt = Date.now();
  document.getElementById('codeDisplay').textContent = S.code;
  document.getElementById('spCode').textContent = S.code;
  updateBPM();
  updatePeerAvatars();
  renderPeerList();
  show('session');
  startPoll();
  startTimer();
  // Show/hide record lock icon
  const lockEl = document.getElementById('recLock');
  if (lockEl) lockEl.style.display = isPremium() ? 'none' : 'inline';
  // Listener mode — hide transport controls
  if (S.role === 'listener') {
    document.querySelector('.transport-bar').style.display = 'none';
    toast('מצב מאזין — צפייה בלבד', '');
  } else {
    document.querySelector('.transport-bar').style.display = '';
  }
  // On mobile, disable mouse/keyboard sending (not useful) and turn off by default
  if (IS_MOBILE) {
    MY.mouse = false; MY.keyboard = false;
    document.getElementById('myMouse')?.classList.remove('active');
    document.getElementById('myKeys')?.classList.remove('active');
  }
  // Ping loop
  S.pingInterval = setInterval(() => {
    if (S.cid) send({ type: 'ping:req', ts: Date.now() });
  }, 5000);
  // Position tick
  S.tickInterval = setInterval(() => {
    if (!S.playing) return;
    S.pos.tk++;
    if (S.pos.tk > 4) { S.pos.tk = 1; S.pos.bt++; }
    if (S.pos.bt > 4) { S.pos.bt = 1; S.pos.b++; }
    updatePos();
  }, 200);
}

function leaveSession() {
  saveHistory();
  stopTimer();
  if (sessionRecorder && sessionRecorder.state === 'recording') sessionRecorder.stop();
  sessionRecorder = null;
  S.role = 'participant';
  S.stageMode = false; S.stageHolder = null;
  S.poll = false;
  clearInterval(S.pingInterval); S.pingInterval = null;
  clearInterval(S.tickInterval); S.tickInterval = null;
  for (const [, p] of S.peers) p.conn?.close();
  S.peers.clear();
  S.cid = null; S.code = null;
  S.playing = false; S.rec = false;
  S.pos = { b: 1, bt: 1, tk: 1 };
  closeRv();
  show('landing');
  showRatingModal();
}

// ── Polling with reconnection ─────────────────────────────
async function startPoll() {
  S.poll = true;
  let fails = 0;
  while (S.poll) {
    try {
      const r = await fetch(SERVER + '/api/poll?cid=' + S.cid, { signal: AbortSignal.timeout(30000) });
      if (!r.ok) {
        if (r.status === 404) {
          showBanner('Session expired — please rejoin', 'err');
          leaveSession();
          return;
        }
        fails++;
        if (fails >= 3) showBanner('Connection issues — reconnecting...', 'warn');
        await new Promise(r => setTimeout(r, Math.min(2000 * fails, 10000)));
        continue;
      }
      if (fails > 0) { showBanner('Reconnected!', 'ok'); fails = 0; }
      const d = await r.json();
      for (const m of (d.messages || [])) handleMsg(m);
    } catch(e) {
      if (e.name === 'TimeoutError') continue;
      fails++;
      if (fails >= 3) showBanner('Connection lost — retrying...', 'err');
      await new Promise(r => setTimeout(r, Math.min(2000 * fails, 15000)));
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
    pc.ontrack = (e) => { if (e.streams[0]) showRemoteStream(e.streams[0], peerId); };
    pc.onnegotiationneeded = async () => {
      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        send({ type: 'webrtc:offer', peerId, offer });
      } catch(e) {}
    };
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    send({ type: 'webrtc:offer', peerId, offer });
  },
  async handleOffer(peerId, offer) {
    // Re-negotiation: reuse existing connection if present
    const existing = S.peers.get(peerId)?.conn;
    const pc = existing || new RTCPeerConnection(ICE);
    if (!existing) {
      const peerInfo = S.peers.get(peerId) || {};
      S.peers.set(peerId, { ...peerInfo, conn: pc });
      pc.ondatachannel = (e) => {
        const dc = e.channel;
        dc.onopen = () => { const p = S.peers.get(peerId); if (p) p.dc = dc; dlog('DC open ← ' + peerId); };
        dc.onmessage = (ev) => applyRemote(JSON.parse(ev.data), peerId);
      };
      pc.onicecandidate = (e) => { if (e.candidate) send({ type: 'webrtc:ice', peerId, candidate: e.candidate }); };
      pc.onconnectionstatechange = () => { updatePeerStatus(peerId, pc.connectionState); };
      pc.onnegotiationneeded = async () => {
        try {
          const o = await pc.createOffer();
          await pc.setLocalDescription(o);
          send({ type: 'webrtc:offer', peerId, offer: o });
        } catch(e) {}
      };
    }
    pc.ontrack = (e) => { if (e.streams[0]) showRemoteStream(e.streams[0], peerId); };
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
      S.connectedAt = Date.now();
      for (const p of (msg.peers || [])) {
        S.peers.set(p.id, { name: p.name, color: p.color, instrument: p.instrument, dc: null, conn: null, latency: 0 });
      }
      updatePeerAvatars(); renderPeerList();
      break;
    case 'peer:joined':
      S.peers.set(msg.peerId, { name: msg.name, color: msg.color, instrument: msg.instrument, dc: null, conn: null, latency: 0, role: msg.role || 'participant', muted: false });
      updatePeerAvatars(); renderPeerList();
      if (!S.dnd) { playJoinSound(); toast(msg.name + ' הצטרף/ה', 'g'); }
      break;
    case 'peer:left': {
      const lp = S.peers.get(msg.peerId);
      if (lp) {
        const card = document.querySelector('[data-peer="' + msg.peerId + '"]');
        if (card) { card.classList.add('leaving'); setTimeout(() => { lp?.conn?.close(); S.peers.delete(msg.peerId); updatePeerAvatars(); renderPeerList(); }, 300); }
        else { lp.conn?.close(); S.peers.delete(msg.peerId); updatePeerAvatars(); renderPeerList(); }
      }
      if (!S.dnd) { playLeaveSound(); toast((msg.name || 'Peer') + ' עזב/ה', ''); }
      break;
    }
    case 'webrtc:create-offer':
      S.peers.set(msg.peerId, { name: msg.name || '', color: msg.color || PEER_COLORS[0], instrument: msg.instrument || '', dc: null, conn: null, latency: 0 });
      PeerMesh.createOffer(msg.peerId).catch(e => dlog('WebRTC offer err: ' + e.message));
      break;
    case 'webrtc:offer':
      PeerMesh.handleOffer(msg.peerId, msg.offer).catch(e => dlog('WebRTC handle-offer err: ' + e.message));
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
      dlog('🎹 MIDI ' + msg.action + ' note=' + (msg.note||'-') + ' from ' + (msg.fromName||'peer'));
      break;
    case 'nudge':
      if (!S.dnd) {
        playTone(1200, .15); setTimeout(() => playTone(1500, .15), 120);
        document.getElementById('session')?.classList.add('nudged');
        setTimeout(() => document.getElementById('session')?.classList.remove('nudged'), 1500);
        toast((msg.fromName || 'מישהו') + ' שלח/ה לך נאדג!', '');
      }
      break;
    case 'mute:command':
      if (msg.targetId === S.cid) {
        S.mutedByHost = msg.muted;
        toast(msg.muted ? 'המארח השתיק אותך' : 'המארח ביטל את ההשתקה', msg.muted ? 'r' : 'g');
      }
      break;
    case 'stage:toggle':
      S.stageMode = msg.enabled;
      S.stageHolder = msg.stageHolder || null;
      renderPeerList();
      toast(msg.enabled ? 'מצב במה הופעל' : 'מצב במה כבוי', '');
      break;
    case 'stage:grant':
      S.stageHolder = msg.peerId;
      renderPeerList();
      if (msg.peerId === S.cid) toast('אתה על הבמה!', 'g');
      break;
    case 'stage:request':
      if (S.peerNumber === 1) toast(msg.fromName + ' מבקש/ת לעלות לבמה', '');
      break;
    case 'notes:update':
      if (msg.from !== S.cid) {
        const ta = document.getElementById('sharedNotes');
        if (ta) ta.value = msg.text;
      }
      break;
    case 'metro:toggle':
      if (msg.from !== S.cid) {
        S.metro = msg.on;
        if (S.metro) startMetronome(msg.bpm || S.bpm);
        else stopMetronome();
        const mb = document.getElementById('metroBtn');
        if (mb) mb.classList.toggle('on', S.metro);
      }
      break;
  }
}

// ── DAW state ─────────────────────────────────────────────
function applyDAW(msg, fromPeer) {
  const a = msg.action;
  if (a === 'play') {
    S.playing = msg.playing; S.rec = msg.rec || false;
    const pb = document.getElementById('playBtn');
    if (pb) pb.textContent = S.playing ? '⏸' : '▶';
  } else if (a === 'bpm') {
    S.bpm = msg.bpm; updateBPM();
  } else if (a === 'pos') {
    S.pos = msg.pos; updatePos();
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

// (track rendering and markers removed — not connected to real DAW)

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
  if (state === 'failed' || state === 'disconnected') {
    setTimeout(() => {
      const pp = S.peers.get(peerId);
      if (!pp || !S.cid) return;
      if (pp.connState === 'failed' || pp.connState === 'disconnected') {
        dlog('↩ Reconnecting to ' + (pp.name || peerId));
        pp.conn?.close();
        pp.conn = null; pp.dc = null;
        PeerMesh.createOffer(peerId);
      }
    }, 3000);
  }
}

// ── Chat ──────────────────────────────────────────────────
function switchTab(tab) {
  S.activeTab = tab;
  document.getElementById('peersTab').style.display = tab === 'peers' ? 'flex' : 'none';
  document.getElementById('chatTab').style.display = tab === 'chat' ? 'flex' : 'none';
  document.getElementById('notesTab').style.display = tab === 'notes' ? 'flex' : 'none';
  document.getElementById('tabPeers').classList.toggle('active', tab === 'peers');
  document.getElementById('tabChat').classList.toggle('active', tab === 'chat');
  document.getElementById('tabNotes').classList.toggle('active', tab === 'notes');
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
  navigator.clipboard?.writeText(S.code || '').then(() => toast('קוד הועתק!', 'g'));
}

function openInvite() {
  const modal = document.getElementById('inviteModal');
  const code  = S.code || '---';
  const link  = window.location.origin + '?join=' + code;
  document.getElementById('inviteCodeBig').textContent  = code;
  document.getElementById('inviteLinkInput').value      = link;
  modal.style.display = 'flex';
}
function closeInvite() {
  document.getElementById('inviteModal').style.display = 'none';
}
function copyInviteLink() {
  const link = document.getElementById('inviteLinkInput').value;
  navigator.clipboard?.writeText(link).then(() => toast('קישור הועתק!', 'g'));
}
function shareWhatsApp() {
  const link = document.getElementById('inviteLinkInput').value;
  const code = S.code || '';
  const text = encodeURIComponent('הצטרף לסשן שלי ב-StudioSync \\nקוד: ' + code + '\\n' + link);
  window.open('https://wa.me/?text=' + text, '_blank');
}
function shareEmail() {
  const link = document.getElementById('inviteLinkInput').value;
  const code = S.code || '';
  const subj = encodeURIComponent('הוזמנת לסשן StudioSync');
  const body = encodeURIComponent('הצטרף לסשן שלי ב-StudioSync \\n\\nקוד הסשן: ' + code + '\\n\\nקישור ישיר: ' + link);
  window.open('mailto:?subject=' + subj + '&body=' + body, '_blank');
}

function toggleSettings() {
  const ov = document.getElementById('settingsOverlay');
  if (ov) ov.style.display = ov.style.display === 'flex' ? 'none' : 'flex';
}

async function doShare() {
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: true, audio: true,
      selfBrowserSurface: 'include', surfaceSwitching: 'include', systemAudio: 'include'
    });
    toast('Sharing screen…', 'g');
    const vid = document.getElementById('mainVideo');
    const empty = document.getElementById('mainEmpty');
    if (vid) { vid.srcObject = stream; vid.classList.add('active'); vid.muted = true; }
    if (empty) empty.style.display = 'none';
    initVU(stream, 'in');
    for (const [, p] of S.peers) {
      if (p.conn) stream.getTracks().forEach(t => p.conn.addTrack(t, stream));
    }
    stream.getVideoTracks()[0].onended = () => { toast('Screen share ended', ''); closeRv(); stopVU('in'); };
  } catch(e) { toast('Share cancelled', ''); }
}

async function doShareCam() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    toast('מצלמה משותפת!', 'g');
    // Show locally
    const vid = document.getElementById('mainVideo');
    const empty = document.getElementById('mainEmpty');
    if (vid) { vid.srcObject = stream; vid.classList.add('active'); vid.muted = true; }
    if (empty) empty.style.display = 'none';
    // Send to peers
    for (const [, p] of S.peers) {
      if (p.conn) stream.getTracks().forEach(t => p.conn.addTrack(t, stream));
    }
    stream.getVideoTracks()[0].onended = () => { toast('המצלמה נעצרה', ''); closeRv(); };
  } catch(e) { toast('המצלמה לא זמינה או שנדחתה', 'r'); }
}

async function doShareAudio() {
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true, systemAudio: 'include' });
    const vt = stream.getVideoTracks()[0];
    if (vt) { stream.removeTrack(vt); vt.stop(); }
    if (stream.getAudioTracks().length === 0) { toast('לא נמצא אודיו', 'r'); return; }
    toast('משתף שמע בלבד…', 'g');
    initVU(stream, 'in');
    for (const [, p] of S.peers) {
      if (p.conn) stream.getAudioTracks().forEach(t => p.conn.addTrack(t, stream));
    }
    stream.getAudioTracks()[0].onended = () => { toast('שיתוף השמע הסתיים', ''); stopVU('in'); };
  } catch(e) { toast('שיתוף שמע בוטל', ''); }
}

function showRemoteStream(stream, peerId) {
  const vid   = document.getElementById('mainVideo');
  const empty = document.getElementById('mainEmpty');
  if (!vid) return;
  vid.srcObject = stream;
  vid.classList.add('active');
  if (empty) empty.style.display = 'none';
  const p = S.peers.get(peerId);
  toast((p?.name || 'Peer') + ' is sharing screen', 'g');
  initVU(stream, 'out');
  stream.getTracks().forEach(t => { t.onended = () => { closeRv(); stopVU('out'); }; });
}

function closeRv() {
  const vid   = document.getElementById('mainVideo');
  const empty = document.getElementById('mainEmpty');
  if (vid) { vid.srcObject = null; vid.classList.remove('active'); }
  if (empty) empty.style.display = '';
}

// ══════════════════════════════════════════════════════════
// My Controls — what THIS peer is sending
// ══════════════════════════════════════════════════════════
const MY = { mouse: true, keyboard: true, midi: true };

function toggleMyCtrl(key) {
  MY[key] = !MY[key];
  const ids = { mouse:'myMouse', keyboard:'myKeys', midi:'myMidi' };
  const cls = key === 'midi' ? 'active-g' : 'active';
  const btn = document.getElementById(ids[key]);
  if (btn) btn.classList.toggle(cls, MY[key]);
  toast((MY[key] ? '✓ Sending ' : '✗ Stopped sending ') + key, MY[key] ? 'g' : '');
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
  if (!MY.midi) return; // user toggled off MIDI sending
  const vel = Number(document.getElementById('pianoVel')?.value || 100);
  const ch  = Number(document.getElementById('pianoChSel')?.value || 1) - 1;
  broadcast({ type:'remote:midi', action:'noteon', note, velocity:vel, channel:ch,
    from:S.cid, fromName:S.name });
}

function pianoNoteOff(note, el) {
  if (!PIANO.active.has(note)) return;
  PIANO.active.delete(note);
  el?.classList.remove('on');
  if (!MY.midi) return;
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

// ── Premium gating ────────────────────────────────────────
function isPremium() { return S.plan === 'pro'; }

function showUpgradeModal() { document.getElementById('upgradeModal').style.display = 'flex'; }
function closeUpgrade() { document.getElementById('upgradeModal').style.display = 'none'; }

// ── Session timer ─────────────────────────────────────────
const TIMER = { interval: null, seconds: 0, warned: false };
const FREE_LIMIT_SECS = 45 * 60; // 45 min

function startTimer() {
  TIMER.seconds = 0; TIMER.warned = false;
  updateTimerDisplay();
  TIMER.interval = setInterval(() => {
    TIMER.seconds++;
    updateTimerDisplay();
    if (S.connectedAt) {
      const secs = Math.floor((Date.now() - S.connectedAt) / 1000);
      const h = Math.floor(secs / 3600); const m = Math.floor((secs % 3600) / 60);
      const up = document.getElementById('uptimePill');
      if (up) up.textContent = (h ? h + 'h ' : '') + m + 'm';
    }
    const remaining = FREE_LIMIT_SECS - TIMER.seconds;
    if (!isPremium() && remaining === 300 && !TIMER.warned) {
      TIMER.warned = true;
      toast('נשארו 5 דקות בסשן החינמי', 'r');
    }
    if (!isPremium() && TIMER.seconds >= FREE_LIMIT_SECS) {
      clearInterval(TIMER.interval);
      showUpgradeModal();
    }
  }, 1000);
}
function stopTimer() { clearInterval(TIMER.interval); TIMER.interval = null; }
function updateTimerDisplay() {
  const el = document.getElementById('sessionTimer');
  if (!el) return;
  const m = Math.floor(TIMER.seconds / 60);
  const s = TIMER.seconds % 60;
  el.textContent = String(m).padStart(2,'0') + ':' + String(s).padStart(2,'0');
  const remaining = FREE_LIMIT_SECS - TIMER.seconds;
  if (!isPremium() && remaining <= 60) el.className = 'session-timer crit';
  else if (!isPremium() && remaining <= 300) el.className = 'session-timer warn';
  else el.className = 'session-timer';
}

// ── Session recording (premium) ───────────────────────────
let sessionRecorder = null;
let lastRecBlob = null;
function toggleSessionRecord() {
  if (!isPremium()) { showUpgradeModal(); return; }
  const vid = document.getElementById('mainVideo');
  if (sessionRecorder && sessionRecorder.state === 'recording') {
    sessionRecorder.stop();
    sessionRecorder = null;
    document.getElementById('recSessionBtn').style.background = '';
    return;
  }
  if (!vid || !vid.srcObject) { toast('אין שיתוף מסך להקלטה', 'r'); return; }
  startCountdown(() => {
    const chunks = [];
    sessionRecorder = new MediaRecorder(vid.srcObject, { mimeType: 'video/webm' });
    sessionRecorder.ondataavailable = e => { if (e.data.size > 0) chunks.push(e.data); };
    sessionRecorder.onstop = () => {
      lastRecBlob = new Blob(chunks, { type: 'video/webm' });
      S.clips.push({ blob: lastRecBlob, name: 'clip-' + new Date().toLocaleTimeString('he-IL',{hour:'2-digit',minute:'2-digit'}), ts: Date.now() });
      if (S.clips.length > 10) S.clips.shift();
      renderClips();
      showShareRecModal();
    };
    sessionRecorder.start(1000);
    document.getElementById('recSessionBtn').style.background = 'var(--rD)';
    toast('מקליט את הסשן...', 'g');
  });
}

// ── Session history ───────────────────────────────────────
function saveHistory() {
  if (!S.code) return;
  const history = JSON.parse(localStorage.getItem('ss_history') || '[]');
  history.unshift({
    code: S.code,
    date: new Date().toISOString(),
    duration: TIMER.seconds,
    participants: S.peers.size + 1,
    name: S.name,
    tags: [],
    project: '',
    rating: 0
  });
  if (history.length > 20) history.length = 20;
  localStorage.setItem('ss_history', JSON.stringify(history));
}
function showHistory() {
  const panel = document.getElementById('historyPanel');
  const list = document.getElementById('historyList');
  const history = JSON.parse(localStorage.getItem('ss_history') || '[]');
  const search = (document.getElementById('historySearch')?.value || '').toLowerCase();
  list.innerHTML = '';
  const filtered = search ? history.filter(h => (h.code||'').toLowerCase().includes(search) || (h.name||'').toLowerCase().includes(search) || (h.tags||[]).some(t => t.toLowerCase().includes(search)) || (h.project||'').toLowerCase().includes(search)) : history;
  if (filtered.length === 0) {
    list.innerHTML = '<div style="text-align:center;color:var(--mid);padding:40px">' + (search ? 'לא נמצאו תוצאות' : 'אין סשנים קודמים') + '</div>';
  } else {
    filtered.forEach((h, i) => {
      const dur = Math.floor((h.duration||0) / 60);
      const card = document.createElement('div');
      card.className = 'hp-card' + (!isPremium() && i >= 2 ? ' hp-card-blur' : '');
      const stars = h.rating ? ' · ' + '⭐'.repeat(h.rating) : '';
      const tagsHtml = (h.tags||[]).length ? '<div class="hp-tags">' + h.tags.map(t => '<span class="hp-tag">' + t + '</span>').join('') + '</div>' : '';
      const projHtml = h.project ? '<div style="font-size:11px;color:var(--accent);margin-bottom:2px">📁 ' + h.project + '</div>' : '';
      card.innerHTML = projHtml + '<div class="hp-date">' + new Date(h.date).toLocaleDateString('he-IL') + '</div>'
        + '<div class="hp-code">' + h.code + '</div>'
        + '<div class="hp-info">' + dur + ' דקות · ' + h.participants + ' משתתפים' + stars + '</div>'
        + tagsHtml
        + '<div class="tag-input-row"><input placeholder="הוסף תגית..." onkeydown="if(event.keyCode===13)addTag(' + i + ',this)" /><button onclick="addTag(' + i + ',this.previousElementSibling)">+</button></div>';
      list.appendChild(card);
    });
    if (!isPremium() && filtered.length > 2) {
      const up = document.createElement('div');
      up.style.cssText = 'text-align:center;padding:16px;';
      up.innerHTML = '<button class="btn-accent" style="font-size:13px" onclick="showUpgradeModal()">שדרג לצפיה בכל ההיסטוריה</button>';
      list.appendChild(up);
    }
  }
  panel.classList.add('open');
}
function filterHistory() { showHistory(); }
function closeHistory() { document.getElementById('historyPanel').classList.remove('open'); }

// ── Dark mode ─────────────────────────────────────────────
function toggleTheme() {
  const d = document.documentElement;
  const next = d.dataset.theme === 'dark' ? 'light' : 'dark';
  d.dataset.theme = next;
  localStorage.setItem('ss_theme', next);
  const icon = next === 'dark' ? '☀️' : '🌙';
  const t1 = document.getElementById('themeToggleLand');
  const t2 = document.getElementById('themeToggleSession');
  if (t1) t1.textContent = icon;
  if (t2) t2.textContent = icon;
}
function initTheme() {
  const saved = localStorage.getItem('ss_theme');
  const theme = saved || 'dark';
  document.documentElement.dataset.theme = theme;
  const icon = theme === 'dark' ? '☀️' : '🌙';
  const t1 = document.getElementById('themeToggleLand');
  const t2 = document.getElementById('themeToggleSession');
  if (t1) t1.textContent = icon;
  if (t2) t2.textContent = icon;
}

// ── Shared AudioContext ───────────────────────────────────
let _audioCtx = null;
function getAudioCtx() {
  if (!_audioCtx) _audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (_audioCtx.state === 'suspended') _audioCtx.resume();
  return _audioCtx;
}

// ── Sound effects ─────────────────────────────────────────
function playTone(freq, dur, type) {
  try {
    const ctx = getAudioCtx();
    const osc = ctx.createOscillator(); const gain = ctx.createGain();
    osc.type = type || 'sine'; osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.12, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + dur);
    osc.connect(gain); gain.connect(ctx.destination);
    osc.start(); osc.stop(ctx.currentTime + dur);
  } catch(e) {}
}
function playJoinSound() { playTone(880, .12); setTimeout(() => playTone(1108, .12), 80); }
function playLeaveSound() { playTone(660, .18, 'triangle'); }

// ── Tap Tempo ────────────────────────────────────────────
function tapTempo() {
  const now = Date.now();
  if (S.tapTimes.length && now - S.tapTimes[S.tapTimes.length - 1] > 2000) S.tapTimes = [];
  S.tapTimes.push(now);
  if (S.tapTimes.length >= 2) {
    let sum = 0;
    for (let i = 1; i < S.tapTimes.length; i++) sum += S.tapTimes[i] - S.tapTimes[i - 1];
    const avg = sum / (S.tapTimes.length - 1);
    const bpm = Math.round(Math.max(40, Math.min(300, 60000 / avg)));
    S.bpm = bpm;
    const disp = document.getElementById('bpmDisp');
    if (disp) disp.textContent = bpm;
    broadcast({ type: 'daw:state', action: 'bpm', bpm, from: S.cid });
    send({ type: 'daw:state', action: 'bpm', bpm, from: S.cid });
    if (S.metro) { stopMetronome(); startMetronome(bpm); }
  }
  if (S.tapTimes.length > 8) S.tapTimes = S.tapTimes.slice(-8);
  const btn = document.getElementById('tapBtn');
  if (btn) { btn.style.color = 'var(--accent)'; setTimeout(() => btn.style.color = '', 100); }
}

// ── Metronome ────────────────────────────────────────────
function toggleMetro() {
  S.metro = !S.metro;
  const btn = document.getElementById('metroBtn');
  if (btn) btn.classList.toggle('on', S.metro);
  if (S.metro) startMetronome(S.bpm);
  else stopMetronome();
  broadcast({ type: 'metro:toggle', on: S.metro, bpm: S.bpm, from: S.cid });
  send({ type: 'metro:toggle', on: S.metro, bpm: S.bpm, from: S.cid });
}
function startMetronome(bpm) {
  stopMetronome();
  S.metroBeat = 0;
  metroBeat();
  S.metroInterval = setInterval(metroBeat, 60000 / bpm);
}
function stopMetronome() {
  if (S.metroInterval) { clearInterval(S.metroInterval); S.metroInterval = null; }
}
function metroBeat() {
  const ctx = getAudioCtx();
  const freq = S.metroBeat === 0 ? 1000 : 800;
  const osc = ctx.createOscillator(); const g = ctx.createGain();
  osc.type = 'square'; osc.frequency.value = freq;
  g.gain.setValueAtTime(0.08, ctx.currentTime);
  g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.03);
  osc.connect(g); g.connect(ctx.destination);
  osc.start(); osc.stop(ctx.currentTime + 0.03);
  S.metroBeat = (S.metroBeat + 1) % 4;
}

// ── VU Meter ─────────────────────────────────────────────
function initVU(stream, type) {
  const ctx = getAudioCtx();
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 64;
  try {
    const src = ctx.createMediaStreamSource(stream);
    src.connect(analyser);
  } catch(e) { return; }
  if (type === 'in') S.analyserIn = analyser;
  else S.analyserOut = analyser;
  const el = document.getElementById(type === 'in' ? 'vuIn' : 'vuOut');
  if (el && !el.children.length) {
    el.innerHTML = Array(8).fill('<div class="vu-bar"></div>').join('');
  }
  if (!S.vuAnim) S.vuAnim = requestAnimationFrame(updateVU);
}
function stopVU(type) {
  if (type === 'in') S.analyserIn = null;
  else S.analyserOut = null;
  const el = document.getElementById(type === 'in' ? 'vuIn' : 'vuOut');
  if (el) Array.from(el.children).forEach(b => b.style.height = '2px');
  if (!S.analyserIn && !S.analyserOut && S.vuAnim) { cancelAnimationFrame(S.vuAnim); S.vuAnim = null; }
}
function updateVU() {
  drawVUBars(S.analyserIn, 'vuIn');
  drawVUBars(S.analyserOut, 'vuOut');
  S.vuAnim = requestAnimationFrame(updateVU);
}
function drawVUBars(analyser, elId) {
  const el = document.getElementById(elId);
  if (!analyser || !el || !el.children.length) return;
  const data = new Uint8Array(analyser.frequencyBinCount);
  analyser.getByteFrequencyData(data);
  const bars = el.children;
  const step = Math.floor(data.length / bars.length);
  for (let i = 0; i < bars.length; i++) {
    let val = 0;
    for (let j = 0; j < step; j++) val += data[i * step + j];
    val = val / step / 255;
    bars[i].style.height = Math.max(2, val * 24) + 'px';
    bars[i].className = 'vu-bar' + (val > 0.95 ? ' clip' : val > 0.75 ? ' warn' : '');
  }
}

// ── Clip Board ───────────────────────────────────────────
function toggleClipBoard() {
  const p = document.getElementById('clipPanel');
  if (!p) return;
  p.style.display = p.style.display === 'block' ? 'none' : 'block';
  const btn = document.getElementById('clipBtn');
  if (btn) btn.style.background = p.style.display === 'block' ? 'var(--accentD)' : '';
  renderClips();
}
function renderClips() {
  const el = document.getElementById('clipPanel');
  if (!el) return;
  if (S.clips.length === 0) { el.innerHTML = '<div style="font-size:12px;color:var(--dim);text-align:center;padding:12px" dir="rtl">אין קליפים עדיין. הקלט סשן כדי ליצור קליפ.</div>'; return; }
  el.innerHTML = S.clips.slice().reverse().map((c, i) => {
    const url = URL.createObjectURL(c.blob);
    const size = (c.blob.size / 1024 / 1024).toFixed(1) + 'MB';
    return '<div class="clip-card"><span class="clip-name">🎵 ' + esc(c.name) + ' (' + size + ')</span><a class="clip-dl" href="' + url + '" download="' + c.name + '.webm">⬇</a></div>';
  }).join('');
}

// ── DND mode ──────────────────────────────────────────────
function toggleDND() {
  S.dnd = !S.dnd;
  const btn = document.getElementById('dndBtn');
  if (btn) { btn.textContent = S.dnd ? '🔕' : '🔔'; btn.classList.toggle('dnd-active', S.dnd); }
  toast(S.dnd ? 'מצב שקט — התראות מושתקות' : 'התראות פעילות', '');
}

// ── Fullscreen ────────────────────────────────────────────
function toggleFullscreen() {
  const el = document.getElementById('mainArea');
  if (document.fullscreenElement) document.exitFullscreen();
  else el?.requestFullscreen?.();
}

// ── Nudge ─────────────────────────────────────────────────
function nudgePeer(peerId) {
  if (Date.now() - S.lastNudge < 10000) { toast('חכה כמה שניות', 'r'); return; }
  S.lastNudge = Date.now();
  broadcast({ type: 'nudge', targetId: peerId, from: S.cid, fromName: S.name });
  send({ type: 'nudge', targetId: peerId, from: S.cid, fromName: S.name });
  toast('נאדג נשלח!', 'g');
}

// ── Mute participant (host) ───────────────────────────────
function muteParticipant(peerId) {
  const peer = S.peers.get(peerId);
  if (!peer) return;
  peer.muted = !peer.muted;
  broadcast({ type: 'mute:command', targetId: peerId, muted: peer.muted, from: S.cid });
  send({ type: 'mute:command', targetId: peerId, muted: peer.muted });
  renderPeerList();
}

// ── Stage mode ────────────────────────────────────────────
function toggleStageMode() {
  if (S.peerNumber !== 1) { toast('רק המארח יכול לשלוט בבמה', 'r'); return; }
  S.stageMode = !S.stageMode;
  S.stageHolder = S.stageMode ? S.cid : null;
  broadcast({ type: 'stage:toggle', enabled: S.stageMode, stageHolder: S.stageHolder });
  send({ type: 'stage:toggle', enabled: S.stageMode, stageHolder: S.stageHolder });
  renderPeerList();
}
function grantStage(peerId) {
  S.stageHolder = peerId;
  broadcast({ type: 'stage:grant', peerId });
  send({ type: 'stage:grant', peerId });
  renderPeerList();
}
function requestStage() {
  send({ type: 'stage:request', from: S.cid, fromName: S.name });
  toast('בקשה לעלות לבמה נשלחה', 'g');
}

// ── Shared notes ──────────────────────────────────────────
let notesDebounce = null;
function onNotesInput() {
  clearTimeout(notesDebounce);
  notesDebounce = setTimeout(() => {
    const text = document.getElementById('sharedNotes')?.value || '';
    broadcast({ type: 'notes:update', text, from: S.cid });
    send({ type: 'notes:update', text, from: S.cid });
  }, 300);
}

// ── Countdown ─────────────────────────────────────────────
function startCountdown(callback) {
  const ov = document.getElementById('countdownOverlay');
  const num = document.getElementById('countdownNum');
  ov.style.display = 'flex';
  let c = 3;
  num.textContent = c;
  playTone(600, .1);
  const iv = setInterval(() => {
    c--;
    if (c > 0) { num.textContent = c; num.style.animation = 'none'; void num.offsetWidth; num.style.animation = 'countPop .8s ease'; playTone(600, .1); }
    else { clearInterval(iv); ov.style.display = 'none'; playTone(900, .15); callback(); }
  }, 1000);
}

// ── Share recording modal ─────────────────────────────────
function showShareRecModal() {
  document.getElementById('shareRecModal').style.display = 'flex';
}
function closeShareRec() { document.getElementById('shareRecModal').style.display = 'none'; }
function downloadRecBlob() {
  if (!lastRecBlob) return;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(lastRecBlob);
  a.download = 'session-' + (S.code || 'rec') + '.webm'; a.click();
  closeShareRec();
}
function nativeShareRec() {
  if (!lastRecBlob || !navigator.share) { downloadRecBlob(); return; }
  const file = new File([lastRecBlob], 'session-' + (S.code || 'rec') + '.webm', { type: 'video/webm' });
  navigator.share({ files: [file], title: 'StudioSync Session' }).catch(() => {});
  closeShareRec();
}
function shareRecWhatsApp() {
  window.open('https://wa.me/?text=' + encodeURIComponent('צפו בסשן שלי ב-StudioSync! 🎛'), '_blank');
  closeShareRec();
}

// ── Rating modal ──────────────────────────────────────────
let currentRating = 0;
function showRatingModal() {
  currentRating = 0;
  const stars = document.getElementById('ratingStars');
  if (!stars) { show('landing'); return; }
  stars.innerHTML = '';
  for (let i = 1; i <= 5; i++) {
    const s = document.createElement('div');
    s.className = 'rating-star';
    s.textContent = '⭐';
    s.onclick = () => { currentRating = i; updateStars(); };
    stars.appendChild(s);
  }
  document.getElementById('ratingModal').style.display = 'flex';
}
function updateStars() {
  const stars = document.getElementById('ratingStars')?.children;
  if (!stars) return;
  for (let i = 0; i < stars.length; i++) stars[i].classList.toggle('lit', i < currentRating);
}
function submitRating() {
  if (currentRating > 0) {
    const history = JSON.parse(localStorage.getItem('ss_history') || '[]');
    if (history[0]) { history[0].rating = currentRating; localStorage.setItem('ss_history', JSON.stringify(history)); }
  }
  document.getElementById('ratingModal').style.display = 'none';
  show('landing');
}
function skipRating() {
  document.getElementById('ratingModal').style.display = 'none';
  show('landing');
}

// ── Tags ──────────────────────────────────────────────────
function addTag(idx, inputEl) {
  const tag = (inputEl?.value || '').trim();
  if (!tag) return;
  const history = JSON.parse(localStorage.getItem('ss_history') || '[]');
  if (!history[idx]) return;
  if (!history[idx].tags) history[idx].tags = [];
  if (history[idx].tags.length >= 5) { toast('מקסימום 5 תגיות', 'r'); return; }
  history[idx].tags.push(tag);
  localStorage.setItem('ss_history', JSON.stringify(history));
  inputEl.value = '';
  showHistory();
}

// ── Export CSV ─────────────────────────────────────────────
function exportHistoryCSV() {
  const history = JSON.parse(localStorage.getItem('ss_history') || '[]');
  if (!history.length) { toast('אין היסטוריה לייצוא', 'r'); return; }
  const rows = [['Date','Code','Duration (min)','Participants','Name','Tags','Rating']];
  history.forEach(h => rows.push([h.date, h.code, Math.floor((h.duration||0)/60), h.participants, h.name, (h.tags||[]).join(';'), h.rating||'']));
  const csv = rows.map(r => r.map(c => '"'+String(c).replace(/"/g,'""')+'"').join(',')).join('\\n');
  const blob = new Blob(['\\ufeff'+csv], {type:'text/csv;charset=utf-8'});
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
  a.download = 'studiosync-history.csv'; a.click();
  toast('קובץ CSV יורד...', 'g');
}

// ── Onboarding wizard ─────────────────────────────────────
let wizardStep = 0;
function showOnboarding() {
  wizardStep = 0;
  document.getElementById('onboardingWizard').style.display = 'flex';
  updateWizard();
}
function wizardNext() {
  if (wizardStep >= 2) { wizardDone(); return; }
  wizardStep++;
  updateWizard();
}
function wizardPrev() {
  if (wizardStep <= 0) return;
  wizardStep--;
  updateWizard();
}
function updateWizard() {
  for (let i = 0; i <= 2; i++) {
    document.getElementById('wizStep' + i).classList.toggle('active', i === wizardStep);
    document.getElementById('wizDot' + i).classList.toggle('active', i === wizardStep);
  }
  document.getElementById('wizPrev').style.display = wizardStep > 0 ? '' : 'none';
  document.getElementById('wizNext').textContent = wizardStep >= 2 ? 'בואו נתחיל!' : 'הבא';
}
function wizardDone() {
  document.getElementById('onboardingWizard').style.display = 'none';
  localStorage.setItem('ss_onboarded', '1');
}

// ── Help ──────────────────────────────────────────────────
function openHelp() {
  document.getElementById('helpOverlay').style.display = 'flex';
}
function closeHelp() {
  document.getElementById('helpOverlay').style.display = 'none';
  localStorage.setItem('ss_help_seen', '1');
}

// ── Online Indicator ──────────────────────────────────────
let heartbeatTimer = null;
function startHeartbeat() {
  const send = () => {
    const name = S.name || localStorage.getItem('ss_name');
    if (!name) return;
    fetch('/api/heartbeat', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ name, color: S.color, instrument: S.instrument }) }).catch(()=>{});
  };
  send();
  heartbeatTimer = setInterval(send, 30000);
}
function stopHeartbeat() { if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; } }
async function fetchOnline() {
  try {
    const r = await fetch('/api/online');
    const d = await r.json();
    if (!d.ok) return;
    const el = document.getElementById('onlineList');
    const sec = document.getElementById('onlineSection');
    if (!el || !sec) return;
    if (d.users.length === 0) { sec.style.display = 'none'; return; }
    sec.style.display = '';
    el.innerHTML = d.users.map(u => '<div class="online-avatar"><div class="online-dot" style="background:' + u.color + '"></div><span class="online-name">' + esc(u.name) + '</span>' + (u.instrument ? '<span class="online-instr">' + esc(u.instrument) + '</span>' : '') + '</div>').join('');
  } catch(e) {}
}
let onlineTimer = null;
function startOnlinePolling() { fetchOnline(); onlineTimer = setInterval(fetchOnline, 15000); }
function stopOnlinePolling() { if (onlineTimer) { clearInterval(onlineTimer); onlineTimer = null; } }

// ── Schedule Session ─────────────────────────────────────
function showScheduleModal() { document.getElementById('scheduleModal').style.display = 'flex'; }
function closeScheduleModal() { document.getElementById('scheduleModal').style.display = 'none'; }
function addSchedule() {
  const title = document.getElementById('schedTitle').value.trim();
  const date = document.getElementById('schedDate').value;
  const time = document.getElementById('schedTime').value;
  if (!title || !date || !time) { toast('נא למלא את כל השדות', 'r'); return; }
  const schedules = JSON.parse(localStorage.getItem('ss_schedules') || '[]');
  schedules.push({ title, date, time, ts: new Date(date + 'T' + time).getTime(), id: Date.now() });
  localStorage.setItem('ss_schedules', JSON.stringify(schedules));
  closeScheduleModal();
  document.getElementById('schedTitle').value = '';
  document.getElementById('schedDate').value = '';
  document.getElementById('schedTime').value = '';
  renderSchedules();
  toast('סשן תוזמן!', 'g');
}
function deleteSchedule(id) {
  let schedules = JSON.parse(localStorage.getItem('ss_schedules') || '[]');
  schedules = schedules.filter(s => s.id !== id);
  localStorage.setItem('ss_schedules', JSON.stringify(schedules));
  renderSchedules();
}
function renderSchedules() {
  const schedules = JSON.parse(localStorage.getItem('ss_schedules') || '[]');
  const now = Date.now();
  const upcoming = schedules.filter(s => s.ts > now).sort((a, b) => a.ts - b.ts);
  const sec = document.getElementById('scheduleSection');
  const el = document.getElementById('scheduleList');
  if (!sec || !el) return;
  if (upcoming.length === 0) { sec.style.display = 'none'; return; }
  sec.style.display = '';
  el.innerHTML = upcoming.map(s => {
    const d = new Date(s.ts);
    const dateStr = d.toLocaleDateString('he-IL', { day:'numeric', month:'short' });
    const timeStr = d.toLocaleTimeString('he-IL', { hour:'2-digit', minute:'2-digit' });
    return '<div class="sched-card"><span class="sched-del" onclick="deleteSchedule(' + s.id + ')">×</span><div class="sched-title">' + esc(s.title) + '</div><div class="sched-time">' + dateStr + ' | ' + timeStr + '</div></div>';
  }).join('');
}
function checkScheduleReminders() {
  const schedules = JSON.parse(localStorage.getItem('ss_schedules') || '[]');
  const now = Date.now();
  schedules.forEach(s => {
    const diff = s.ts - now;
    if (diff > 0 && diff < 60000 && !s.reminded) {
      s.reminded = true;
      toast('תזכורת: ' + s.title + ' מתחיל בעוד דקה!', 'g');
      if ('Notification' in window && Notification.permission === 'granted') {
        new Notification('StudioSync', { body: s.title + ' מתחיל בעוד דקה!' });
      }
    }
  });
  localStorage.setItem('ss_schedules', JSON.stringify(schedules));
}

// ── Feature Voting ───────────────────────────────────────
const votedFeatures = new Set(JSON.parse(localStorage.getItem('ss_voted') || '[]'));
async function loadFeatures() {
  try {
    const r = await fetch('/api/features');
    const d = await r.json();
    if (!d.ok) return;
    const el = document.getElementById('votingList');
    if (!el) return;
    el.innerHTML = d.features.map(f => {
      const voted = votedFeatures.has(f.id);
      return '<div class="vote-row"><span class="vote-name">' + esc(f.name) + '</span><span class="vote-count">' + f.votes + '</span><button class="vote-btn' + (voted ? ' voted' : '') + '" onclick="voteFeature(this,&#39;'+f.id+'&#39;)">' + (voted ? '✓' : '👍') + '</button></div>';
    }).join('');
  } catch(e) {}
}
async function voteFeature(btn, fid) {
  if (votedFeatures.has(fid)) return;
  const fp = S.name || 'user_' + Math.random().toString(36).slice(2, 8);
  try {
    const r = await fetch('/api/features/vote', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ featureId: fid, fingerprint: fp }) });
    const d = await r.json();
    if (d.ok) {
      votedFeatures.add(fid);
      localStorage.setItem('ss_voted', JSON.stringify([...votedFeatures]));
      loadFeatures();
    }
  } catch(e) {}
}

// ── Boot ──────────────────────────────────────────────────
window.onload = () => {
  initTheme();
  show('landing');
  startHeartbeat();
  startOnlinePolling();
  renderSchedules();
  loadFeatures();
  setInterval(checkScheduleReminders, 30000);
  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission();
  }
  // Auto-join if ?join=CODE in URL
  const params   = new URLSearchParams(window.location.search);
  const joinCode = params.get('join');
  if (joinCode) {
    showLobby('join');
    const inp = document.getElementById('joinCode');
    if (inp) inp.value = joinCode.toUpperCase().replace(/[^A-Z0-9]/g, c => c === '-' ? '-' : '');
  } else if (!localStorage.getItem('ss_onboarded')) {
    setTimeout(() => showOnboarding(), 600);
  }
};
</script>
</body>
</html>`;
