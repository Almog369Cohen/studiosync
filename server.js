const http  = require('http');
const https = require('https');
const os    = require('os');
const fs    = require('fs');
const path  = require('path');
const crypto = require('crypto');

// ── Load .env for local dev (in production Render supplies env vars directly) ──
try {
  const envPath = path.join(__dirname, '.env');
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq < 0) continue;
      const key = trimmed.slice(0, eq).trim();
      const val = trimmed.slice(eq + 1).trim();
      if (key && !process.env[key]) process.env[key] = val;
    }
  }
} catch (e) { /* .env optional */ }

// Optional: robotjs for remote mouse/keyboard control
let robot = null;
try { robot = require('robotjs'); } catch(e) { /* robotjs not available — remote control will be limited */ }

function mapKeyToRobot(webKey) {
  const map = {
    ' ': 'space', Enter: 'enter', Escape: 'escape', Tab: 'tab',
    Backspace: 'backspace', Delete: 'delete',
    ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
    Home: 'home', End: 'end', PageUp: 'pageup', PageDown: 'pagedown',
    F1:'f1',F2:'f2',F3:'f3',F4:'f4',F5:'f5',F6:'f6',F7:'f7',F8:'f8',F9:'f9',F10:'f10',F11:'f11',F12:'f12',
    Control: 'control', Shift: 'shift', Alt: 'alt', Meta: 'command',
  };
  if (map[webKey]) return map[webKey];
  if (webKey.length === 1) return webKey.toLowerCase();
  return null;
}

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

function httpsRequest(url, opts, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname, path: u.pathname + u.search, port: u.port || 443,
      method: opts.method || 'GET', headers: opts.headers || {}
    }, resp => {
      const chunks = [];
      resp.on('data', c => chunks.push(c));
      resp.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (resp.statusCode >= 200 && resp.statusCode < 300) resolve(text);
        else reject(new Error('HTTP ' + resp.statusCode + ': ' + text.slice(0, 200)));
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// ── Cleanup stale clients every 30s ──────────────────────
setInterval(() => {
  const now = Date.now();
  for (const [id, c] of clients) {
    if (now - c.seen > 90000) {
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
    // Allow reusing a specific code (auto-rejoin after server restart) if it's free.
    const requested = typeof data.code === 'string' ? data.code.toUpperCase().trim() : null;
    const code = (requested && /^[A-Z0-9]{3}-[A-Z0-9]{3}$/.test(requested) && !sessions.has(requested))
      ? requested : genCode();
    const name = data.name || 'Producer';
    const color = data.color || '#6c47ff';
    const instrument = data.instrument || 'Producer';
    const mode = (data.mode === 'lecture') ? 'lecture' : 'collab';
    clients.set(id, { code, name, color, instrument, res: null, seen: Date.now() });
    queues.set(id, []);
    sessions.set(code, { peers: new Set([id]), daw: data.daw, created: Date.now(), licensed, password: data.password || null, mode, hostId: id });
    console.log('[+] Session created:', code, licensed ? '(PRO)' : '(trial)', data.password ? '(password)' : '', 'mode=' + mode);
    return json(res, { ok: true, code, clientId: id, peerNumber: 1, plan: licensed ? 'pro' : 'trial', mode });
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
    // Lecture mode gets a much bigger cap since traffic is mostly one-way from the lecturer
    const isLecture = sess.mode === 'lecture';
    const maxPeers = isLecture ? 30 : (isProSession ? 10 : 3);
    if (sess.peers.size >= maxPeers) return json(res, { ok: false,
      error: isLecture ? 'ההרצאה מלאה (עד 30 תלמידים)' :
             isProSession ? 'הסשן מלא (עד 10 משתתפים)' :
             'הסשן החינמי מלא (עד 3). שדרג ל-Pro עבור 10 משתתפים.' }, 403);

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
    const isAgent    = !!data.isAgent;

    clients.set(id, { code, name, color, instrument, res: null, seen: Date.now(), isAgent });
    queues.set(id, []);
    sess.peers.add(id);

    // Collect existing peers info for the welcome message
    const existingPeers = [];
    for (const pid of sess.peers) {
      if (pid === id) continue;
      const pc = clients.get(pid);
      if (pc) existingPeers.push({ id: pid, name: pc.name, color: pc.color, instrument: pc.instrument });
    }

    // Send welcome to joiner with list of existing peers + session mode
    push(id, { type: 'session:welcome', peers: existingPeers, code, mode: sess.mode || 'collab' });

    // Tell ALL existing peers to create an offer to the new joiner
    for (const pid of sess.peers) {
      if (pid === id) continue;
      push(pid, { type: 'webrtc:create-offer', peerId: id, name, color, instrument });
      push(pid, { type: 'peer:joined', peerId: id, name, color, instrument, role: data.role || 'participant' });
    }

    console.log('[+] Joined:', name, '->', code, '(peer', sess.peers.size, ') mode=' + (sess.mode || 'collab'));
    return json(res, { ok: true, code, clientId: id, peerNumber: sess.peers.size, mode: sess.mode || 'collab' });
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

  // ── Local input execution (robotjs) ──
  if (path === '/api/local-input' && req.method === 'POST') {
    const data = await body(req);
    if (!robot) return json(res, { ok: false, error: 'robotjs not available' });
    try {
      const screenSize = robot.getScreenSize();
      if (data.input === 'mouse') {
        const x = Math.round(data.x * screenSize.width);
        const y = Math.round(data.y * screenSize.height);
        if (data.action === 'move') robot.moveMouse(x, y);
        else if (data.action === 'click') { robot.moveMouse(x, y); robot.mouseClick(data.button === 2 ? 'right' : 'left'); }
      } else if (data.input === 'keyboard') {
        const key = mapKeyToRobot(data.key);
        if (key) {
          if (data.action === 'keydown') robot.keyToggle(key, 'down');
          else if (data.action === 'keyup') robot.keyToggle(key, 'up');
        }
      }
      return json(res, { ok: true });
    } catch(e) { return json(res, { ok: false, error: e.message }); }
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

  // ── Public runtime config (Google Client ID is public by design) ──
  if (path === '/api/config' && req.method === 'GET') {
    return json(res, {
      ok: true,
      googleClientId: process.env.GDRIVE_CLIENT_ID || '',
      driveEnabled: !!process.env.GDRIVE_CLIENT_ID,
      transcribeEnabled: !!(process.env.OPENAI_API_KEY || process.env.ELEVENLABS_API_KEY),
      transcribeProvider: process.env.ELEVENLABS_API_KEY ? 'elevenlabs' : (process.env.OPENAI_API_KEY ? 'openai' : null)
    });
  }

  // ── Transcription proxy — receives audio blob, calls STT provider ──
  if (path === '/api/transcribe' && req.method === 'POST') {
    const provider = process.env.ELEVENLABS_API_KEY ? 'elevenlabs'
                    : process.env.OPENAI_API_KEY ? 'openai' : null;
    if (!provider) return json(res, { ok:false, error:'no_transcription_key',
      message:'הוסף OPENAI_API_KEY או ELEVENLABS_API_KEY למשתני הסביבה' }, 501);

    // Buffer the raw body (browser sends multipart with the audio blob directly)
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const rawBody = Buffer.concat(chunks);
    const contentType = req.headers['content-type'] || 'audio/webm';

    try {
      if (provider === 'openai') {
        // Rebuild as OpenAI multipart with model=whisper-1
        const boundary = '----ss' + Math.random().toString(36).slice(2);
        const CRLF = '\r\n';
        const filePart = Buffer.from(
          '--' + boundary + CRLF +
          'Content-Disposition: form-data; name="file"; filename="audio.webm"' + CRLF +
          'Content-Type: audio/webm' + CRLF + CRLF, 'utf8');
        const modelPart = Buffer.from(
          CRLF + '--' + boundary + CRLF +
          'Content-Disposition: form-data; name="model"' + CRLF + CRLF + 'whisper-1', 'utf8');
        const endPart = Buffer.from(CRLF + '--' + boundary + '--' + CRLF, 'utf8');
        const body = Buffer.concat([filePart, rawBody, modelPart, endPart]);

        const result = await httpsRequest('https://api.openai.com/v1/audio/transcriptions', {
          method: 'POST',
          headers: {
            'Authorization': 'Bearer ' + process.env.OPENAI_API_KEY,
            'Content-Type': 'multipart/form-data; boundary=' + boundary,
            'Content-Length': body.length
          }
        }, body);
        const parsed = JSON.parse(result);
        return json(res, { ok:true, provider:'openai', text: parsed.text || '' });
      } else {
        // ElevenLabs STT — send audio directly with model_id as a query/form field
        const boundary = '----ss' + Math.random().toString(36).slice(2);
        const CRLF = '\r\n';
        const filePart = Buffer.from(
          '--' + boundary + CRLF +
          'Content-Disposition: form-data; name="file"; filename="audio.webm"' + CRLF +
          'Content-Type: audio/webm' + CRLF + CRLF, 'utf8');
        const modelPart = Buffer.from(
          CRLF + '--' + boundary + CRLF +
          'Content-Disposition: form-data; name="model_id"' + CRLF + CRLF + 'scribe_v1', 'utf8');
        const endPart = Buffer.from(CRLF + '--' + boundary + '--' + CRLF, 'utf8');
        const body = Buffer.concat([filePart, rawBody, modelPart, endPart]);

        const result = await httpsRequest('https://api.elevenlabs.io/v1/speech-to-text', {
          method: 'POST',
          headers: {
            'xi-api-key': process.env.ELEVENLABS_API_KEY,
            'Content-Type': 'multipart/form-data; boundary=' + boundary,
            'Content-Length': body.length
          }
        }, body);
        const parsed = JSON.parse(result);
        return json(res, { ok:true, provider:'elevenlabs', text: parsed.text || '' });
      }
    } catch (e) {
      return json(res, { ok:false, error:'stt_failed', message: e.message }, 500);
    }
  }

  // ── Session health (Agent connection + peer count) ──
  if (path === '/api/health' && req.method === 'GET') {
    const code = url.searchParams.get('code');
    if (!code) return json(res, { ok:false, error:'no_code' }, 400);
    const sess = sessions.get(code);
    if (!sess) return json(res, { ok:true, agent:false, agentSeen:0, peers:0 });
    let agentSeen = 0;
    let peers = 0;
    const now = Date.now();
    for (const pid of sess.peers) {
      const c = clients.get(pid);
      if (!c) continue;
      if (c.isAgent) agentSeen = Math.max(agentSeen, c.seen);
      else peers++;
    }
    return json(res, { ok:true, agent: (now - agentSeen) < 15000, agentSeen, peers });
  }

  // ── Heartbeat (online indicator + session keepalive) ──
  if (path === '/api/heartbeat' && req.method === 'POST') {
    const data = await body(req);
    if (data.name) onlineUsers.set(data.name, { name: data.name, color: data.color || '#6c47ff', instrument: data.instrument || '', ts: Date.now() });
    // Also refresh session client's seen timestamp so eviction doesn't fire during long polls / background tabs
    if (data.cid) {
      const c = clients.get(data.cid);
      if (c) c.seen = Date.now();
    }
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

// ── Keep-alive: prevent Render free tier cold starts ──────
setInterval(() => {
  const url = APP_URL + '/api/ice';
  https.get(url, () => {}).on('error', () => {});
}, 13 * 60 * 1000); // every 13 minutes

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
.mode-picker { display:grid; grid-template-columns:1fr 1fr; gap:8px; margin-bottom:14px; }
.mode-btn { display:flex; flex-direction:column; align-items:center; gap:4px; padding:10px 8px; background:var(--s1); border:1.5px solid var(--b1); border-radius:var(--radius); cursor:pointer; transition:all .15s; font-family:var(--sans); }
.mode-btn:hover { border-color:var(--accent); background:var(--bg); }
.mode-btn.active { border-color:var(--accent); background:rgba(108,71,255,.1); }
.mode-ico { font-size:20px; }
.mode-name { font-size:13px; font-weight:600; color:var(--txt); }
.mode-desc { font-size:10px; color:var(--dim); }
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
.peer-avatar { width:28px; height:28px; border-radius:50%; border:2px solid var(--bg); display:flex; align-items:center; justify-content:center; font-size:11px; font-weight:700; color:#fff; cursor:default; margin-left:-6px; transition:box-shadow .1s ease-out, transform .1s ease-out; }
.peer-avatar.speaking { box-shadow:0 0 0 3px #03b28c, 0 0 12px rgba(3,178,140,.6); transform:scale(1.08); }
.peer-avatar.speaking-loud { box-shadow:0 0 0 4px #03b28c, 0 0 18px rgba(3,178,140,.9); transform:scale(1.15); }
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

/* ── Multi-stream container ───────────────────────── */
.stream-container { display:flex; width:100%; height:100%; gap:6px; }
.stream-main { flex:1; position:relative; background:#000; border-radius:var(--radiusL); overflow:hidden; min-height:0; }
.stream-main video { width:100%; height:100%; object-fit:contain; }
.stream-main .stream-label { position:absolute; top:8px; left:8px; padding:2px 8px; font-size:11px; background:rgba(0,0,0,.65); color:#fff; border-radius:4px; pointer-events:none; }
.stream-thumbs { width:150px; display:flex; flex-direction:column; gap:6px; padding:4px; overflow-y:auto; flex-shrink:0; }
.stream-thumb { position:relative; border-radius:8px; overflow:hidden; cursor:pointer; border:2px solid var(--b1); aspect-ratio:16/9; background:#000; transition:border-color .2s, opacity .2s, transform .2s; }
.stream-thumb:hover { border-color:var(--mid); }
.stream-thumb.active { border-color:var(--accent); box-shadow:0 0 0 1px var(--accent); }
.stream-thumb video { width:100%; height:100%; object-fit:cover; pointer-events:none; }
.stream-thumb .stream-label { position:absolute; bottom:0; left:0; right:0; padding:2px 6px; font-size:10px; background:rgba(0,0,0,.7); color:#fff; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.stream-thumb.dragging { opacity:.4; transform:scale(.95); }
/* Grid mode */
.stream-container.grid-mode .stream-main { display:none; }
.stream-container.grid-mode .stream-thumbs { width:100%; flex-direction:row; flex-wrap:wrap; padding:8px; gap:8px; overflow-y:auto; }
.stream-container.grid-mode .stream-thumb { flex:1 1 calc(50% - 8px); min-width:200px; max-height:none; aspect-ratio:16/9; border-radius:var(--radiusL); }
.stream-container.grid-mode .stream-thumb video { object-fit:contain; }
.stream-container.grid-mode .stream-thumb .stream-label { font-size:12px; padding:4px 8px; }
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
#pianoWrap { position:fixed; bottom:56px; left:0; right:0; background:var(--bg); border-top:1px solid var(--b1); z-index:48; display:none; flex-direction:column; box-shadow:0 -4px 16px rgba(0,0,0,.15); }
#pianoWrap.open { display:flex; }
.pk-w.on, .pk-b.on { transition:background .05s; }
.piano-size-picker { display:flex; gap:2px; background:var(--s1); border:1px solid var(--b1); border-radius:6px; padding:2px; }
.piano-size-btn { font-size:11px; padding:3px 10px; border:none; background:none; color:var(--mid); border-radius:4px; cursor:pointer; font-family:var(--sans); }
.piano-size-btn:hover { color:var(--fg); }
.piano-size-btn.active { background:var(--accent); color:#fff; font-weight:600; }
.pk-w[data-peer], .pk-b[data-peer] { position:relative; }
.pk-w[data-peer]::after, .pk-b[data-peer]::after {
  content:attr(data-peer); position:absolute; top:2px; left:50%; transform:translateX(-50%);
  font-size:9px; font-weight:700; color:#fff; background:rgba(0,0,0,.5); padding:1px 4px; border-radius:8px;
  pointer-events:none; white-space:nowrap; max-width:90%; overflow:hidden; text-overflow:ellipsis;
}
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
.latency-pill { background:var(--s1); border:1px solid var(--b1); border-radius:100px; padding:3px 10px; font-size:11px; font-family:var(--mono); color:var(--mid); }
.midi-pill { background:var(--s1); border:1px solid var(--b1); border-radius:100px; padding:3px 10px; font-size:11px; color:var(--mid); cursor:pointer; user-select:none; transition:all .15s; }
.midi-pill:hover { border-color:var(--accent); color:var(--fg); }
.midi-pill.connected { border-color:#03b28c; color:#03b28c; }
.midi-pill.playing { background:rgba(3,178,140,.15); border-color:#03b28c; color:#03b28c; box-shadow:0 0 8px rgba(3,178,140,.4); }
#kbdMidiBtn { font-family:var(--mono); font-size:10px; letter-spacing:1px; padding:6px 8px; opacity:.6; }
#kbdMidiBtn.active { background:rgba(3,178,140,.15); border-color:#03b28c; color:#03b28c; opacity:1; box-shadow:0 0 8px rgba(3,178,140,.3); }
#raiseHandBtn.active { background:rgba(247,144,9,.15); border-color:#f79009; color:#f79009; animation:handWave .8s ease-in-out infinite; }
@keyframes handWave { 0%,100% { transform:rotate(-6deg); } 50% { transform:rotate(6deg); } }
/* Lecture-mode: hide sharing controls for students */
.is-student .share-btn, .is-student .cam-btn, .is-student .share-audio-btn { display:none !important; }
.is-student .my-controls { display:none !important; }
/* Class control panel */
.cc-list { max-height:340px; overflow-y:auto; display:flex; flex-direction:column; gap:6px; }
.cc-row { display:flex; align-items:center; gap:8px; padding:8px 10px; background:var(--s1); border:1px solid var(--b1); border-radius:8px; }
.cc-name { flex:1; font-size:13px; font-weight:500; }
.cc-toggles { display:flex; gap:4px; }
.cc-toggle { width:30px; height:30px; border:1px solid var(--b1); background:none; border-radius:6px; font-size:14px; cursor:pointer; transition:all .15s; }
.cc-toggle:hover { border-color:var(--accent); }
.cc-toggle.on { background:rgba(3,178,140,.15); border-color:#03b28c; }
.agent-pill { background:var(--s1); border:1px solid var(--b1); border-radius:100px; padding:3px 10px; font-size:11px; color:var(--dim); font-family:var(--sans); transition:all .2s; }
.agent-pill.connected { border-color:#03b28c; color:#03b28c; background:rgba(3,178,140,.08); }
.agent-pill.disconnected { border-color:#f04438; color:#f04438; background:rgba(240,68,56,.08); animation:agentBlink 1.4s ease-in-out infinite; }
@keyframes agentBlink { 0%,100% { opacity:.7; } 50% { opacity:1; } }
/* Click-to-control hint overlay on the shared video */
.remote-hint { position:absolute; inset:0; display:flex; align-items:center; justify-content:center; pointer-events:none;
  background:rgba(0,0,0,.15); color:#fff; font-size:14px; font-weight:600; text-shadow:0 2px 6px rgba(0,0,0,.6);
  opacity:0; transition:opacity .3s; z-index:5; }
.stream-thumb:hover .remote-hint, .main-video-wrap:hover .remote-hint { opacity:1; }
.remote-hint-inner { background:rgba(0,0,0,.6); padding:8px 16px; border-radius:100px; }
.share-btn { width:auto; padding:0 14px; font-size:13px; font-family:var(--sans); white-space:nowrap; }
.cam-btn { width:auto; padding:0 14px; font-size:13px; font-family:var(--sans); white-space:nowrap; }
.active-share { border:2px solid var(--accent) !important; background:rgba(0,255,136,.15) !important; }
.muted-state { border:2px solid var(--rD) !important; background:rgba(255,60,60,.15) !important; color:var(--red) !important; }
.recording { border:2px solid var(--rD) !important; background:rgba(255,60,60,.2) !important; animation:rec-pulse 1s ease infinite; }
@keyframes rec-pulse { 0%,100%{opacity:1} 50%{opacity:.6} }
.active-tool { border-color:var(--accent) !important; color:var(--accent) !important; }
.tb-group-sep { width:1px; height:24px; background:var(--b1); margin:0 4px; flex-shrink:0; }
.is-guest .host-only { display:none !important; }
.guest-only { display:none !important; }
.is-guest .guest-only { display:flex !important; }
.share-audio-btn { width:auto; padding:0 10px; font-size:12px; font-family:var(--sans); white-space:nowrap; }
.rec-btn-transport { width:auto; padding:0 10px; font-size:12px; font-family:var(--sans); white-space:nowrap; }

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
  .stream-container { flex-direction:column; }
  .stream-thumbs { width:100%; flex-direction:row; height:80px; overflow-x:auto; overflow-y:hidden; flex-shrink:0; }
  .stream-thumb { min-width:110px; height:70px; flex-shrink:0; aspect-ratio:auto; }
  .stream-container.grid-mode .stream-thumbs { height:auto; flex-direction:row; flex-wrap:wrap; overflow-y:auto; overflow-x:hidden; }
  .stream-container.grid-mode .stream-thumb { flex:1 1 100%; min-width:unset; height:auto; flex-shrink:1; aspect-ratio:16/9; }

  .transport-bar { height:auto; min-height:40px; flex-wrap:wrap; gap:2px; padding:4px 6px; position:relative; }
  .transport-bar .tc { width:28px; height:28px; font-size:12px; }
  .my-controls { order:20; width:100%; justify-content:center; padding-top:2px; gap:4px; }
  .my-controls .my-ctrl-btn { font-size:11px; padding:3px 8px; }
  .tb-group-sep { display:none; }
  .latency-pill { order:12; font-size:10px; padding:2px 6px; }

  #pianoWrap { bottom:90px; }
  .piano-keys { padding:4px 8px 0; }
  .pk-w { width:26px; height:60px; }
  .pk-b { width:18px; height:38px; margin:0 -9px; }

  /* Mobile: compact action buttons */
  .transport-bar .share-btn, .transport-bar .cam-btn { width:auto; padding:0 8px; font-size:11px; height:28px; }
  .transport-bar .share-audio-btn { width:auto; padding:0 6px; font-size:11px; height:28px; }
  .transport-bar .rec-btn-transport { width:auto; padding:0 6px; font-size:10px; height:28px; }

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
      <input id="createPassword" placeholder="סיסמה (אופציונלי)" type="password" class="lob-input" dir="rtl" />
      <div class="color-picker" id="createColors" style="display:none"></div>
      <div class="instr-grid" id="createInstrs" style="display:none"></div>
      <div class="mode-picker" dir="rtl">
        <button class="mode-btn active" data-mode="collab" onclick="selectMode('collab')">
          <span class="mode-ico">🤝</span>
          <span class="mode-name">משותף</span>
          <span class="mode-desc">כולם שווים · עד 10</span>
        </button>
        <button class="mode-btn" data-mode="lecture" onclick="selectMode('lecture')">
          <span class="mode-ico">🎓</span>
          <span class="mode-name">הרצאה</span>
          <span class="mode-desc">מרצה שולט · עד 30</span>
        </button>
      </div>
      <button class="btn-accent btn-full" onclick="hostStart()">צור סשן</button>
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
      <div class="color-picker" id="joinColors" style="display:none"></div>
      <div class="instr-grid" id="joinInstrs" style="display:none"></div>
      <input id="joinCode" placeholder="ABC-123" class="lob-input code-input" dir="ltr" />
      <input id="joinPassword" placeholder="סיסמה (אם נדרשת)" type="password" class="lob-input" dir="rtl" />
      <button class="btn-accent btn-full" onclick="remoteJoin()">הצטרף</button>
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
    <div class="tb-status" id="tbStatus">0 peers</div>
    <button class="tb-btn tb-invite-btn" onclick="openInvite()">📨 הזמן</button>
    <button class="tb-btn tb-leave" onclick="leaveSession()">עזוב</button>
  </div>

  <!-- Workspace -->
  <div class="workspace">
    <!-- Main: shared screen video(s) -->
    <div class="main-area" id="mainArea">
      <div class="stream-container" id="streamContainer">
        <div class="stream-main" id="streamMain"></div>
        <div class="stream-thumbs" id="streamThumbs"></div>
      </div>
      <div class="main-area-empty" id="mainEmpty" dir="rtl">
        <div class="main-area-empty-icon">🖥</div>
        <div class="main-area-empty-text">ממתין לשיתוף מסך...</div>
        <div class="main-area-empty-sub">לחץ על <b>"שתף מסך"</b> בסרגל למטה כדי לשתף את מסך ה-DAW והשמע.</div>
        <button class="btn-ghost" style="margin-top:12px;font-size:13px" onclick="doShareCam()">📷 או שתף מצלמה</button>
      </div>
    </div>

    <!-- Right: participants + chat -->
    <div class="participant-panel">
      <div class="panel-tabs">
        <button class="ptab active" id="tabPeers" onclick="switchTab('peers')">משתתפים</button>
        <button class="ptab" id="tabChat" onclick="switchTab('chat')">צ'אט</button>
      </div>
      <div id="peersTab" class="tab-content">
        <div id="peerList"></div>
      </div>
      <div id="chatTab" class="tab-content" style="display:none">
        <div id="chatArea"></div>
        <div class="chat-input-row">
          <input id="chatIn" placeholder="כתוב הודעה..." dir="rtl" onkeydown="if(event.key==='Enter')sendChat()" />
          <button onclick="sendChat()">↑</button>
        </div>
      </div>
    </div>
  </div>

  <div class="transport-bar">
    <!-- Mute — everyone -->
    <button class="tc" id="muteBtn" onclick="toggleSelfMute()" title="השתק">🎤</button>
    <div class="tb-group-sep"></div>
    <!-- Sharing — everyone -->
    <button class="tc share-btn" id="shareBtn" onclick="doShare()">🖥 שתף מסך</button>
    <button class="tc cam-btn" id="camBtn" onclick="doShareCam()">📷 מצלמה</button>
    <button class="tc share-audio-btn host-only" id="shareAudioBtn" onclick="doShareAudio()" title="שתף שמע בלבד">🔊 שתף שמע</button>
    <div class="tb-group-sep"></div>
    <!-- Remote Controls — guest only (host doesn't send remote:input to self) -->
    <div class="my-controls guest-only" id="myControls" title="שליטה מרחוק">
      <span class="my-ctrl-btn" id="myMouse" onclick="toggleMyCtrl('mouse')">🖱 עכבר</span>
      <span class="my-ctrl-btn" id="myKeys" onclick="toggleMyCtrl('keyboard')">⌨ מקלדת</span>
    </div>
    <div class="tb-flex"></div>
    <!-- Tools -->
    <button class="tc rec-btn-transport host-only" id="recSessionBtn" onclick="toggleSessionRecord()">⏺ הקלט</button>
    <button class="tc host-only" id="addScreenBtn" onclick="addAnotherScreen()" title="הוסף מסך נוסף (עד 3 מוניטורים)">＋ מסך</button>
    <button class="tc" id="viewToggle" onclick="toggleStreamView()" title="תצוגת גריד">⊞</button>
    <button class="tc" id="fullscreenBtn" onclick="toggleFullscreen()" title="מסך מלא">⛶</button>
    <button class="tc" id="raiseHandBtn" onclick="toggleRaiseHand()" title="הרם יד לבקש רשות דיבור" style="display:none">✋ הרם יד</button>
    <button class="tc" id="classCtrlBtn" onclick="showClassControl()" title="שליטת הרצאה" style="display:none">🎓 כיתה</button>
    <button class="tc" id="pianoBtn" onclick="togglePiano()" title="פסנתר משותף">🎹 פסנתר</button>
    <button class="tc" id="kbdMidiBtn" onclick="toggleKbdMidi()" title="לחץ M להפעיל מקלדת כ-MIDI">ASDF</button>
    <button class="tc host-only" id="healthBtn" onclick="showHealthCheck()" title="בדוק שהמערכת מוכנה לסשן">🩺</button>
    <div class="agent-pill host-only" id="agentPill" title="סטטוס Agent (שליטה מרחוק + MIDI)">🤖 —</div>
    <div class="midi-pill" id="midiPill" onclick="reinitWebMidi()" title="Web MIDI keyboard">🎹 —</div>
    <div class="latency-pill" id="latPill">-- ms</div>
  </div>

  <!-- Shared Piano — visible to all participants -->
  <div id="pianoWrap">
    <div class="piano-header">
      <span class="piano-header-label">🎹 פסנתר משותף — לחץ על הקלידים או השתמש במקלדת (M להפעלה)</span>
      <div class="piano-size-picker">
        <button class="piano-size-btn" data-size="2" onclick="setPianoSize(2)">קומפקטי</button>
        <button class="piano-size-btn" data-size="4" onclick="setPianoSize(4)">בינוני</button>
        <button class="piano-size-btn" data-size="7" onclick="setPianoSize(7)">מלא</button>
      </div>
      <button class="piano-oct" onclick="pianoOctave(-1)">◀ אוקטבה</button>
      <span id="pianoOctLbl" style="font-size:11px;color:var(--mid);min-width:28px;text-align:center">C4</span>
      <button class="piano-oct" onclick="pianoOctave(1)">אוקטבה ▶</button>
      <button class="piano-close" onclick="togglePiano()" title="סגור">✕</button>
    </div>
    <div class="piano-keys" id="pianoKeys"></div>
  </div>
</div>

<!-- Settings (hidden - kept for JS compatibility) -->
<div id="settingsOverlay" style="display:none"></div>

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
  mode: 'collab',      // 'collab' | 'lecture'
  handsRaised: new Set(), // peerIds who raised a hand (host view only)
  stageMode: false,
  stageHolder: null, // peerId of who is on stage
  lastNudge: 0,
  tapTimes: [],
  metro: false, metroInterval: null, metroBeat: 0,
  clips: [],
  connectedAt: null,
  analyserIn: null, analyserOut: null, vuAnim: null,
  streams: new Map(),    // peerId → { stream, type:'screen'|'camera'|'audio', name }
  focusedStream: null,   // peerId of focused stream in thumbnail mode
  selfMuted: false
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
function selectMode(mode) {
  S.mode = (mode === 'lecture') ? 'lecture' : 'collab';
  document.querySelectorAll('.mode-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === S.mode));
}

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
      body: JSON.stringify({ name: S.name, color: S.color, instrument: S.instrument, daw: 'Ableton', mode: S.mode || 'collab', fingerprint: getFingerprint(), password: (document.getElementById('createPassword')?.value || '').trim() || undefined })
    });
    const d = await r.json();
    if (!d.ok) { toast('Error: ' + d.error, 'r'); show('lobby'); return; }
    S.cid = d.clientId;
    S.code = d.code;
    S.peerNumber = d.peerNumber || 1;
    S.plan = d.plan || 'trial';
    S.mode = d.mode || S.mode || 'collab';
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
    S.mode = d.mode || 'collab';
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
  // Auto-assign a distinct color per peer position since we no longer show a color picker.
  S.color = PEER_COLORS[((S.peerNumber || 1) - 1) % PEER_COLORS.length];
  document.getElementById('codeDisplay').textContent = S.code;
  const spCode = document.getElementById('spCode');
  if (spCode) spCode.textContent = S.code;
  updatePeerAvatars();
  renderPeerList();
  show('session');
  startPoll();
  startTimer();
  initWebMidi();
  startAgentStatusPoll();
  applySessionMode();
  // (Recording is free for MMP — no lock)
  // Role-based UI: hide host-only controls for guests
  if (S.peerNumber === 1) {
    document.body.classList.remove('is-guest');
  } else {
    document.body.classList.add('is-guest');
  }
  // Listener mode — hide transport controls entirely
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
  } else {
    // Desktop defaults are ON — reflect that on the toggle buttons
    if (MY.mouse) document.getElementById('myMouse')?.classList.add('active');
    if (MY.keyboard) document.getElementById('myKeys')?.classList.add('active');
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
  // Notify server immediately so peers see instant disconnect
  if (S.cid) {
    send({ type: 'peer:left', peerId: S.cid, name: S.name });
    broadcast({ type: 'peer:left', peerId: S.cid, name: S.name });
  }
  saveHistory();
  stopTimer();
  stopAgentStatusPoll();
  if (isRecording && isRecording()) stopSessionRecord();
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
  document.body.classList.remove('is-guest');
  show('landing');
  showRatingModal();
}

// ── Polling with reconnection ─────────────────────────────
async function tryAutoRejoin() {
  // Server forgot us (redeploy, eviction, network gap). Attempt silent rejoin with same code+name.
  if (!S.code || !S.name) return false;
  try {
    const wasHost = S.peerNumber === 1;
    // Try recreate first if we were the host — brings the room back online.
    if (wasHost) {
      const r = await fetch(SERVER + '/api/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: S.name, color: S.color, instrument: S.instrument, daw: 'Ableton',
          fingerprint: getFingerprint(), code: S.code })
      });
      const d = await r.json();
      if (d.ok) { S.cid = d.clientId; return true; }
    }
    // Rejoin as guest
    const raw = S.code.replace(/[^A-Z0-9]/gi, '').toUpperCase();
    const code = raw.slice(0, 3) + '-' + raw.slice(3);
    const r = await fetch(SERVER + '/api/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, name: S.name, color: S.color, instrument: S.instrument,
        fingerprint: getFingerprint() })
    });
    const d = await r.json();
    if (d.ok) { S.cid = d.clientId; return true; }
    return false;
  } catch (e) { return false; }
}

async function startPoll() {
  S.poll = true;
  let fails = 0;
  let rejoinAttempts = 0;
  while (S.poll) {
    try {
      const r = await fetch(SERVER + '/api/poll?cid=' + S.cid, { signal: AbortSignal.timeout(30000) });
      if (!r.ok) {
        if (r.status === 404) {
          // Try silent auto-rejoin (server likely restarted or evicted us)
          if (rejoinAttempts < 3) {
            rejoinAttempts++;
            if (rejoinAttempts === 1) showBanner('מתחבר מחדש...', 'warn');
            const ok = await tryAutoRejoin();
            if (ok) {
              showBanner('חובר מחדש', 'ok');
              rejoinAttempts = 0;
              continue;
            }
            await new Promise(r => setTimeout(r, 2000 * rejoinAttempts));
            continue;
          }
          showBanner('הסשן פג — נא להצטרף מחדש', 'err');
          leaveSession();
          return;
        }
        fails++;
        if (fails >= 3) showBanner('Connection issues — reconnecting...', 'warn');
        await new Promise(r => setTimeout(r, Math.min(2000 * fails, 10000)));
        continue;
      }
      if (fails > 0 || rejoinAttempts > 0) { showBanner('חובר', 'ok'); fails = 0; rejoinAttempts = 0; }
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
    startAdaptiveBitrate(pc, peerId);
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
      startAdaptiveBitrate(pc, peerId);
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
  if (msg.type === 'remote:input') handleMsg(msg);
}

// ── Message router ────────────────────────────────────────
function handleMsg(msg) {
  switch (msg.type) {
    case 'session:welcome':
      S.connectedAt = Date.now();
      S.mode = msg.mode || S.mode || 'collab';
      for (const p of (msg.peers || [])) {
        S.peers.set(p.id, { name: p.name, color: p.color, instrument: p.instrument, dc: null, conn: null, latency: 0, perms: { mouse:true, keyboard:true, midi:true } });
      }
      applySessionMode();
      updatePeerAvatars(); renderPeerList();
      break;
    case 'peer:joined':
      S.peers.set(msg.peerId, { name: msg.name, color: msg.color, instrument: msg.instrument, dc: null, conn: null, latency: 0, role: msg.role || 'participant', muted: false, perms: { mouse:true, keyboard:true, midi:true } });
      updatePeerAvatars(); renderPeerList();
      if (!S.dnd) { playJoinSound(); toast(msg.name + ' הצטרף/ה', 'g'); }
      break;
    case 'peer:left': {
      const lp = S.peers.get(msg.peerId);
      if (lp) {
        const card = document.querySelector('[data-peer="' + msg.peerId + '"]');
        S.streams.delete(msg.peerId); S.streams.delete(msg.peerId + ':cam'); renderStreams();
        if (card) { card.classList.add('leaving'); setTimeout(() => { lp?.conn?.close(); S.peers.delete(msg.peerId); updatePeerAvatars(); renderPeerList(); }, 300); }
        else { lp.conn?.close(); S.peers.delete(msg.peerId); updatePeerAvatars(); renderPeerList(); }
      }
      S.handsRaised.delete(msg.peerId);
      voiceDetach(msg.peerId);
      if (!S.dnd) { playLeaveSound(); toast((msg.name || 'Peer') + ' עזב/ה', ''); }
      break;
    }
    // ── Lecture-mode messages ──
    case 'hand:raise':
      if (isLecturer()) {
        S.handsRaised.add(msg.from);
        toast('✋ ' + (msg.fromName || 'תלמיד') + ' הרים יד', 'g');
        // Refresh open control panel if visible
        if (document.getElementById('ccBackdrop')) showClassControl();
      }
      break;
    case 'hand:lower':
      if (isLecturer()) {
        S.handsRaised.delete(msg.from);
        if (document.getElementById('ccBackdrop')) showClassControl();
      }
      break;
    case 'class:perm':
      if (msg.targetId === S.cid) {
        // Lecturer granted/revoked a permission for me
        if (msg.perm === 'mic') {
          S.selfMuted = !msg.value;
          if (S.micStream) S.micStream.getAudioTracks().forEach(t => t.enabled = msg.value);
          for (const [, p] of S.peers) p.conn?.getSenders()?.forEach(s => { if (s.track?.kind === 'audio') s.track.enabled = msg.value; });
          const btn = document.getElementById('muteBtn');
          if (btn) { btn.textContent = msg.value ? '🎤' : '🔇'; btn.classList.toggle('muted-state', !msg.value); }
        } else if (MY.hasOwnProperty(msg.perm)) {
          MY[msg.perm] = !!msg.value;
        }
        toast('המרצה ' + (msg.value ? 'פתח' : 'סגר') + ' לך ' +
          ({ mic:'מיקרופון', mouse:'עכבר', keyboard:'מקלדת', midi:'MIDI' }[msg.perm] || msg.perm),
          msg.value ? 'g' : '');
      }
      break;
    case 'class:mute-all':
      if (isStudent()) {
        S.selfMuted = !!msg.muted;
        if (S.micStream) S.micStream.getAudioTracks().forEach(t => t.enabled = !msg.muted);
        for (const [, p] of S.peers) p.conn?.getSenders()?.forEach(s => { if (s.track?.kind === 'audio') s.track.enabled = !msg.muted; });
        const btn = document.getElementById('muteBtn');
        if (btn) { btn.textContent = msg.muted ? '🔇' : '🎤'; btn.classList.toggle('muted-state', !!msg.muted); }
      }
      break;
    case 'webrtc:create-offer':
      S.peers.set(msg.peerId, { name: msg.name || '', color: msg.color || PEER_COLORS[0], instrument: msg.instrument || '', dc: null, conn: null, latency: 0, perms: { mouse:true, keyboard:true, midi:true } });
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
      // If this update is about ME, update MY local send-state
      if (msg.peerId === S.cid && msg.perms) {
        MY.mouse = !!msg.perms.mouse;
        MY.keyboard = !!msg.perms.keyboard;
        MY.midi = !!msg.perms.midi;
        const mm = document.getElementById('myMouse');
        const mk = document.getElementById('myKeys');
        const mi = document.getElementById('myMidi');
        if (mm) mm.classList.toggle('active', MY.mouse);
        if (mk) mk.classList.toggle('active', MY.keyboard);
        if (mi) mi.classList.toggle('active-g', MY.midi);
        toast('הרשאות עודכנו: ' + (MY.mouse?'🖱':'') + (MY.keyboard?' ⌨':'') + (MY.midi?' 🎹':''), '');
      }
      break;
    }
    case 'remote:midi': {
      dlog('🎹 MIDI ' + msg.action + ' note=' + (msg.note||'-') + ' from ' + (msg.fromName||'peer'));
      const sender = S.peers.get(msg.from);
      const color = sender?.color || '#8b5cf6';
      const name = msg.fromName || sender?.name || 'Peer';
      if (msg.action === 'noteon') {
        handleNote('noteon', msg.note, { source:'remote', velocity:msg.velocity,
          channel:msg.channel, peerColor:color, peerName:name });
      } else if (msg.action === 'noteoff') {
        handleNote('noteoff', msg.note, { source:'remote' });
      }
      break;
    }
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
        // Actually mute/unmute all outgoing audio tracks
        for (const [key, entry] of S.streams) {
          if (key.startsWith(S.cid)) {
            entry.stream.getAudioTracks().forEach(t => { t.enabled = !msg.muted; });
          }
        }
        for (const [, p] of S.peers) {
          if (p.conn) {
            p.conn.getSenders().forEach(sender => {
              if (sender.track?.kind === 'audio') sender.track.enabled = !msg.muted;
            });
          }
        }
        // Update mute button UI
        const muteBtn = document.getElementById('muteBtn');
        if (muteBtn) {
          muteBtn.textContent = msg.muted ? '🔇' : '🎤';
          muteBtn.classList.toggle('muted-state', msg.muted);
          muteBtn.title = msg.muted ? 'מושתק ע"י המארח' : 'השתק';
        }
        S.selfMuted = msg.muted;
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
    case 'remote:input': {
      // Only the host (peerNumber 1) processes remote inputs
      if (S.peerNumber !== 1) break;
      if (msg.from === S.cid) break; // ignore own inputs
      const rPeer = S.peers.get(msg.from);
      if (msg.input === 'mouse' && !rPeer?.perms?.mouse) break;
      if (msg.input === 'keyboard' && !rPeer?.perms?.keyboard) break;
      // Forward to server's local execution endpoint
      fetch(SERVER + '/api/local-input', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(msg)
      }).catch(() => {});
      if (msg.action === 'click') toast('🖱 ' + (msg.fromName||'Peer') + ' clicked', '', 1000);
      break;
    }
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
    if (pb) { pb.textContent = S.playing ? '⏸' : '▶'; pb.classList.toggle('playing', S.playing); }
  } else if (action === 'stop') {
    S.playing = false; S.pos = { b:1, bt:1, tk:1 };
    msg.playing = false; msg.pos = S.pos;
    const pb = document.getElementById('playBtn');
    if (pb) { pb.textContent = '▶'; pb.classList.remove('playing'); }
    updatePos();
  } else if (action === 'bpm') {
    S.bpm = Math.max(40, Math.min(300, S.bpm + (val || 0)));
    msg.bpm = S.bpm; msg.action = 'bpm';
    updateBPM();
  } else if (action === 'rec') {
    S.rec = !S.rec; msg.rec = S.rec;
    const rb = document.getElementById('recBtn');
    if (rb) { rb.classList.toggle('recording', S.rec); rb.style.background = ''; }
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
  self.dataset.peerId = S.cid || 'self';
  self.style.background = S.color;
  self.textContent = (S.name || '?')[0].toUpperCase();
  self.title = S.name + ' (you)';
  el.appendChild(self);
  for (const [pid, p] of S.peers) {
    const av = document.createElement('div');
    av.className = 'peer-avatar';
    av.dataset.peerId = pid;
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
  const nt = document.getElementById('notesTab');
  if (nt) nt.style.display = tab === 'notes' ? 'flex' : 'none';
  document.getElementById('tabPeers')?.classList.toggle('active', tab === 'peers');
  document.getElementById('tabChat')?.classList.toggle('active', tab === 'chat');
  const tnb = document.getElementById('tabNotes');
  if (tnb) tnb.classList.toggle('active', tab === 'notes');
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
  const existing = S.streams.get(S.cid);
  if (existing) {
    existing.stream.getTracks().forEach(t => t.stop());
    S.streams.delete(S.cid); renderStreams(); stopVU('in');
    updateShareBtn(false);
    toast('שיתוף מסך הופסק', '');
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: true, audio: true,
      selfBrowserSurface: 'include', surfaceSwitching: 'include', systemAudio: 'include'
    });
    toast('משתף מסך…', 'g');
    S.streams.set(S.cid, { stream, type: 'screen', name: S.name });
    renderStreams();
    initVU(stream, 'in');
    updateShareBtn(true);
    for (const [, p] of S.peers) {
      if (p.conn) stream.getTracks().forEach(t => p.conn.addTrack(t, stream));
    }
    stream.getVideoTracks()[0].onended = () => { toast('שיתוף מסך הסתיים', ''); S.streams.delete(S.cid); renderStreams(); stopVU('in'); updateShareBtn(false); };
  } catch(e) { toast('שיתוף בוטל', ''); }
}
function updateShareBtn(active) {
  const btn = document.getElementById('shareBtn');
  if (!btn) return;
  btn.innerHTML = active ? '🖥 הפסק שיתוף' : '🖥 שתף מסך';
  btn.classList.toggle('active-share', active);
}

async function doShareCam() {
  const camKey = S.cid + ':cam';
  const existing = S.streams.get(camKey);
  if (existing) {
    existing.stream.getTracks().forEach(t => t.stop());
    S.streams.delete(camKey);
    renderStreams();
    updateCamBtn(false);
    toast('מצלמה כבויה', '');
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    toast('מצלמה משותפת!', 'g');
    S.streams.set(camKey, { stream, type: 'camera', name: S.name + ' 📷' });
    renderStreams();
    updateCamBtn(true);
    for (const [, p] of S.peers) {
      if (p.conn) stream.getTracks().forEach(t => p.conn.addTrack(t, stream));
    }
    stream.getVideoTracks()[0].onended = () => { toast('המצלמה נעצרה', ''); S.streams.delete(camKey); renderStreams(); updateCamBtn(false); };
  } catch(e) { toast('המצלמה לא זמינה או שנדחתה', 'r'); }
}
function updateCamBtn(active) {
  const btn = document.getElementById('camBtn');
  if (!btn) return;
  btn.innerHTML = active ? '📷 עצור מצלמה' : '📷 מצלמה';
  btn.classList.toggle('active-share', active);
}

async function doShareAudio() {
  const audioKey = S.cid + ':audio';
  const existing = S.streams.get(audioKey);
  if (existing) {
    existing.stream.getTracks().forEach(t => t.stop());
    S.streams.delete(audioKey); stopVU('in');
    updateAudioBtn(false);
    toast('שיתוף שמע הופסק', '');
    return;
  }
  try {
    // Music-quality mode: disable AEC/AGC/NS (they mangle music), request high bitrate.
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false,
        sampleRate: 48000, channelCount: 2, sampleSize: 16 },
      systemAudio: 'include'
    });
    const vt = stream.getVideoTracks()[0];
    if (vt) { stream.removeTrack(vt); vt.stop(); }
    if (stream.getAudioTracks().length === 0) { toast('לא נמצא אודיו', 'r'); return; }
    // Try applying music-quality constraints on the audio track too (some browsers honor it here).
    try { await stream.getAudioTracks()[0].applyConstraints({ echoCancellation:false, noiseSuppression:false, autoGainControl:false }); } catch(e) {}
    toast('משתף שמע (איכות מוזיקלית)', 'g');
    S.streams.set(audioKey, { stream, type: 'audio', name: S.name + ' 🔊' });
    initVU(stream, 'in');
    updateAudioBtn(true);
    for (const [, p] of S.peers) {
      if (p.conn) {
        stream.getAudioTracks().forEach(t => {
          const sender = p.conn.addTrack(t, stream);
          // Bump Opus bitrate to 128kbps for music (default ~40kbps for speech).
          setTimeout(() => {
            try {
              const params = sender.getParameters();
              params.encodings = params.encodings || [{}];
              params.encodings[0].maxBitrate = 128_000;
              params.encodings[0].priority = 'high';
              sender.setParameters(params);
            } catch(e) {}
          }, 200);
        });
      }
    }
    stream.getAudioTracks()[0].onended = () => { toast('שיתוף השמע הסתיים', ''); S.streams.delete(audioKey); stopVU('in'); updateAudioBtn(false); };
  } catch(e) { toast('שיתוף שמע בוטל', ''); }
}
function updateAudioBtn(active) {
  const btn = document.getElementById('shareAudioBtn');
  if (!btn) return;
  btn.innerHTML = active ? '🔇 עצור שמע' : '🔊 שתף שמע';
  btn.classList.toggle('active-share', active);
}

function showRemoteStream(stream, peerId) {
  const p = S.peers.get(peerId);
  const name = p?.name || 'Peer';
  S.streams.set(peerId, { stream, type: 'screen', name });
  renderStreams();
  toast(name + ' משתף/ת מסך', 'g');
  initVU(stream, 'out');
  voiceAttach(peerId, stream);
  stream.getTracks().forEach(t => { t.onended = () => { S.streams.delete(peerId); renderStreams(); stopVU('out'); voiceDetach(peerId); }; });
}

function closeRv() {
  S.streams.delete(S.cid);
  S.streams.delete(S.cid + ':cam');
  renderStreams();
}

// ── Multi-stream rendering ────────────────────────────────
function createStreamEl(peerId, stream, name) {
  const wrap = document.createElement('div');
  wrap.className = 'stream-thumb';
  wrap.dataset.peerId = peerId;
  const vid = document.createElement('video');
  vid.srcObject = stream;
  vid.autoplay = true;
  vid.playsInline = true;
  vid.muted = peerId.startsWith(S.cid);
  const label = document.createElement('div');
  label.className = 'stream-label';
  label.textContent = name || 'Peer';
  wrap.appendChild(vid);
  wrap.appendChild(label);
  // Drag support
  wrap.draggable = true;
  wrap.ondragstart = (e) => { wrap._dragSrc = true; wrap.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; };
  wrap.ondragend = () => { wrap.classList.remove('dragging'); wrap._dragSrc = false; };
  wrap.ondragover = (e) => e.preventDefault();
  wrap.ondrop = (e) => {
    e.preventDefault();
    const parent = wrap.parentNode;
    const src = parent.querySelector('.dragging');
    if (src && src !== wrap) {
      const srcIdx = [...parent.children].indexOf(src);
      const tgtIdx = [...parent.children].indexOf(wrap);
      if (srcIdx < tgtIdx) parent.insertBefore(src, wrap.nextSibling);
      else parent.insertBefore(src, wrap);
    }
  };
  return wrap;
}

function throttle(fn, ms) { let last = 0; return function(...a) { const now = Date.now(); if (now - last >= ms) { last = now; fn.apply(this, a); } }; }

function renderStreams() {
  const mainEl = document.getElementById('streamMain');
  const thumbsEl = document.getElementById('streamThumbs');
  const empty = document.getElementById('mainEmpty');
  const container = document.getElementById('streamContainer');
  if (!mainEl || !thumbsEl) return;

  if (S.streams.size === 0) {
    if (empty) empty.style.display = '';
    if (container) container.style.display = 'none';
    mainEl.innerHTML = '';
    thumbsEl.innerHTML = '';
    const mc = document.getElementById('myControls');
    if (mc) mc.style.display = 'none';
    return;
  }
  if (empty) empty.style.display = 'none';
  if (container) container.style.display = '';

  // Pick focused stream
  if (!S.focusedStream || !S.streams.has(S.focusedStream)) {
    S.focusedStream = S.streams.keys().next().value;
  }

  // Main view (only in thumbnail mode)
  mainEl.innerHTML = '';
  const focused = S.streams.get(S.focusedStream);
  if (focused) {
    // Wrap so we can overlay the "click to control" hint
    const wrap = document.createElement('div');
    wrap.className = 'main-video-wrap';
    wrap.style.cssText = 'position:relative;width:100%;height:100%;display:flex';
    const vid = document.createElement('video');
    vid.srcObject = focused.stream;
    vid.autoplay = true; vid.playsInline = true;
    vid.muted = S.focusedStream.startsWith(S.cid);
    vid.tabIndex = 0; // make focusable for keyboard events
    vid.style.cssText = 'width:100%;height:100%;object-fit:contain;background:#000';
    wrap.appendChild(vid);
    // Show hint only when this isn't our own stream and the guest can send input
    const isSelf = S.focusedStream.startsWith(S.cid);
    if (!isSelf && (MY.mouse || MY.keyboard)) {
      const hint = document.createElement('div');
      hint.className = 'remote-hint';
      hint.innerHTML = '<div class="remote-hint-inner">👆 לחץ כדי לשלוט על ה-DAW</div>';
      wrap.appendChild(hint);
      // Hide hint after first interaction
      vid.addEventListener('focus', () => hint.style.display = 'none', { once:true });
      vid.addEventListener('mousedown', () => hint.style.display = 'none', { once:true });
    }
    mainEl.appendChild(wrap);

    // Remote control event listeners — proper drag support
    let remoteMouseDown = false;
    const relXY = (e) => {
      const r = vid.getBoundingClientRect();
      return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
    };
    vid.addEventListener('mousedown', (e) => {
      if (!MY.mouse) return;
      remoteMouseDown = true;
      const p = relXY(e);
      broadcast({ type:'remote:input', input:'mouse', action:'mousedown',
        x:p.x, y:p.y, button:e.button, from:S.cid, fromName:S.name });
    });
    vid.addEventListener('mouseup', (e) => {
      if (!remoteMouseDown) return;
      remoteMouseDown = false;
      if (!MY.mouse) return;
      const p = relXY(e);
      broadcast({ type:'remote:input', input:'mouse', action:'mouseup',
        x:p.x, y:p.y, button:e.button, from:S.cid });
    });
    vid.addEventListener('mouseleave', (e) => {
      // Still send a mouseup so the host doesn't have a stuck-held button.
      if (!remoteMouseDown) return;
      remoteMouseDown = false;
      if (!MY.mouse) return;
      const p = relXY(e);
      broadcast({ type:'remote:input', input:'mouse', action:'mouseup',
        x:p.x, y:p.y, button:0, from:S.cid });
    });
    vid.addEventListener('mousemove', throttle((e) => {
      if (!MY.mouse) return;
      const p = relXY(e);
      broadcast({ type:'remote:input', input:'mouse', action:'move',
        x:p.x, y:p.y, from:S.cid });
    }, 30));
    vid.addEventListener('contextmenu', (e) => {
      if (!MY.mouse) return;
      e.preventDefault();
    });
    vid.addEventListener('wheel', throttle((e) => {
      if (!MY.mouse) return;
      e.preventDefault();
      broadcast({ type:'remote:input', input:'mouse', action:'scroll',
        dx: -Math.sign(e.deltaX) * 3, dy: -Math.sign(e.deltaY) * 3, from:S.cid });
    }, 30));
    vid.addEventListener('keydown', (e) => {
      if (!MY.keyboard) return;
      // If user's keyboard is mapped to MIDI right now, don't hijack it for remote control.
      if (PIANO.kbdOn && PIANO.keyMap[e.key?.toLowerCase()] !== undefined) return;
      e.preventDefault();
      broadcast({ type:'remote:input', input:'keyboard', action:'keydown',
        key: e.key, code: e.code,
        shift: e.shiftKey, ctrl: e.ctrlKey, alt: e.altKey, meta: e.metaKey,
        from: S.cid, fromName: S.name });
    });
    vid.addEventListener('keyup', (e) => {
      if (!MY.keyboard) return;
      if (PIANO.kbdOn && PIANO.keyMap[e.key?.toLowerCase()] !== undefined) return;
      broadcast({ type:'remote:input', input:'keyboard', action:'keyup',
        key: e.key, code: e.code,
        shift: e.shiftKey, ctrl: e.ctrlKey, alt: e.altKey, meta: e.metaKey,
        from: S.cid });
    });

    const lbl = document.createElement('div');
    lbl.className = 'stream-label';
    lbl.textContent = focused.name;
    mainEl.appendChild(lbl);
  }

  // Thumbnails
  thumbsEl.innerHTML = '';
  for (const [pid, s] of S.streams) {
    const thumb = createStreamEl(pid, s.stream, s.name);
    if (pid === S.focusedStream) thumb.classList.add('active');
    thumb.onclick = () => { S.focusedStream = pid; renderStreams(); };
    thumbsEl.appendChild(thumb);
  }

  // Hide thumbs sidebar if only 1 stream (in thumbnail mode)
  const isGrid = container?.classList.contains('grid-mode');
  thumbsEl.style.display = (!isGrid && S.streams.size <= 1) ? 'none' : '';

  // Hide my-controls when no streams are active (remote control is meaningless without video)
  const mc = document.getElementById('myControls');
  if (mc) mc.style.display = S.streams.size > 0 ? '' : 'none';
}

function toggleStreamView() {
  const c = document.getElementById('streamContainer');
  if (!c) return;
  const isGrid = c.classList.toggle('grid-mode');
  const btn = document.getElementById('viewToggle');
  if (btn) { btn.textContent = isGrid ? '⊡' : '⊞'; btn.classList.toggle('active-tool', isGrid); }
  renderStreams();
}

async function toggleSelfMute() {
  const hasMicStream = [...S.streams.keys()].some(k => {
    if (!k.startsWith(S.cid)) return false;
    const entry = S.streams.get(k);
    return entry.stream.getAudioTracks().length > 0;
  });

  if (!hasMicStream && !S.micStream) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      S.micStream = stream;
      S.selfMuted = false;
      for (const [, p] of S.peers) {
        if (p.conn) stream.getAudioTracks().forEach(t => p.conn.addTrack(t, stream));
      }
      const btn = document.getElementById('muteBtn');
      if (btn) { btn.textContent = '🎤'; btn.classList.remove('muted-state'); btn.title = 'השתק'; }
      voiceAttach(S.cid || 'self', stream);
      toast('מיקרופון פעיל', 'g');
      return;
    } catch (e) {
      toast('לא ניתן לפתוח מיקרופון', 'r');
      return;
    }
  }

  S.selfMuted = !S.selfMuted;
  for (const [key, entry] of S.streams) {
    if (key.startsWith(S.cid)) {
      entry.stream.getAudioTracks().forEach(t => { t.enabled = !S.selfMuted; });
    }
  }
  if (S.micStream) S.micStream.getAudioTracks().forEach(t => { t.enabled = !S.selfMuted; });
  for (const [, p] of S.peers) {
    if (p.conn) {
      p.conn.getSenders().forEach(sender => {
        if (sender.track?.kind === 'audio') sender.track.enabled = !S.selfMuted;
      });
    }
  }
  const btn = document.getElementById('muteBtn');
  if (btn) {
    btn.textContent = S.selfMuted ? '🔇' : '🎤';
    btn.classList.toggle('muted-state', S.selfMuted);
    btn.title = S.selfMuted ? 'בטל השתקה' : 'השתק';
  }
  toast(S.selfMuted ? 'מושתק' : 'מיקרופון פעיל', S.selfMuted ? '' : 'g');
}

// ══════════════════════════════════════════════════════════
// Adaptive bitrate — measure loss/RTT per peer, ramp video down
// under stress and back up when things clear
// ══════════════════════════════════════════════════════════
const BW_TIERS = [500_000, 1_000_000, 2_500_000, 4_500_000]; // bits/s
function startAdaptiveBitrate(pc, peerId) {
  let tier = BW_TIERS.length - 1;
  let lastPacketsLost = 0, lastPacketsSent = 0;
  const interval = setInterval(async () => {
    if (!pc || pc.connectionState === 'closed' || pc.connectionState === 'failed') {
      clearInterval(interval); return;
    }
    try {
      const stats = await pc.getStats();
      let sent = 0, lost = 0, rtt = 0, hadOutbound = false;
      stats.forEach(r => {
        if (r.type === 'outbound-rtp' && r.kind === 'video') {
          sent = r.packetsSent || 0; hadOutbound = true;
        }
        if (r.type === 'remote-inbound-rtp' && r.kind === 'video') {
          lost = r.packetsLost || 0;
          rtt = r.roundTripTime || 0;
        }
      });
      if (!hadOutbound) return;
      const dSent = Math.max(1, sent - lastPacketsSent);
      const dLost = Math.max(0, lost - lastPacketsLost);
      lastPacketsSent = sent; lastPacketsLost = lost;
      const lossRate = dLost / dSent;
      // Decide direction
      let target = tier;
      if (lossRate > 0.05 || rtt > 0.3) target = Math.max(0, tier - 1);
      else if (lossRate < 0.005 && rtt < 0.15 && tier < BW_TIERS.length - 1) target = tier + 1;
      if (target !== tier) {
        tier = target;
        applyVideoBitrate(pc, BW_TIERS[tier]);
        const p = S.peers.get(peerId);
        if (p) p.bwTier = tier;
        dlog('BW → ' + peerId + ' tier=' + tier + ' (' + Math.round(BW_TIERS[tier]/1000) + 'kbps) loss=' + (lossRate*100).toFixed(1) + '% rtt=' + Math.round(rtt*1000) + 'ms');
      }
    } catch (e) {}
  }, 3000);
}

function applyVideoBitrate(pc, maxBitrate) {
  pc.getSenders().forEach(sender => {
    if (sender.track?.kind !== 'video') return;
    try {
      const params = sender.getParameters();
      params.encodings = params.encodings && params.encodings.length ? params.encodings : [{}];
      for (const enc of params.encodings) enc.maxBitrate = maxBitrate;
      sender.setParameters(params);
    } catch (e) {}
  });
}

// ══════════════════════════════════════════════════════════
// Voice Activity — glow avatar for whichever peer is speaking
// ══════════════════════════════════════════════════════════
const VOICE = { analyzers: new Map(), rafId: null, ctx: null };

function voiceEnsureCtx() {
  if (VOICE.ctx) return VOICE.ctx;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  VOICE.ctx = new AC();
  return VOICE.ctx;
}

function voiceAttach(peerId, stream) {
  if (!stream || !stream.getAudioTracks || !stream.getAudioTracks().length) return;
  const ctx = voiceEnsureCtx();
  if (!ctx) return;
  // Replace any existing analyzer for this peer
  voiceDetach(peerId);
  try {
    const src = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.5;
    src.connect(analyser);
    VOICE.analyzers.set(peerId, { analyser, buffer: new Uint8Array(analyser.frequencyBinCount) });
    if (!VOICE.rafId) voiceTick();
  } catch (e) {}
}

function voiceDetach(peerId) {
  VOICE.analyzers.delete(peerId);
  const el = document.querySelector('[data-peer-id="' + peerId + '"]');
  if (el) el.classList.remove('speaking', 'speaking-loud');
}

function voiceTick() {
  let anyActive = false;
  for (const [peerId, { analyser, buffer }] of VOICE.analyzers) {
    analyser.getByteFrequencyData(buffer);
    // Focus on speech band (~85Hz to ~3kHz — bins 1..60 at 22kHz sample rate / 256 bins)
    let sum = 0, count = 0;
    for (let i = 1; i < Math.min(64, buffer.length); i++) { sum += buffer[i]; count++; }
    const avg = sum / count;
    // Update avatar visual
    const av = document.querySelector('[data-peer-id="' + peerId + '"]');
    if (av) {
      const speaking = avg > 22;
      const loud = avg > 55;
      av.classList.toggle('speaking', speaking && !loud);
      av.classList.toggle('speaking-loud', loud);
    }
    if (avg > 10) anyActive = true;
  }
  // Keep ticking as long as we have analyzers
  if (VOICE.analyzers.size) VOICE.rafId = requestAnimationFrame(voiceTick);
  else VOICE.rafId = null;
}

// ══════════════════════════════════════════════════════════
// Lecture mode — session-level role, class control, raise-hand
// ══════════════════════════════════════════════════════════
function isLecture() { return S.mode === 'lecture'; }
function isLecturer() { return isLecture() && S.peerNumber === 1; }
function isStudent()  { return isLecture() && S.peerNumber !== 1; }

function applySessionMode() {
  document.body.classList.toggle('is-lecture', isLecture());
  document.body.classList.toggle('is-lecturer', isLecturer());
  document.body.classList.toggle('is-student', isStudent());
  const raiseBtn = document.getElementById('raiseHandBtn');
  const classBtn = document.getElementById('classCtrlBtn');
  if (raiseBtn) raiseBtn.style.display = isStudent() ? '' : 'none';
  if (classBtn) classBtn.style.display = isLecturer() ? '' : 'none';
  if (isStudent()) {
    // Auto-mute + lock permissions; sends muted, no input
    S.selfMuted = true;
    MY.mouse = false; MY.keyboard = false; MY.midi = false;
    document.getElementById('myMouse')?.classList.remove('active');
    document.getElementById('myKeys')?.classList.remove('active');
    const muteBtn = document.getElementById('muteBtn');
    if (muteBtn) { muteBtn.textContent = '🔇'; muteBtn.classList.add('muted-state'); }
    toast('מצב הרצאה — משתקים אותך עד שהמרצה יתן רשות', '');
  }
}

function toggleRaiseHand() {
  if (!isStudent()) return;
  const wasRaised = document.body.classList.toggle('hand-up');
  const btn = document.getElementById('raiseHandBtn');
  if (btn) btn.classList.toggle('active', wasRaised);
  broadcast({ type: wasRaised ? 'hand:raise' : 'hand:lower', from: S.cid, fromName: S.name });
  toast(wasRaised ? '✋ הרמת יד' : 'הורדת יד', wasRaised ? 'g' : '');
}

function showClassControl() {
  if (!isLecturer()) return;
  const students = [];
  for (const [pid, p] of S.peers) {
    students.push({ id: pid, name: p.name || 'תלמיד', color: p.color || '#8b5cf6',
      handRaised: S.handsRaised.has(pid),
      perms: p.perms || { mouse:false, keyboard:false, midi:false, mic:false } });
  }
  const rows = students.map(s => \`
    <div class="cc-row" style="border-inline-start:4px solid \${s.color}">
      <div class="cc-name">\${s.handRaised ? '✋ ' : ''}\${esc(s.name)}</div>
      <div class="cc-toggles">
        <button class="cc-toggle \${s.perms.mic ? 'on' : ''}" onclick="classToggle('\${s.id}','mic')">🎤</button>
        <button class="cc-toggle \${s.perms.mouse ? 'on' : ''}" onclick="classToggle('\${s.id}','mouse')">🖱</button>
        <button class="cc-toggle \${s.perms.keyboard ? 'on' : ''}" onclick="classToggle('\${s.id}','keyboard')">⌨</button>
        <button class="cc-toggle \${s.perms.midi ? 'on' : ''}" onclick="classToggle('\${s.id}','midi')">🎹</button>
      </div>
    </div>
  \`).join('');
  const html = \`
    <div class="modal-backdrop" id="ccBackdrop" onclick="if(event.target===this)closeClassControl()">
      <div class="modal-panel" style="max-width:520px" dir="rtl">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px">
          <h3 style="margin:0;flex:1">🎓 שליטת הרצאה</h3>
          <button onclick="closeClassControl()" style="background:none;border:none;color:var(--mid);font-size:18px;cursor:pointer">✕</button>
        </div>
        <div style="display:flex;gap:6px;margin-bottom:12px">
          <button class="btn-primary" style="flex:1;font-size:12px" onclick="classMuteAll(true)">🔇 השתק את כולם</button>
          <button class="btn-primary" style="flex:1;font-size:12px" onclick="classMuteAll(false)">🎤 פתח את כולם</button>
        </div>
        <div class="cc-list">\${rows || '<div style="font-size:12px;color:var(--dim);padding:12px;text-align:center">אין תלמידים בסשן</div>'}</div>
        <div style="font-size:11px;color:var(--dim);margin-top:10px">לחץ על אייקון כדי לתת/לקחת הרשאה לתלמיד</div>
      </div>
    </div>
  \`;
  document.getElementById('ccBackdrop')?.remove();
  document.body.insertAdjacentHTML('beforeend', html);
}
function closeClassControl() { document.getElementById('ccBackdrop')?.remove(); }

function classToggle(peerId, perm) {
  const p = S.peers.get(peerId);
  if (!p) return;
  p.perms = p.perms || { mouse:false, keyboard:false, midi:false, mic:false };
  p.perms[perm] = !p.perms[perm];
  broadcast({ type: 'class:perm', targetId: peerId, perm, value: p.perms[perm], from: S.cid });
  // Refresh open modal
  showClassControl();
}

function classMuteAll(muted) {
  broadcast({ type: 'class:mute-all', muted, from: S.cid });
  for (const [pid, p] of S.peers) {
    p.perms = p.perms || {};
    p.perms.mic = !muted;
  }
  toast(muted ? '🔇 כולם הושתקו' : '🎤 כולם נפתחו', 'g');
  showClassControl();
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
  const labels = { mouse:'עכבר', keyboard:'מקלדת', midi:'MIDI' };
  toast((MY[key] ? '✓ שולח ' : '✗ הפסקת שליחת ') + (labels[key]||key), MY[key] ? 'g' : '');
}

// ══════════════════════════════════════════════════════════
// Virtual Piano + MIDI
// ══════════════════════════════════════════════════════════
const PIANO = {
  octave: 4,          // base octave (Ableton default is 3, but 4 sits in the sweet spot for laptop mics)
  velocity: 100,      // note velocity (0-127)
  active: new Set(),
  kbdOn: false,       // computer-keyboard-as-MIDI toggle (like Ableton's M)
  size: Number(localStorage.getItem('ss_piano_size') || 2),  // octaves: 2/4/7
  // Ableton Computer MIDI Keyboard mapping — semitone offset from C
  // Lower octave: A row + upper row for black keys
  keyMap: {
    'a':0, 'w':1, 's':2, 'e':3, 'd':4, 'f':5, 't':6, 'g':7, 'y':8, 'h':9, 'u':10, 'j':11,
    'k':12, 'o':13, 'l':14, 'p':15, ';':16, "'":17
  }
};

// ══════════════════════════════════════════════════════════
// Web Audio piano synth — local sound for all note sources
// ══════════════════════════════════════════════════════════
const AUDIO = { ctx: null, master: null, voices: new Map() };

function audioInit() {
  if (AUDIO.ctx) return;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return;
  AUDIO.ctx = new AC();
  AUDIO.master = AUDIO.ctx.createGain();
  AUDIO.master.gain.value = 0.35;
  AUDIO.master.connect(AUDIO.ctx.destination);
}

function midiToFreq(note) {
  return 440 * Math.pow(2, (note - 69) / 12);
}

function playPianoNote(note, velocity) {
  audioInit();
  if (!AUDIO.ctx) return;
  if (AUDIO.ctx.state === 'suspended') AUDIO.ctx.resume();

  // stop any existing voice on this note
  stopPianoNote(note);

  const freq = midiToFreq(note);
  const vel = (velocity || 100) / 127;
  const now = AUDIO.ctx.currentTime;

  // Additive synth: 3 harmonics (fundamental + 2nd + 3rd) for piano-ish tone
  const gain = AUDIO.ctx.createGain();
  gain.gain.setValueAtTime(0, now);
  gain.gain.linearRampToValueAtTime(vel * 0.9, now + 0.005);        // fast attack
  gain.gain.exponentialRampToValueAtTime(vel * 0.35, now + 0.15);   // initial decay
  gain.gain.exponentialRampToValueAtTime(vel * 0.15, now + 1.5);    // sustain-decay
  gain.connect(AUDIO.master);

  const oscs = [];
  const harmonics = [[1, 1], [2, 0.35], [3, 0.15]];
  for (const [mult, amp] of harmonics) {
    const o = AUDIO.ctx.createOscillator();
    o.type = 'sine';
    o.frequency.value = freq * mult;
    const g = AUDIO.ctx.createGain();
    g.gain.value = amp;
    o.connect(g); g.connect(gain);
    o.start(now);
    oscs.push({ o, g });
  }

  AUDIO.voices.set(note, { gain, oscs });
}

function stopPianoNote(note) {
  const v = AUDIO.voices.get(note);
  if (!v) return;
  const now = AUDIO.ctx.currentTime;
  try {
    v.gain.gain.cancelScheduledValues(now);
    v.gain.gain.setValueAtTime(v.gain.gain.value, now);
    v.gain.gain.exponentialRampToValueAtTime(0.001, now + 0.2);
    v.oscs.forEach(({o}) => o.stop(now + 0.25));
  } catch (e) {}
  AUDIO.voices.delete(note);
}

// ══════════════════════════════════════════════════════════
// Central note pipeline — every input source flows through here.
// source='local' → play locally + broadcast to peers
// source='remote' → play locally + highlight in peer color, don't rebroadcast
// ══════════════════════════════════════════════════════════
function handleNote(action, note, opts) {
  opts = opts || {};
  const velocity = opts.velocity || 100;
  const source = opts.source || 'local';
  const peerColor = opts.peerColor || '#8b5cf6';
  const peerName = opts.peerName || '';
  const channel = opts.channel || 0;

  if (action === 'noteon') {
    playPianoNote(note, velocity);
    highlightKey(note, true, peerColor, peerName);
    if (source === 'local' && MY.midi) {
      broadcast({ type:'remote:midi', action:'noteon', note, velocity, channel,
        from:S.cid, fromName:S.name });
    }
  } else if (action === 'noteoff') {
    stopPianoNote(note);
    highlightKey(note, false);
    if (source === 'local' && MY.midi) {
      broadcast({ type:'remote:midi', action:'noteoff', note, velocity:0, channel,
        from:S.cid, fromName:S.name });
    }
  }
}

function highlightKey(note, on, color, peerName) {
  const el = document.querySelector('[data-note="' + note + '"]');
  if (!el) return;
  if (on) {
    el.classList.add('on');
    if (color) el.style.background = color;
    if (peerName) el.setAttribute('data-peer', peerName.slice(0, 8));
  } else {
    el.classList.remove('on');
    el.style.background = '';
    el.removeAttribute('data-peer');
  }
}

function togglePiano() {
  const w = document.getElementById('pianoWrap');
  const btn = document.getElementById('pianoBtn');
  if (!w) return;
  const open = w.classList.toggle('open');
  if (btn) btn.classList.toggle('active', open);
  if (open) {
    audioInit(); // unlock audio on user gesture
    if (AUDIO.ctx?.state === 'suspended') AUDIO.ctx.resume();
    if (!w.dataset.built) { buildPianoKeys(); w.dataset.built = '1'; }
  }
}

function pianoOctave(dir) {
  PIANO.octave = Math.max(0, Math.min(8, PIANO.octave + dir));
  const lbl = document.getElementById('pianoOctLbl');
  if (lbl) lbl.textContent = 'C' + PIANO.octave;
  buildPianoKeys();
}

function setPianoSize(octaves) {
  PIANO.size = Math.max(1, Math.min(7, octaves));
  try { localStorage.setItem('ss_piano_size', String(PIANO.size)); } catch(e) {}
  releaseAllNotes(); // avoid stuck highlights when re-rendering keys
  buildPianoKeys();
}

function buildPianoKeys() {
  const el = document.getElementById('pianoKeys');
  if (!el) return;
  el.innerHTML = '';
  // Reflect current size choice in the picker
  document.querySelectorAll('.piano-size-btn').forEach(b => {
    b.classList.toggle('active', Number(b.dataset.size) === PIANO.size);
  });
  // Clamp base octave so the last key doesn't go past MIDI 108
  const octaves = PIANO.size || 2;
  const maxStart = 9 - octaves;
  if (PIANO.octave > maxStart) PIANO.octave = maxStart;
  const lbl = document.getElementById('pianoOctLbl');
  if (lbl) lbl.textContent = 'C' + PIANO.octave;
  for (let oct = 0; oct < octaves; oct++) {
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
      key.ontouchstart = (e) => { e.preventDefault(); pianoNoteOn(note, key); };
      key.ontouchend = key.ontouchcancel = (e) => { e.preventDefault(); pianoNoteOff(note, key); };
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
      bk.ontouchstart = (e) => { e.preventDefault(); e.stopPropagation(); pianoNoteOn(note, bk); };
      bk.ontouchend = bk.ontouchcancel = (e) => { e.preventDefault(); pianoNoteOff(note, bk); };
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
  PIANO.mouseHeld.add(note);
  handleNote('noteon', note, { source:'local', velocity:PIANO.velocity,
    peerColor:S.color || PEER_COLORS[0], peerName:S.name });
}

function pianoNoteOff(note, el) {
  if (!PIANO.active.has(note)) return;
  PIANO.active.delete(note);
  PIANO.mouseHeld.delete(note);
  handleNote('noteoff', note, { source:'local' });
}

// ══════════════════════════════════════════════════════════
// Computer keyboard as MIDI (like Ableton's "M" toggle)
// ASDFGHJK = white keys, WERTYU = black keys
// Z/X = octave down/up, C/V = velocity down/up
// ══════════════════════════════════════════════════════════
function toggleKbdMidi() {
  PIANO.kbdOn = !PIANO.kbdOn;
  const btn = document.getElementById('kbdMidiBtn');
  if (btn) {
    btn.classList.toggle('active', PIANO.kbdOn);
    btn.title = PIANO.kbdOn
      ? 'מקלדת = MIDI (ASDF...) — לחץ M לכבות'
      : 'לחץ M להפעיל מקלדת כ-MIDI';
  }
  toast(PIANO.kbdOn ? '🎹 מקלדת = MIDI פעיל (ASDF...)' : 'מקלדת = MIDI כבוי', PIANO.kbdOn ? 'g' : '');
  // Always release every held note — local + peers — regardless of direction
  releaseAllNotes();
}

function releaseAllNotes() {
  // Stop local audio + highlight + send noteoff to peers for every active note
  const held = [...PIANO.active];
  PIANO.active.clear();
  for (const note of held) {
    stopPianoNote(note);
    highlightKey(note, false);
    if (MY.midi) {
      broadcast({ type:'remote:midi', action:'noteoff', note, velocity:0, channel:0,
        from:S.cid, fromName:S.name });
    }
  }
  // Belt & suspenders: also stop any orphaned voices
  if (AUDIO.voices) {
    for (const note of [...AUDIO.voices.keys()]) stopPianoNote(note);
  }
}

// Emergency stop: ESC releases everything; blur/hidden releases everything.
window.addEventListener('blur', releaseAllNotes);
document.addEventListener('visibilitychange', () => { if (document.hidden) releaseAllNotes(); });
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') releaseAllNotes();
});

function kbdMidiNoteOn(note) {
  if (PIANO.active.has(note)) return;
  PIANO.active.add(note);
  handleNote('noteon', note, { source:'local', velocity:PIANO.velocity,
    peerColor:S.color, peerName:S.name });
  flashMidiPill();
}

function kbdMidiNoteOff(note) {
  if (!PIANO.active.has(note)) return;
  PIANO.active.delete(note);
  handleNote('noteoff', note, { source:'local' });
}

document.addEventListener('keydown', e => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const tag = document.activeElement?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') return;
  const k = e.key?.toLowerCase();

  // M = toggle keyboard MIDI (only inside a session)
  if (k === 'm' && S.code && !e.repeat) {
    e.preventDefault();
    toggleKbdMidi();
    return;
  }

  if (!PIANO.kbdOn) return;

  // Octave: Z / X
  if (k === 'z' && !e.repeat) {
    PIANO.octave = Math.max(0, PIANO.octave - 1);
    toast('אוקטבה: C' + PIANO.octave, '');
    return;
  }
  if (k === 'x' && !e.repeat) {
    PIANO.octave = Math.min(8, PIANO.octave + 1);
    toast('אוקטבה: C' + PIANO.octave, '');
    return;
  }
  // Velocity: C / V
  if (k === 'c' && !e.repeat) {
    PIANO.velocity = Math.max(1, PIANO.velocity - 10);
    toast('Velocity: ' + PIANO.velocity, '');
    return;
  }
  if (k === 'v' && !e.repeat) {
    PIANO.velocity = Math.min(127, PIANO.velocity + 10);
    toast('Velocity: ' + PIANO.velocity, '');
    return;
  }

  const semi = PIANO.keyMap[k];
  if (semi !== undefined && !e.repeat) {
    e.preventDefault();
    kbdMidiNoteOn(PIANO.octave * 12 + semi);
  }
});

document.addEventListener('keyup', e => {
  // Always process keyup for known piano keys, even if user toggled M off mid-press.
  const k = e.key?.toLowerCase();
  const semi = PIANO.keyMap[k];
  if (semi === undefined) return;
  // Try every octave — user may have shifted octave while holding.
  for (const note of [...PIANO.active]) {
    if (((note - semi) % 12) === 0) kbdMidiNoteOff(note);
  }
});

// Track mouse-held piano notes so we can release them even if mouseup lands outside the key.
PIANO.mouseHeld = new Set();
document.addEventListener('mouseup', () => {
  if (!PIANO.mouseHeld.size) return;
  for (const note of [...PIANO.mouseHeld]) {
    const el = document.querySelector('[data-note="' + note + '"]');
    pianoNoteOff(note, el);
  }
  PIANO.mouseHeld.clear();
});

// ── Keyboard shortcuts ────────────────────────────────────
document.addEventListener('keydown', e => {
  const tag = document.activeElement?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') return;
  if (e.code === 'Space' && S.code) { e.preventDefault(); cmd('play'); }
  if (e.code === 'ArrowUp') { e.preventDefault(); cmd('bpm', 1); }
  if (e.code === 'ArrowDown') { e.preventDefault(); cmd('bpm', -1); }
});

// ══════════════════════════════════════════════════════════
// Web MIDI API — capture real MIDI keyboards, forward to host
// ══════════════════════════════════════════════════════════
const WEBMIDI = { access: null, inputs: [], playingTimer: null };

async function initWebMidi() {
  if (!navigator.requestMIDIAccess) {
    updateMidiPill('unsupported');
    return;
  }
  try {
    WEBMIDI.access = await navigator.requestMIDIAccess({ sysex: false });
    attachMidiInputs();
    WEBMIDI.access.onstatechange = attachMidiInputs;
  } catch (e) {
    updateMidiPill('denied');
  }
}

function attachMidiInputs() {
  WEBMIDI.inputs = [];
  if (!WEBMIDI.access) return;
  for (const input of WEBMIDI.access.inputs.values()) {
    input.onmidimessage = onMidiMessage;
    WEBMIDI.inputs.push(input.name || 'MIDI Device');
  }
  updateMidiPill(WEBMIDI.inputs.length ? 'connected' : 'none');
}

function onMidiMessage(e) {
  const [status, d1, d2] = e.data;
  const cmd = status & 0xf0;
  const channel = status & 0x0f;
  if (cmd === 0x90 && d2 > 0) {
    handleNote('noteon', d1, { source:'local', velocity:d2, channel,
      peerColor:S.color, peerName:S.name });
    flashMidiPill();
  } else if (cmd === 0x80 || (cmd === 0x90 && d2 === 0)) {
    handleNote('noteoff', d1, { source:'local', channel });
  } else if (cmd === 0xb0 || cmd === 0xe0) {
    // CC / pitchbend still pass through directly to peers
    if (!MY.midi) return;
    const msg = cmd === 0xb0
      ? { type:'remote:midi', action:'cc', cc:d1, value:d2, channel }
      : { type:'remote:midi', action:'pitchbend', value:(d2 << 7) | d1, channel };
    msg.from = S.cid; msg.fromName = S.name;
    broadcast(msg);
  }
}

function flashMidiPill() {
  const pill = document.getElementById('midiPill');
  if (!pill) return;
  pill.classList.add('playing');
  clearTimeout(WEBMIDI.playingTimer);
  WEBMIDI.playingTimer = setTimeout(() => pill.classList.remove('playing'), 150);
}

function updateMidiPill(state) {
  const pill = document.getElementById('midiPill');
  if (!pill) return;
  pill.classList.remove('connected', 'playing');
  if (state === 'connected') {
    pill.classList.add('connected');
    const name = WEBMIDI.inputs[0] || 'MIDI';
    pill.textContent = '🎹 ' + (name.length > 18 ? name.slice(0, 16) + '…' : name);
    pill.title = WEBMIDI.inputs.join(', ');
  } else if (state === 'none') {
    pill.textContent = '🎹 חבר קלייבורד';
    pill.title = 'לא נמצא מכשיר MIDI — חבר קלייבורד ולחץ לרענון';
  } else if (state === 'denied') {
    pill.textContent = '🎹 חסום';
    pill.title = 'הרשאת MIDI נדחתה — לחץ להרשאה מחדש';
  } else if (state === 'unsupported') {
    pill.textContent = '🎹 לא נתמך';
    pill.title = 'הדפדפן לא תומך ב-Web MIDI (השתמש ב-Chrome)';
  }
}

function reinitWebMidi() {
  initWebMidi();
  toast('סורק מכשירי MIDI…', '');
}

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

// ══════════════════════════════════════════════════════════
// Session recording — records ALL active streams simultaneously
// Multi-monitor supported via "+ הוסף מסך" (calls getDisplayMedia again).
// Each recorder produces its own .webm and downloads on stop.
// ══════════════════════════════════════════════════════════
const REC = { recorders: [], startedAt: 0, extraStreams: [] };

function isRecording() {
  return REC.recorders.some(r => r.state === 'recording');
}

function chooseMime() {
  const cands = [
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8',
    'video/webm'
  ];
  for (const m of cands) if (MediaRecorder.isTypeSupported(m)) return m;
  return 'video/webm';
}

function recordStream(stream, label) {
  const mime = chooseMime();
  const chunks = [];
  const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 4_500_000 });
  rec.ondataavailable = e => { if (e.data.size > 0) chunks.push(e.data); };
  rec.onstop = () => {
    const blob = new Blob(chunks, { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const ts = new Date().toISOString().replace(/[:.]/g,'-').slice(0,16);
    a.download = 'studiosync-' + (S.code || 'session') + '-' + label + '-' + ts + '.webm';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 3000);
    S.clips.push({ blob, name: label, ts: Date.now() });
    if (S.clips.length > 10) S.clips.shift();
    renderClips();
  };
  rec.start(2000);
  REC.recorders.push(rec);
  return rec;
}

function collectRecordableStreams() {
  const out = [];
  // 1) All currently shared streams (host share, camera, guest streams, extra monitors)
  let i = 1;
  for (const [pid, entry] of S.streams) {
    const isSelf = pid.startsWith(S.cid);
    const kind = pid.endsWith(':cam') ? 'camera' :
                 pid.endsWith(':audio') ? 'audio' :
                 pid.startsWith('extra:') ? 'screen' + (i++) :
                 'screen' + (i++);
    out.push({ stream: entry.stream, label: (isSelf ? 'me-' : 'peer-') + kind });
  }
  return out;
}

async function toggleSessionRecord() {
  if (isRecording()) return stopSessionRecord();

  const targets = collectRecordableStreams();
  if (!targets.length) {
    toast('אין שיתוף מסך להקלטה — לחץ 🖥 שתף מסך קודם', 'r');
    return;
  }

  try {
    REC.recorders = [];
    REC.startedAt = Date.now();
    for (const t of targets) recordStream(t.stream, t.label);

    // Also record system audio via a separate mic recorder if we have one
    if (S.micStream && S.micStream.getAudioTracks().length && S.micStream.getAudioTracks()[0].enabled) {
      recordStream(S.micStream, 'me-mic');
    }

    const rsb = document.getElementById('recSessionBtn');
    if (rsb) { rsb.innerHTML = '⏹ עצור (' + REC.recorders.length + ')'; rsb.classList.add('recording'); }
    toast('מקליט ' + REC.recorders.length + ' מסכים/זרמים', 'g');
  } catch (e) {
    toast('שגיאת הקלטה: ' + e.message, 'r');
    REC.recorders.forEach(r => { try { r.stop(); } catch(_){} });
    REC.recorders = [];
  }
}

function stopSessionRecord() {
  for (const r of REC.recorders) { try { if (r.state !== 'inactive') r.stop(); } catch(e){} }
  REC.recorders = [];
  // stop any extra display streams we captured
  for (const s of REC.extraStreams) { try { s.getTracks().forEach(t => t.stop()); } catch(e){} }
  REC.extraStreams = [];
  const rsb = document.getElementById('recSessionBtn');
  if (rsb) { rsb.innerHTML = '⏺ הקלט'; rsb.classList.remove('recording'); }
  toast('הקלטה הסתיימה — הקבצים יורדים...', 'g');
}

// Add another monitor mid-session — starts a new getDisplayMedia and adds it to the recording set
async function addAnotherScreen() {
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: true, audio: true, systemAudio: 'include'
    });
    const key = 'extra:' + Date.now();
    REC.extraStreams.push(stream);
    S.streams.set(key, { stream, type: 'screen', name: (S.name || 'Me') + ' 🖥' });
    // Share with peers
    for (const [, p] of S.peers) {
      if (p.conn) stream.getTracks().forEach(t => p.conn.addTrack(t, stream));
    }
    // If we're already recording, hook it up
    if (isRecording()) {
      const n = REC.recorders.length + 1;
      recordStream(stream, 'me-screen' + n);
      const rsb = document.getElementById('recSessionBtn');
      if (rsb) rsb.innerHTML = '⏹ עצור (' + REC.recorders.length + ')';
      toast('מסך נוסף — מקליט ' + REC.recorders.length + ' זרמים', 'g');
    } else {
      toast('מסך נוסף שותף', 'g');
    }
    renderStreams();
    stream.getVideoTracks()[0].onended = () => {
      S.streams.delete(key);
      REC.extraStreams = REC.extraStreams.filter(s => s !== stream);
      renderStreams();
    };
  } catch (e) {
    toast('לא נבחר מסך', '');
  }
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
  const isOpen = p.style.display !== 'block';
  p.style.display = isOpen ? 'block' : 'none';
  const btn = document.getElementById('clipBtn');
  if (btn) { btn.classList.toggle('active-tool', isOpen); btn.style.background = ''; }
  renderClips();
}
function renderClips() {
  const el = document.getElementById('clipPanel');
  if (!el) return;
  if (S.clips.length === 0) { el.innerHTML = '<div style="font-size:12px;color:var(--dim);text-align:center;padding:12px" dir="rtl">אין קליפים עדיין. הקלט סשן כדי ליצור קליפ.</div>'; return; }
  const totalMB = (S.clips.reduce((s, c) => s + c.blob.size, 0) / 1024 / 1024).toFixed(1);
  const bulkRow = S.clips.length > 1
    ? \`<div style="display:flex;gap:6px;padding:6px 8px;border-bottom:1px solid var(--b1);background:var(--s1)">
        <button class="btn-primary" style="flex:1;font-size:11px;padding:6px" onclick="downloadAllClipsZip()">⬇ הורד הכל (\${totalMB}MB)</button>
        <button class="btn-primary" style="flex:1;font-size:11px;padding:6px" onclick="uploadAllClipsToDrive()">☁ העלה הכל ל-Drive</button>
       </div>\`
    : '';
  const cards = S.clips.slice().reverse().map((c, i) => {
    const idx = S.clips.length - 1 - i;
    const url = URL.createObjectURL(c.blob);
    const size = (c.blob.size / 1024 / 1024).toFixed(1) + 'MB';
    return \`<div class="clip-card">
      <span class="clip-name">🎵 \${esc(c.name)} (\${size})</span>
      <a class="clip-dl" href="\${url}" download="\${c.name}.webm" title="הורד">⬇</a>
      <button class="clip-dl" onclick="uploadClipToDrive(\${idx})" title="העלה ל-Drive" style="background:none;border:none;cursor:pointer">☁</button>
      <button class="clip-dl" onclick="transcribeClip(\${idx})" title="תמלל" style="background:none;border:none;cursor:pointer">📝</button>
    </div>\`;
  }).join('');
  el.innerHTML = bulkRow + cards;
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
  // Update button state after fullscreen change
  setTimeout(() => {
    const btn = document.getElementById('fullscreenBtn');
    if (btn) btn.classList.toggle('active-tool', !!document.fullscreenElement);
  }, 200);
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

// ── Online Indicator + session keepalive ─────────────────
let heartbeatTimer = null;
function startHeartbeat() {
  const send = () => {
    const name = S.name || localStorage.getItem('ss_name');
    if (!name) return;
    fetch('/api/heartbeat', { method:'POST', headers:{'Content-Type':'application/json'},
      body:JSON.stringify({ name, cid: S.cid, color: S.color, instrument: S.instrument }) }).catch(()=>{});
  };
  send();
  // Faster cadence than server eviction (90s) — survives background tab throttling.
  heartbeatTimer = setInterval(send, 15000);
}
function stopHeartbeat() { if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; } }

// When the tab returns to foreground, immediately ping so the server knows we're still here.
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && S.cid) {
    fetch('/api/heartbeat', { method:'POST', headers:{'Content-Type':'application/json'},
      body:JSON.stringify({ name:S.name, cid:S.cid, color:S.color, instrument:S.instrument }) }).catch(()=>{});
  }
});

// ══════════════════════════════════════════════════════════
// Agent status polling — pill shows red until the local Agent joins
// ══════════════════════════════════════════════════════════
let agentPollTimer = null;
let lastAgentSeen = 0;
function startAgentStatusPoll() {
  stopAgentStatusPoll();
  const tick = async () => {
    if (!S.code) return;
    try {
      const r = await fetch('/api/health?code=' + encodeURIComponent(S.code));
      const d = await r.json();
      const pill = document.getElementById('agentPill');
      if (!pill) return;
      if (d.agent) {
        lastAgentSeen = Date.now();
        pill.textContent = '🤖 Agent פעיל';
        pill.classList.remove('disconnected');
        pill.classList.add('connected');
        pill.title = 'שליטה מרחוק ו-MIDI זמינים';
      } else {
        pill.textContent = '🤖 Agent לא מחובר';
        pill.classList.remove('connected');
        pill.classList.add('disconnected');
        pill.title = 'הרץ start.command על המחשב שלך כדי להפעיל MIDI + שליטה מרחוק';
      }
    } catch(e) {}
  };
  tick();
  agentPollTimer = setInterval(tick, 5000);
}
function stopAgentStatusPoll() {
  if (agentPollTimer) { clearInterval(agentPollTimer); agentPollTimer = null; }
}

// ══════════════════════════════════════════════════════════
// Health check modal — first-time sanity check for host
// ══════════════════════════════════════════════════════════
async function showHealthCheck() {
  const checks = [];

  // Browser checks (auto)
  checks.push({ label: 'Web MIDI (Chrome/Edge)', ok: !!navigator.requestMIDIAccess, note: 'להפעלת MIDI מקלייבורד פיזי' });
  checks.push({ label: 'Screen sharing (getDisplayMedia)', ok: !!navigator.mediaDevices?.getDisplayMedia, note: 'לשיתוף מסך ה-DAW' });
  checks.push({ label: 'Microphone (getUserMedia)', ok: !!navigator.mediaDevices?.getUserMedia });
  checks.push({ label: 'MediaRecorder + WebM', ok: window.MediaRecorder && MediaRecorder.isTypeSupported('video/webm') });
  checks.push({ label: 'Web Audio', ok: !!(window.AudioContext || window.webkitAudioContext), note: 'לצליל פסנתר משותף' });

  // Server-side (Agent)
  let agent = false;
  try {
    const r = await fetch('/api/health?code=' + encodeURIComponent(S.code));
    const d = await r.json();
    agent = d.agent;
  } catch(e) {}
  checks.push({ label: 'Agent מחובר (start.command)', ok: agent, note: 'שליטה מרחוק + הקלטת MIDI ל-Ableton' });

  // Manual items — user must confirm themselves
  const manual = [
    { label: 'IAC Driver פעיל (Audio MIDI Setup → IAC Driver → Device is online ✓)' },
    { label: 'Multi-Output Device (BlackHole 2ch + הרמקולים) הוגדר ונבחר ב-DAW' },
    { label: 'הרשאת Accessibility ל-Terminal (System Settings → Privacy → Accessibility)' },
    { label: 'הרשאת Screen Recording ל-Chrome (System Settings → Privacy → Screen Recording)' },
    { label: 'ב-Ableton: MIDI Track → arm → MIDI From: IAC Driver' },
  ];

  const html = \`
    <div class="modal-backdrop" id="healthBackdrop" onclick="if(event.target===this)closeHealthCheck()">
      <div class="modal-panel" style="max-width:520px">
        <h3 style="margin:0 0 6px">🩺 בדיקת כשירות</h3>
        <div style="font-size:12px;color:var(--dim);margin-bottom:14px">בדיקה אוטומטית של הדפדפן והשרת + צ'קליסט הגדרות ידניות למק</div>
        <div style="font-size:11px;color:var(--mid);text-transform:uppercase;letter-spacing:1px;margin-bottom:6px">אוטומטי</div>
        <ul style="list-style:none;padding:0;margin:0 0 16px">
          \${checks.map(c => \`<li style="padding:6px 0;display:flex;align-items:center;gap:8px;border-bottom:1px solid var(--b1)">
            <span style="font-size:16px;\${c.ok ? 'color:#03b28c' : 'color:#f04438'}">\${c.ok ? '✓' : '✗'}</span>
            <div style="flex:1"><div style="font-size:13px">\${esc(c.label)}</div>\${c.note ? \`<div style="font-size:11px;color:var(--dim)">\${esc(c.note)}</div>\` : ''}</div>
          </li>\`).join('')}
        </ul>
        <div style="font-size:11px;color:var(--mid);text-transform:uppercase;letter-spacing:1px;margin-bottom:6px">ידני (בדוק בעצמך)</div>
        <ul style="list-style:none;padding:0;margin:0 0 16px">
          \${manual.map((m, i) => \`<li style="padding:6px 0;display:flex;align-items:center;gap:8px;border-bottom:1px solid var(--b1)">
            <input type="checkbox" id="hc-manual-\${i}" onchange="saveHealthCheckState()" \${localStorage.getItem('ss_hc_' + i) === '1' ? 'checked' : ''} />
            <label for="hc-manual-\${i}" style="flex:1;font-size:13px;cursor:pointer">\${esc(m.label)}</label>
          </li>\`).join('')}
        </ul>
        <button onclick="closeHealthCheck()" class="btn-primary" style="width:100%">סגור</button>
      </div>
    </div>
  \`;
  const existing = document.getElementById('healthBackdrop');
  if (existing) existing.remove();
  document.body.insertAdjacentHTML('beforeend', html);
}
function closeHealthCheck() {
  document.getElementById('healthBackdrop')?.remove();
}
function saveHealthCheckState() {
  const boxes = document.querySelectorAll('[id^="hc-manual-"]');
  boxes.forEach((b, i) => localStorage.setItem('ss_hc_' + i, b.checked ? '1' : '0'));
}
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

// ══════════════════════════════════════════════════════════
// Google Drive integration — client-side OAuth + direct upload
// (No server-side token storage: token stays in browser memory.)
// ══════════════════════════════════════════════════════════
const DRIVE = { clientId: null, accessToken: null, tokenClient: null, folderId: null };

async function initDrive() {
  try {
    const r = await fetch('/api/config');
    const d = await r.json();
    if (!d.driveEnabled || !d.googleClientId) return;
    DRIVE.clientId = d.googleClientId;
    await loadScript('https://accounts.google.com/gsi/client');
    DRIVE.tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: DRIVE.clientId,
      scope: 'https://www.googleapis.com/auth/drive.file',
      callback: (resp) => {
        if (resp.access_token) {
          DRIVE.accessToken = resp.access_token;
          if (DRIVE._pendingResolve) { DRIVE._pendingResolve(); DRIVE._pendingResolve = null; }
        }
      }
    });
  } catch (e) { /* Drive optional */ }
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    if ([...document.scripts].some(s => s.src === src)) return resolve();
    const s = document.createElement('script');
    s.src = src; s.async = true; s.defer = true;
    s.onload = resolve; s.onerror = reject;
    document.head.appendChild(s);
  });
}

async function ensureDriveAuth() {
  if (!DRIVE.tokenClient) {
    toast('Google Drive לא הוגדר בשרת', 'r');
    return false;
  }
  if (DRIVE.accessToken) return true;
  await new Promise((resolve) => {
    DRIVE._pendingResolve = resolve;
    DRIVE.tokenClient.requestAccessToken({ prompt: '' });
  });
  return !!DRIVE.accessToken;
}

async function ensureDriveFolder() {
  if (DRIVE.folderId) return DRIVE.folderId;
  const name = 'StudioSync';
  // Look for existing folder first
  const q = encodeURIComponent(\`name='\${name}' and mimeType='application/vnd.google-apps.folder' and trashed=false\`);
  const search = await fetch('https://www.googleapis.com/drive/v3/files?q=' + q + '&fields=files(id,name)', {
    headers: { Authorization: 'Bearer ' + DRIVE.accessToken }
  });
  const sd = await search.json();
  if (sd.files && sd.files.length) { DRIVE.folderId = sd.files[0].id; return DRIVE.folderId; }
  // Create it
  const create = await fetch('https://www.googleapis.com/drive/v3/files', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + DRIVE.accessToken },
    body: JSON.stringify({ name, mimeType: 'application/vnd.google-apps.folder' })
  });
  const cd = await create.json();
  DRIVE.folderId = cd.id;
  return DRIVE.folderId;
}

async function uploadBlobToDrive(blob, filename, onProgress) {
  if (!(await ensureDriveAuth())) return null;
  const folder = await ensureDriveFolder();
  const metadata = { name: filename, parents: [folder], mimeType: blob.type || 'video/webm' };
  // Multipart upload
  const boundary = '-------studiosync' + Math.random().toString(36).slice(2);
  const CRLF = '\\r\\n';
  const delimiter = CRLF + '--' + boundary + CRLF;
  const closeDelim = CRLF + '--' + boundary + '--';
  const metaPart = delimiter + 'Content-Type: application/json' + CRLF + CRLF + JSON.stringify(metadata);
  const dataHeader = delimiter + 'Content-Type: ' + metadata.mimeType + CRLF + 'Content-Transfer-Encoding: binary' + CRLF + CRLF;
  const body = new Blob([metaPart, dataHeader, blob, closeDelim], { type: 'multipart/related; boundary=' + boundary });

  const xhr = new XMLHttpRequest();
  const url = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink';
  return new Promise((resolve, reject) => {
    xhr.open('POST', url);
    xhr.setRequestHeader('Authorization', 'Bearer ' + DRIVE.accessToken);
    xhr.setRequestHeader('Content-Type', 'multipart/related; boundary=' + boundary);
    if (onProgress && xhr.upload) {
      xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
    }
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve(JSON.parse(xhr.responseText));
      else reject(new Error('Drive upload failed: ' + xhr.status + ' ' + xhr.responseText));
    };
    xhr.onerror = () => reject(new Error('Network error'));
    xhr.send(body);
  });
}

async function uploadClipToDrive(idx) {
  const clip = S.clips[idx];
  if (!clip) return;
  toast('מעלה ל-Drive: ' + clip.name, '');
  try {
    const res = await uploadBlobToDrive(clip.blob, clip.name + '.webm',
      (p) => { /* could show progress bar */ });
    if (res?.webViewLink) {
      toast('✓ עלה: ' + clip.name, 'g');
      window.open(res.webViewLink, '_blank');
    }
  } catch (e) {
    toast('שגיאה: ' + e.message, 'r');
  }
}

async function uploadAllClipsToDrive() {
  if (!S.clips.length) return;
  if (!(await ensureDriveAuth())) return;
  toast('מעלה ' + S.clips.length + ' קליפים ל-Drive...', '');
  let ok = 0, fail = 0;
  for (let i = 0; i < S.clips.length; i++) {
    const clip = S.clips[i];
    try {
      await uploadBlobToDrive(clip.blob, clip.name + '.webm');
      ok++;
      toast(\`\${ok}/\${S.clips.length} עלו\`, '');
    } catch (e) { fail++; }
  }
  toast(\`הועלו \${ok} קליפים\${fail ? ' (\${fail} נכשלו)' : ''} → תיקיית StudioSync ב-Drive\`, ok ? 'g' : 'r');
}

// ══════════════════════════════════════════════════════════
// Transcription — send audio blob to server proxy → STT provider
// ══════════════════════════════════════════════════════════
async function transcribeClip(idx) {
  const clip = S.clips[idx];
  if (!clip) return;
  toast('מתמלל: ' + clip.name + '... (יכול לקחת דקה)', '');
  try {
    // Extract just the audio track (keeps upload small when the clip is a screen recording)
    const audioBlob = await extractAudioForTranscription(clip.blob);
    const r = await fetch('/api/transcribe', {
      method: 'POST',
      headers: { 'Content-Type': 'audio/webm' },
      body: audioBlob
    });
    const d = await r.json();
    if (!d.ok) {
      if (d.error === 'no_transcription_key') {
        toast('תמלול לא הופעל בשרת — הוסף OPENAI_API_KEY או ELEVENLABS_API_KEY', 'r');
      } else {
        toast('שגיאת תמלול: ' + (d.message || d.error), 'r');
      }
      return;
    }
    showTranscript(clip.name, d.text, d.provider);
  } catch (e) {
    toast('שגיאת תמלול: ' + e.message, 'r');
  }
}

// For MMP just send the full blob — the STT providers extract audio internally.
// (Doing MediaRecorder → audio-only re-encoding in the browser is heavier than the
// upload cost saving would be worth for typical session lengths.)
async function extractAudioForTranscription(blob) { return blob; }

function showTranscript(name, text, provider) {
  const html = \`
    <div class="modal-backdrop" id="ttBackdrop" onclick="if(event.target===this)closeTranscript()">
      <div class="modal-panel" style="max-width:640px" dir="rtl">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px">
          <h3 style="margin:0;flex:1">📝 תמלול: \${esc(name)}</h3>
          <span style="font-size:11px;color:var(--dim)">\${provider || ''}</span>
          <button onclick="closeTranscript()" style="background:none;border:none;color:var(--mid);font-size:18px;cursor:pointer">✕</button>
        </div>
        <textarea id="ttText" style="width:100%;height:280px;padding:10px;border:1px solid var(--b1);border-radius:6px;font-family:var(--sans);font-size:13px;line-height:1.6;background:var(--bg);color:var(--txt);resize:vertical" dir="rtl">\${esc(text || '(אין טקסט)')}</textarea>
        <div style="display:flex;gap:6px;margin-top:10px">
          <button class="btn-primary" style="flex:1" onclick="copyTranscript()">📋 העתק</button>
          <button class="btn-primary" style="flex:1" onclick="downloadTranscript('\${esc(name)}')">⬇ הורד .txt</button>
        </div>
      </div>
    </div>
  \`;
  document.getElementById('ttBackdrop')?.remove();
  document.body.insertAdjacentHTML('beforeend', html);
}
function closeTranscript() { document.getElementById('ttBackdrop')?.remove(); }
function copyTranscript() {
  const txt = document.getElementById('ttText')?.value || '';
  navigator.clipboard?.writeText(txt).then(() => toast('הועתק', 'g'));
}
function downloadTranscript(name) {
  const txt = document.getElementById('ttText')?.value || '';
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([txt], { type: 'text/plain;charset=utf-8' }));
  a.download = name + '.txt';
  document.body.appendChild(a); a.click(); a.remove();
}

// Download all clips as a single manifest (JSON) — browsers can't create real zips without a lib;
// but we can trigger sequential downloads which most browsers batch as a single "download all" prompt.
function downloadAllClipsZip() {
  if (!S.clips.length) return;
  S.clips.forEach((c, i) => {
    setTimeout(() => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(c.blob);
      a.download = c.name + '.webm';
      document.body.appendChild(a); a.click(); a.remove();
    }, i * 250);
  });
  toast('מוריד ' + S.clips.length + ' קליפים...', 'g');
}

// ── Boot ──────────────────────────────────────────────────
window.onload = () => {
  initTheme();
  show('landing');
  startHeartbeat();
  startOnlinePolling();
  renderSchedules();
  loadFeatures();
  initDrive();
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
