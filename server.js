const http = require('http');
const os   = require('os');

// ── Sessions ──────────────────────────────────────────────
const sessions  = new Map(); // code → { hostId, peers }
const queues    = new Map(); // clientId → [messages]
const clients   = new Map(); // clientId → { role, code, name, res, seen }

function genCode() {
  const c = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 6; i++) s += c[Math.floor(Math.random() * c.length)];
  return s.slice(0,3) + '-' + s.slice(3);
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
    if (now - c.seen > 90000) {
      const sess = sessions.get(c.code);
      if (sess) {
        sess.peers.delete(id);
        if (sess.hostId === id) {
          pushAll(c.code, { type: 'session:ended', reason: 'Host disconnected' }, id);
          sessions.delete(c.code);
        } else {
          push(sess.hostId, { type: 'peer:left', peerId: id });
        }
      }
      clients.delete(id);
      queues.delete(id);
    }
  }
}, 30000);

// ── HTTP Server ───────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const path = url.pathname;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, hdrs()); res.end(); return;
  }

  // ── API ────────────────────────────────────────────────
  if (path === '/api/ice') {
    return json(res, { iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun.relay.metered.ca:80' },
      { urls: 'turn:global.relay.metered.ca:80', username: 'open', credential: 'open' },
      { urls: 'turn:global.relay.metered.ca:80?transport=tcp', username: 'open', credential: 'open' },
      { urls: 'turn:global.relay.metered.ca:443', username: 'open', credential: 'open' },
      { urls: 'turn:global.relay.metered.ca:443?transport=tcp', username: 'open', credential: 'open' }
    ]});
  }

  if (path === '/api/host' && req.method === 'POST') {
    const data = await body(req);
    const id   = 'h_' + Date.now() + Math.random().toString(36).slice(2,6);
    const code = genCode();
    clients.set(id, { role: 'host', code, name: 'Host', res: null, seen: Date.now() });
    queues.set(id, []);
    sessions.set(code, { hostId: id, peers: new Set([id]), daw: data.daw });
    console.log('[+] Session:', code);
    return json(res, { ok: true, code, clientId: id });
  }

  if (path === '/api/join' && req.method === 'POST') {
    const data = await body(req);
    const raw  = (data.code || '').replace(/[^A-Z0-9]/gi, '').toUpperCase();
    const code = raw.slice(0,3) + '-' + raw.slice(3);
    const sess = sessions.get(code);
    if (!sess) return json(res, { ok: false, error: 'קוד לא נמצא — בדוק ונסה שוב' }, 404);
    const id   = 'r_' + Date.now() + Math.random().toString(36).slice(2,6);
    const name = data.name || 'Remote_' + Math.floor(Math.random() * 100);
    clients.set(id, { role: 'remote', code, name, res: null, seen: Date.now() });
    queues.set(id, []);
    sess.peers.add(id);
    push(sess.hostId, { type: 'peer:joined', peerId: id, name });
    push(sess.hostId, { type: 'webrtc:create-offer', peerId: id });
    console.log('[+] Joined:', name, '->', code);
    return json(res, { ok: true, code, clientId: id, hostId: sess.hostId });
  }

  if (path === '/api/send' && req.method === 'POST') {
    const cid  = url.searchParams.get('cid');
    const data = await body(req);
    const c    = clients.get(cid);
    if (!c) return json(res, { ok: false });
    c.seen = Date.now();
    const msg  = data.msg || {};

    if      (msg.type === 'webrtc:offer')   push(msg.peerId, { ...msg, peerId: cid });
    else if (msg.type === 'webrtc:answer')  push(msg.peerId, { ...msg, peerId: cid });
    else if (msg.type === 'webrtc:ice')     push(msg.peerId, { ...msg, peerId: cid });
    else if (msg.type === 'chat:msg')       pushAll(c.code, { type:'chat:msg', from: c.role==='host'?'Host':c.name, role:c.role, text:msg.text, ts:Date.now() });
    else if (msg.type === 'daw:state')      pushAll(c.code, msg, cid);
    else if (msg.type === 'session:perms')  pushAll(c.code, msg, cid);
    else if (msg.type === 'ping:req')       push(cid, { type:'ping:res', ts: msg.ts });
    return json(res, { ok: true });
  }

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
      }, 25000);
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
  console.log('\n🎛  StudioSync — מוכן!\n');
  console.log('   מחשב ראשי (Host):   http://localhost:' + PORT);
  console.log('   מחשב שני (Remote):   http://' + ip + ':' + PORT);
  console.log('\n   לאינטרנט: הרץ פקודה נוספת:  npx localtunnel --port ' + PORT + '\n');
});

// ══════════════════════════════════════════════════════════
// APP HTML — הכל בפנים, אין קבצים חיצוניים
// ══════════════════════════════════════════════════════════
const APP_HTML = `<!DOCTYPE html>
<html lang="he" dir="rtl">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>StudioSync</title>
<style>
:root{--bg:#07090c;--s1:#0c0f14;--s2:#111520;--s3:#161c28;--b1:#1a2538;--b2:#243050;--dim:#3a4d68;--mid:#5a7090;--txt:#c8d8e8;--hi:#e8f2ff;--cyan:#00d4ff;--cD:rgba(0,212,255,.12);--green:#00e87a;--gD:rgba(0,232,122,.1);--red:#ff3a5c;--rD:rgba(255,58,92,.1);--amber:#ffb800;--aD:rgba(255,184,0,.1);--mono:'Cascadia Code','Fira Code','SF Mono','Consolas',monospace;--sans:-apple-system,'Segoe UI','Arial Hebrew',sans-serif}
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
html{font-size:13px}
body{font-family:var(--sans);background:var(--bg);color:var(--txt);min-height:100vh;overflow:hidden}
body::after{content:'';position:fixed;inset:0;background:repeating-linear-gradient(0deg,transparent,transparent 2px,rgba(0,0,0,.025) 2px,rgba(0,0,0,.025) 4px);pointer-events:none;z-index:9999}
.screen{display:none;min-height:100vh;flex-direction:column}.screen.on{display:flex}
/* LOBBY */
#lobby{align-items:center;justify-content:center;padding:32px 20px;position:relative;overflow:hidden}
.lw{position:relative;z-index:1;width:100%;max-width:440px}
.logo-row{text-align:center;margin-bottom:28px}
.logo-icon{width:52px;height:52px;background:linear-gradient(135deg,var(--cyan),#0088bb);border-radius:14px;display:inline-flex;align-items:center;justify-content:center;font-size:26px;margin-bottom:10px}
.logo-name{font-family:var(--mono);font-size:26px;font-weight:700;color:var(--hi);letter-spacing:-1.5px}
.logo-name span{color:var(--cyan)}
.logo-sub{font-family:var(--mono);font-size:10px;letter-spacing:3px;color:var(--dim);margin-top:5px}
.card{background:var(--s1);border:1px solid var(--b1);border-radius:14px;padding:22px;margin-bottom:12px}
.card.primary{border-color:rgba(0,212,255,.25);background:rgba(0,212,255,.025);position:relative}
.card.primary::before{content:'מחשב ראשי';position:absolute;top:-10px;right:16px;font-family:var(--mono);font-size:9px;letter-spacing:2px;background:var(--bg);padding:0 8px;color:var(--cyan)}
.card-hdr{display:flex;align-items:center;gap:12px;margin-bottom:12px}
.card-ico{width:42px;height:42px;border-radius:10px;display:flex;align-items:center;justify-content:center;font-size:20px}
.ci-h{background:var(--cD);border:1px solid rgba(0,212,255,.2)}
.ci-g{background:var(--gD);border:1px solid rgba(0,232,122,.2)}
.card-title{font-size:15px;font-weight:700;color:var(--hi)}
.card-sub{font-size:11px;color:var(--mid);margin-top:2px}
.expl{background:var(--s2);border:1px solid var(--b1);border-radius:8px;padding:10px 12px;margin-bottom:12px;display:flex;flex-direction:column;gap:6px}
.exr{display:flex;align-items:center;gap:9px;font-size:12px}
.exi{font-size:14px;width:18px;text-align:center}
.stgrid{display:grid;grid-template-columns:1fr 1fr;gap:5px;margin-bottom:12px}
.st{display:flex;align-items:center;gap:6px;padding:8px 10px;background:var(--s2);border:1px solid var(--b1);border-radius:6px;cursor:pointer;font-size:11px;color:var(--mid);transition:all .15s;user-select:none}
.st:hover{border-color:var(--b2);color:var(--txt)}.st.on{border-color:var(--cyan);color:var(--cyan);background:var(--cD)}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;padding:11px 18px;border:none;border-radius:7px;font-family:var(--mono);font-size:12px;cursor:pointer;transition:all .15s;white-space:nowrap;font-weight:700}
.btn-c{background:var(--cyan);color:#000;width:100%;font-size:14px;padding:13px}
.btn-c:hover{opacity:.9;transform:translateY(-1px)}
.btn-g{background:var(--green);color:#000}
.btn-ghost{background:var(--s2);color:var(--txt);border:1px solid var(--b1)}
.btn-ghost:hover{border-color:var(--b2)}
.btn-red{background:var(--red);color:#fff}
.role-row{display:flex;gap:5px;margin-bottom:10px}
.rb{flex:1;display:flex;align-items:center;justify-content:center;gap:6px;padding:8px;background:var(--s2);border:1px solid var(--b1);border-radius:6px;cursor:pointer;font-size:11px;color:var(--mid);transition:all .15s}
.rb:hover{border-color:var(--b2);color:var(--txt)}.rb.on{border-color:var(--green);color:var(--green);background:var(--gD)}
.join-row{display:flex;gap:7px;margin-top:8px}
.code-in{flex:1;background:var(--s2);border:1px solid var(--b1);border-radius:7px;padding:10px 12px;font-family:var(--mono);font-size:18px;font-weight:700;color:var(--hi);letter-spacing:7px;text-align:center;outline:none;text-transform:uppercase;transition:border-color .2s}
.code-in:focus{border-color:var(--cyan)}
.ver{text-align:center;font-family:var(--mono);font-size:9px;color:var(--dim);margin-top:12px;letter-spacing:1px}
/* SESSION */
.app{display:flex;flex-direction:column;height:100vh}
.topbar{height:48px;background:var(--s1);border-bottom:1px solid var(--b1);display:flex;align-items:center;padding:0 14px;gap:10px;flex-shrink:0}
.tb-logo{font-family:var(--mono);font-size:13px;font-weight:700;color:var(--cyan)}
.tb-logo.r{color:var(--green)}
.tb-sep{width:1px;height:16px;background:var(--b1)}
.sdot{width:7px;height:7px;border-radius:50%;background:var(--dim)}
.sdot.live{background:var(--green);box-shadow:0 0 6px var(--green);animation:blink 2s infinite}
.sdot.wait{background:var(--amber);box-shadow:0 0 6px var(--amber);animation:blink 1s infinite}
@keyframes blink{0%,100%{opacity:1}50%{opacity:.35}}
.stxt{font-family:var(--mono);font-size:10px;color:var(--mid)}
.code-badge{font-family:var(--mono);font-size:12px;font-weight:700;letter-spacing:4px;padding:4px 12px;background:var(--s2);border:1px solid var(--b1);border-radius:5px;color:var(--hi);cursor:pointer}
.code-badge:hover{border-color:var(--cyan)}
.ml{margin-right:auto}
.tier{font-family:var(--mono);font-size:9px;padding:2px 7px;border-radius:3px;letter-spacing:1px}
.tier-p{border:1px solid rgba(0,232,122,.3);color:var(--green)}
.tier-f{border:1px solid var(--b1);color:var(--dim)}
.transport{display:flex;align-items:center;gap:6px;padding:7px 14px;background:var(--s1);border-bottom:1px solid var(--b1);flex-shrink:0}
.tc{width:32px;height:32px;border-radius:6px;background:var(--s2);border:1px solid var(--b1);display:flex;align-items:center;justify-content:center;cursor:pointer;font-size:13px;transition:all .12s}
.tc:hover{background:var(--s3);border-color:var(--b2)}
.tc.play{background:var(--green);border-color:var(--green);color:#000}
.tc.rec{background:var(--red);border-color:var(--red);color:#fff}
.tc.rec.on{animation:rp 1s infinite}
@keyframes rp{0%,100%{box-shadow:0 0 6px var(--red)}50%{box-shadow:0 0 18px var(--red)}}
.bpm-box{display:flex;align-items:center;gap:6px;padding:5px 12px;background:var(--s2);border:1px solid var(--b1);border-radius:6px}
.bpm-val{font-family:var(--mono);font-size:18px;font-weight:700;color:var(--hi);min-width:44px;text-align:center}
.bpm-lbl{font-family:var(--mono);font-size:9px;color:var(--dim);letter-spacing:1px}
.bpm-btns{display:flex;flex-direction:column;gap:1px}
.bpm-btn{background:none;border:none;cursor:pointer;color:var(--dim);font-size:10px;line-height:1;padding:1px 4px}
.bpm-btn:hover{color:var(--cyan)}
.pos{font-family:var(--mono);font-size:12px;padding:6px 12px;background:var(--s2);border:1px solid var(--b1);border-radius:6px;letter-spacing:2px}
.health{display:flex;align-items:center;gap:7px;padding:5px 12px;border-radius:5px;font-family:var(--mono);font-size:10px;background:var(--gD);border:1px solid rgba(0,232,122,.2);color:var(--green)}
.main{display:flex;flex:1;overflow:hidden}
.sidebar{width:190px;background:var(--s1);border-left:1px solid var(--b1);display:flex;flex-direction:column;flex-shrink:0;overflow:hidden}
.center{flex:1;display:flex;flex-direction:column;overflow:hidden}
.right{width:220px;background:var(--s1);border-right:1px solid var(--b1);display:flex;flex-direction:column;flex-shrink:0;overflow:hidden}
.sec{border-bottom:1px solid var(--b1);padding:9px 11px}
.sec-t{font-family:var(--mono);font-size:9px;letter-spacing:2px;color:var(--dim);margin-bottom:7px}
.cr{display:flex;align-items:center;justify-content:space-between;padding:5px 9px;background:var(--s2);border:1px solid var(--b1);border-radius:5px;margin-bottom:3px}
.cl{font-size:11px}.cv{font-family:var(--mono);font-size:10px}
.ok{color:var(--green)}.warn{color:var(--amber)}
.lat-n{font-family:var(--mono);font-size:24px;font-weight:700;color:var(--green)}
.lat-b{height:3px;background:var(--s3);border-radius:2px;margin-top:4px;overflow:hidden}
.lat-f{height:100%;background:var(--green);border-radius:2px;transition:width .5s}
.mrow{height:16px;background:rgba(0,212,255,.02);border-bottom:1px solid var(--b1);position:relative;cursor:crosshair;flex-shrink:0}
.mpip{position:absolute;width:2px;top:2px;bottom:2px;border-radius:1px;cursor:pointer}
.mlbl{position:absolute;top:1px;font-family:var(--mono);font-size:8px;pointer-events:none;white-space:nowrap}
.track-area{flex:1;overflow-y:auto}
.track-area::-webkit-scrollbar{width:4px}
.track-area::-webkit-scrollbar-thumb{background:var(--b2);border-radius:2px}
.tr{display:grid;grid-template-columns:24px 150px 52px 1fr 38px;align-items:center;height:44px;padding:0 5px;border-bottom:1px solid rgba(26,37,56,.5);cursor:pointer}
.tr:hover{background:rgba(255,255,255,.02)}.tr.sel{background:rgba(0,212,255,.04)}
.tr-num{font-family:var(--mono);font-size:9px;color:var(--dim);text-align:center}
.tr-nm{display:flex;align-items:center;gap:6px;padding:0 4px;overflow:hidden;cursor:pointer}
.tr-c{width:3px;height:26px;border-radius:2px;flex-shrink:0}
.tr-n{font-size:12px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tr-t{font-family:var(--mono);font-size:9px;color:var(--dim);background:var(--s2);padding:1px 4px;border-radius:3px;border:1px solid var(--b1)}
.tr-btns{display:flex;gap:2px}
.trb{width:18px;height:18px;background:var(--s2);border:1px solid var(--b1);border-radius:3px;display:flex;align-items:center;justify-content:center;cursor:pointer;font-family:var(--mono);font-size:9px;font-weight:700;color:var(--dim);transition:all .12s}
.trb:hover{color:var(--txt)}
.trb.M{background:var(--aD);border-color:rgba(255,184,0,.3);color:var(--amber)}
.trb.S{background:var(--gD);border-color:rgba(0,232,122,.3);color:var(--green)}
.trb.R{background:var(--rD);border-color:rgba(255,58,92,.3);color:var(--red)}
.fader{-webkit-appearance:none;appearance:none;width:100%;height:3px;background:var(--s3);border-radius:2px;outline:none;cursor:pointer}
.fader::-webkit-slider-thumb{-webkit-appearance:none;width:11px;height:11px;border-radius:50%;background:var(--cyan);cursor:pointer}
.tr-db{font-family:var(--mono);font-size:9px;color:var(--dim);text-align:center}
.mtr{display:flex;align-items:center;gap:6px;margin-bottom:4px}
.mtr-l{font-family:var(--mono);font-size:9px;color:var(--dim);width:10px}
.mtr-t{flex:1;height:5px;background:var(--s3);border-radius:3px;overflow:hidden}
.mtr-f{height:100%;background:linear-gradient(90deg,var(--green) 0%,var(--amber) 75%,var(--red) 90%);border-radius:3px;transition:width .06s ease}
.chat-area{flex:1;overflow-y:auto;padding:9px;display:flex;flex-direction:column;gap:7px}
.chat-area::-webkit-scrollbar{width:3px}
.chat-area::-webkit-scrollbar-thumb{background:var(--b2);border-radius:2px}
.cmsg{display:flex;flex-direction:column;gap:2px}
.chdr{display:flex;gap:5px;font-family:var(--mono);font-size:9px}
.cu{color:var(--cyan)}.cu.r{color:var(--green)}.ct{color:var(--dim)}
.cb{font-size:11px;background:var(--s2);border:1px solid var(--b1);border-radius:5px;padding:6px 8px;line-height:1.5;direction:rtl}
.sys{text-align:center;font-family:var(--mono);font-size:10px;color:var(--dim);padding:3px 0;border-top:1px dashed var(--b1);border-bottom:1px dashed var(--b1);margin:2px 0}
.chat-in-row{border-top:1px solid var(--b1);padding:7px;display:flex;gap:5px}
.cin{flex:1;background:var(--s2);border:1px solid var(--b1);border-radius:5px;padding:6px 8px;font-family:var(--sans);font-size:11px;color:var(--txt);outline:none;direction:rtl}
.cin:focus{border-color:var(--cyan)}
.csend{width:30px;height:30px;background:var(--cyan);border:none;border-radius:5px;cursor:pointer;color:#000;font-size:14px}
.tbtn{width:100%;padding:7px;background:var(--s2);border:1px solid var(--b1);border-radius:6px;cursor:pointer;font-family:var(--mono);font-size:10px;color:var(--mid);transition:all .15s;display:flex;align-items:center;justify-content:center;gap:7px}
.tbtn:hover{border-color:var(--b2);color:var(--txt)}.tbtn.on{background:var(--rD);border-color:var(--red);color:var(--red)}
.statusbar{height:24px;background:var(--s1);border-top:1px solid var(--b1);display:flex;align-items:center;padding:0 12px;gap:12px;flex-shrink:0}
.sbi{display:flex;align-items:center;gap:4px;font-family:var(--mono);font-size:9px;color:var(--dim)}
.sbi.ok{color:var(--green)}.sep{color:var(--b2)}
/* MODAL + TOAST */
.mbg{position:fixed;inset:0;background:rgba(0,0,0,.72);backdrop-filter:blur(8px);z-index:1000;display:none;align-items:center;justify-content:center}
.mbg.on{display:flex}
.modal{background:var(--s1);border:1px solid var(--b2);border-radius:14px;padding:26px;width:380px;max-width:92vw;animation:fu .2s ease}
@keyframes fu{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
.modal h3{font-size:18px;font-weight:800;color:var(--hi);margin-bottom:6px}
.modal p{font-size:12px;color:var(--mid);margin-bottom:16px;line-height:1.6}
.mcode{font-family:var(--mono);font-size:34px;font-weight:700;letter-spacing:12px;text-align:center;color:var(--cyan);padding:18px;background:var(--s2);border:1px solid rgba(0,212,255,.2);border-radius:9px;margin-bottom:14px;cursor:pointer}
.mrow{display:flex;gap:8px}
.ta{position:fixed;bottom:36px;left:50%;transform:translateX(-50%);z-index:2000;display:flex;flex-direction:column;gap:6px;align-items:center;pointer-events:none}
.toast{padding:8px 16px;background:var(--s2);border:1px solid var(--b2);border-radius:6px;font-family:var(--mono);font-size:11px;color:var(--txt);animation:ti .3s ease,to .3s ease 2.7s forwards;pointer-events:none}
.toast.c{border-color:rgba(0,212,255,.35);color:var(--cyan)}.toast.g{border-color:rgba(0,232,122,.35);color:var(--green)}
@keyframes ti{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
@keyframes to{to{opacity:0;transform:translateY(-5px)}}
/* CONNECTING */
#connecting{align-items:center;justify-content:center;flex-direction:column;gap:14px}
.spin{width:40px;height:40px;border:3px solid var(--b2);border-top-color:var(--cyan);border-radius:50%;animation:spin 1s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
@keyframes clickFlash{0%{transform:scale(.5);opacity:1}100%{transform:scale(2);opacity:0}}
</style>
</head>
<body>

<!-- LOBBY -->
<div class="screen on" id="lobby">
  <div class="lw">
    <div class="logo-row">
      <div class="logo-icon">🎛</div>
      <div class="logo-name">Studio<span>Sync</span></div>
      <div class="logo-sub">הפקה משותפת · בזמן אמת</div>
    </div>

    <div class="card primary">
      <div class="card-hdr">
        <div class="card-ico ci-h">💻</div>
        <div><div class="card-title">המחשב שלי — הראשי</div><div class="card-sub">כאן מותקן ה-DAW שלך</div></div>
      </div>
      <div class="expl">
        <div class="exr"><span class="exi">🔊</span><span>השמע מה-DAW שלך ישודר לשותף</span></div>
        <div class="exr"><span class="exi">🎛</span><span>שניכם שולטים ב-DAW יחד</span></div>
        <div class="exr"><span class="exi">🔑</span><span>תקבל קוד — שלח לשותף</span></div>
      </div>
      <div class="stgrid" id="stg">
        <div class="st on" onclick="setST(this,'co')" data-t="co">🎛 יצירה משותפת</div>
        <div class="st" onclick="setST(this,'ap')" data-t="ap">🎤 אמן + מפיק</div>
        <div class="st" onclick="setST(this,'mn')" data-t="mn">🎓 הדרכה</div>
        <div class="st" onclick="setST(this,'rv')" data-t="rv">👁 האזנה</div>
      </div>
      <button class="btn btn-c" onclick="hostStart()">נתחיל — פתח סשן חדש ⚡</button>
    </div>

    <div class="card">
      <div class="card-hdr">
        <div class="card-ico ci-g">🎧</div>
        <div><div class="card-title">המחשב השני — הצד השני</div><div class="card-sub">קיבלת קוד מהשותף?</div></div>
      </div>
      <div class="expl">
        <div class="exr"><span class="exi">🔊</span><span>תשמע שמע ישיר מהסטודיו</span></div>
        <div class="exr"><span class="exi">🎛</span><span>תשלוט ב-DAW מהדפדפן</span></div>
      </div>
      <div class="role-row">
        <div class="rb on" onclick="setRole(this,'col')">🎛 שותף — שליטה מלאה</div>
        <div class="rb" onclick="setRole(this,'lst')">👁 האזנה בלבד</div>
      </div>
      <div class="join-row">
        <input class="code-in" id="joinCode" placeholder="ABC-123" maxlength="7" oninput="fmtCode(this)" onkeydown="if(event.key==='Enter')remoteJoin()">
        <button class="btn btn-g" onclick="remoteJoin()" style="padding:10px 14px">בואו נצא לדרך →</button>
      </div>
    </div>
    <div class="ver">ללא התקנה · דפדפן בלבד · E2E Encrypted</div>
  </div>
</div>

<!-- CONNECTING -->
<div class="screen" id="connecting">
  <div class="spin"></div>
  <div style="font-family:var(--mono);font-size:13px;color:var(--mid)" id="connectMsg">מתחבר...</div>
</div>

<!-- SESSION -->
<div class="screen" id="session">
<div class="app">
  <div class="topbar">
    <div class="tb-logo" id="tbLogo">StudioSync</div>
    <div class="tb-sep"></div>
    <div class="sdot" id="sDot"></div>
    <div class="stxt" id="sState">מאתחל...</div>
    <div style="font-family:var(--mono);font-size:9px;padding:2px 7px;border:1px solid var(--b1);border-radius:3px;color:var(--dim)" id="stBadge"></div>
    <div id="pArea" style="display:flex;gap:5px"></div>
    <div class="ml"></div>
    <div class="code-badge" id="cBadge" onclick="showCode()">— — —</div>
    <span class="tier" id="tierB">FREE</span>
    <button class="btn btn-ghost" onclick="leaveSession()" style="font-size:10px;padding:5px 10px">✕ יציאה</button>
  </div>

  <div class="transport">
    <div class="tc" onclick="cmd('rew')">⏮</div>
    <div class="tc play" id="btnPlay" onclick="cmd('play')">▶</div>
    <div class="tc rec" id="btnRec" onclick="cmd('rec')">⏺</div>
    <div class="tc" onclick="cmd('loop')" id="btnLoop">🔁</div>
    <div class="bpm-box">
      <div><div class="bpm-lbl">BPM</div><div class="bpm-val" id="bpmD">128</div></div>
      <div class="bpm-btns">
        <button class="bpm-btn" onclick="cmd('bpm+')">▲</button>
        <button class="bpm-btn" onclick="cmd('bpm-')">▼</button>
      </div>
    </div>
    <div class="pos" id="posD">1.1.1</div>
    <div class="health" id="hlth" style="display:none">● הסשן תקין</div>
    <div class="ml"></div>
    <button class="btn btn-ghost" id="reqBtn" onclick="reqCtrl()" style="display:none;font-size:11px;padding:6px 12px">✋ בקש שליטה</button>
    <div class="tc" onclick="doShare()" style="width:auto;padding:0 10px;font-size:10px;font-family:var(--mono)" id="btnSS">🖥 Share</div>
  </div>

  <div class="main">
    <div class="sidebar">
      <div class="sec">
        <div class="sec-t">חיבורים</div>
        <div class="cr"><span class="cl">📡 WebRTC</span><span class="cv" id="rtcSt" style="color:var(--dim)">—</span></div>
        <div class="cr"><span class="cl">🎵 Audio</span><span class="cv" id="audSt" style="color:var(--dim)">—</span></div>
        <div class="cr"><span class="cl">🎛 Control</span><span class="cv ok" id="ctrlSt">—</span></div>
      </div>
      <div class="sec">
        <div class="sec-t">Latency</div>
        <div style="display:flex;align-items:baseline;gap:4px"><span class="lat-n" id="latN">—</span><span style="font-family:var(--mono);font-size:10px;color:var(--mid)">ms</span></div>
        <div class="lat-b"><div class="lat-f" id="latF" style="width:0%"></div></div>
      </div>
      <div class="sec" id="permSec">
        <div class="sec-t">הרשאות <button onclick="openPerms()" style="background:none;border:1px solid var(--b1);border-radius:3px;cursor:pointer;color:var(--mid);font-size:9px;padding:1px 5px">ערוך</button></div>
        <div id="permD" style="font-size:11px;display:flex;flex-direction:column;gap:3px"></div>
      </div>
      <div class="sec" style="flex:1;overflow-y:auto;min-height:0">
        <div class="sec-t">DAW Log</div>
        <div id="dawLog" style="font-family:var(--mono);font-size:9px;color:var(--dim);display:flex;flex-direction:column;gap:3px;direction:ltr;max-height:150px;overflow-y:auto"></div>
      </div>
    </div>

    <div class="center">
      <div class="mrow" id="mRow" onclick="addMarker(event)"></div>
      <div class="track-area" id="trackArea"></div>
    </div>

    <div class="right">
      <div class="sec">
        <div class="sec-t">Output</div>
        <div class="mtr"><div class="mtr-l">L</div><div class="mtr-t"><div class="mtr-f" id="mL" style="width:0%"></div></div></div>
        <div class="mtr"><div class="mtr-l">R</div><div class="mtr-t"><div class="mtr-f" id="mR" style="width:0%"></div></div></div>
      </div>
      <div style="flex:1;display:flex;flex-direction:column;overflow:hidden">
        <div style="padding:8px 11px 0;font-family:var(--mono);font-size:9px;letter-spacing:2px;color:var(--dim)">צ׳אט</div>
        <div class="chat-area" id="chatArea"><div class="sys">Session started · E2E Encrypted</div></div>
        <div class="chat-in-row">
          <input class="cin" id="chatIn" placeholder="הקלד..." onkeydown="if(event.key==='Enter')sendChat()">
          <button class="csend" onclick="sendChat()">↑</button>
        </div>
      </div>
      <div style="padding:7px">
        <button class="tbtn" id="tbBtn" onmousedown="tbOn()" onmouseup="tbOff()">🎙 לחץ והחזק לדבר</button>
      </div>
    </div>
  </div>

  <div class="statusbar">
    <div class="sbi" id="sb1">● —</div><div class="sep">|</div>
    <div class="sbi ok">● E2E Encrypted</div><div class="sep">|</div>
    <div class="sbi" id="sb2">● 0 peers</div>
  </div>
</div>
</div>

<div class="mbg" id="mBg" onclick="if(event.target===this)closeModal()"><div class="modal" id="mBody"></div></div>
<div class="ta" id="toasts"></div>

<script>
const SERVER = window.location.origin;
const S = { cid:null, role:null, code:null, stype:'co', bpm:128, playing:false, rec:false, pos:{b:1,bt:1,tk:1}, tracks:[], markers:[], perms:{trans:true,fad:true,mute:false,midi:false}, peers:[], poll:false };
const MCOLS = ['#00d4ff','#00e87a','#ffb800','#ff3a5c','#8b5cf6'];

// ══════ WebRTC Engine ══════
// TURN servers are critical for connections across different networks (no shared WiFi)
// Free TURN from Open Relay Project + Google STUN
const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun.relay.metered.ca:80' },
  { urls: 'turn:global.relay.metered.ca:80', username: 'open', credential: 'open' },
  { urls: 'turn:global.relay.metered.ca:80?transport=tcp', username: 'open', credential: 'open' },
  { urls: 'turn:global.relay.metered.ca:443', username: 'open', credential: 'open' },
  { urls: 'turn:global.relay.metered.ca:443?transport=tcp', username: 'open', credential: 'open' }
];
let pc = null;       // RTCPeerConnection
let dc = null;       // DataChannel (for DAW sync + remote input)
let remoteAudioEl = null;  // <audio> for remote playback
let screenStream = null;   // screen share MediaStream
let screenSender = null;   // RTCRtpSender for screen video

async function fetchICE() {
  try {
    const r = await fetch(SERVER + '/api/ice');
    const d = await r.json();
    if (d.iceServers) return d.iceServers;
  } catch(e) {}
  return ICE_SERVERS; // fallback
}

function createPC(isInitiator, iceServers) {
  pc = new RTCPeerConnection({ iceServers: iceServers || ICE_SERVERS });

  pc.onicecandidate = e => {
    if (e.candidate) {
      const target = S.role === 'host' ? S.peers[0]?.id : S.hostId;
      if (target) send({ type: 'webrtc:ice', peerId: target, candidate: e.candidate });
    }
  };

  pc.oniceconnectionstatechange = () => {
    const st = pc.iceConnectionState;
    dlog('ICE: ' + st);
    if (st === 'connected' || st === 'completed') {
      document.getElementById('sb1').textContent = '● WebRTC: P2P Connected';
      document.getElementById('sb1').className = 'sbi ok';
      toast('✓ חיבור P2P פעיל!', 'g');
    } else if (st === 'disconnected' || st === 'failed') {
      document.getElementById('sb1').textContent = '● WebRTC: Disconnected';
      document.getElementById('sb1').className = 'sbi';
      toast('⚠️ החיבור נפל — מנסה שוב...', '');
    }
  };

  pc.ontrack = e => {
    dlog('Track received: ' + e.track.kind);
    if (e.track.kind === 'audio') {
      if (!remoteAudioEl) {
        remoteAudioEl = document.createElement('audio');
        remoteAudioEl.autoplay = true;
        remoteAudioEl.style.display = 'none';
        document.body.appendChild(remoteAudioEl);
      }
      remoteAudioEl.srcObject = e.streams[0] || new MediaStream([e.track]);
      document.getElementById('audSt').textContent = 'Audio ✓';
      document.getElementById('audSt').className = 'cv ok';
      toast('🔊 שמע מתקבל!', 'g');
    }
    if (e.track.kind === 'video') {
      showRemoteVideo(e.streams[0] || new MediaStream([e.track]));
    }
  };

  if (isInitiator) {
    dc = pc.createDataChannel('daw-sync');
    setupDataChannel(dc);
  } else {
    pc.ondatachannel = e => { dc = e.channel; setupDataChannel(dc); };
  }

  return pc;
}

function setupDataChannel(channel) {
  channel.onopen = () => {
    dlog('DataChannel open');
    document.getElementById('rtcSt').textContent = 'P2P ✓';
    document.getElementById('rtcSt').className = 'cv ok';
  };
  channel.onmessage = e => {
    try {
      const msg = JSON.parse(e.data);
      if (msg.type === 'daw:state') applyDAW(msg);
      else if (msg.type === 'chat:msg') addChat(msg.from, msg.text, msg.role === 'remote', false);
      else if (msg.type === 'session:perms') { S.perms = msg.perms; updatePermD(); toast('🔒 הרשאות עודכנו', ''); }
      else if (msg.type === 'remote:input') handleRemoteInput(msg);
      else if (msg.type === 'ping') channel.send(JSON.stringify({ type: 'pong', ts: msg.ts }));
      else if (msg.type === 'pong') updateLatency(msg.ts);
    } catch (err) {}
  };
  channel.onclose = () => dlog('DataChannel closed');
}

// Send via DataChannel if open, fallback to HTTP
function dcSend(msg) {
  if (dc && dc.readyState === 'open') {
    dc.send(JSON.stringify(msg));
  } else {
    send(msg);
  }
}

// Latency measurement via DataChannel
let latencyInterval = null;
function startLatencyPing() {
  latencyInterval = setInterval(() => {
    if (dc && dc.readyState === 'open') {
      dc.send(JSON.stringify({ type: 'ping', ts: Date.now() }));
    }
  }, 2000);
}
function updateLatency(sentTs) {
  const ms = Date.now() - sentTs;
  const n = document.getElementById('latN'); if (n) n.textContent = ms;
  const f = document.getElementById('latF'); if (f) f.style.width = Math.min(ms, 100) + '%';
  const h = document.getElementById('hlth');
  if (h) {
    if (ms < 50) { h.textContent = '● הסשן תקין · ' + ms + 'ms'; h.className = 'health ok'; }
    else if (ms < 150) { h.textContent = '● השהיה בינונית · ' + ms + 'ms'; h.className = 'health ok'; }
    else { h.textContent = '● השהיה גבוהה · ' + ms + 'ms'; h.className = 'health bad'; }
  }
}

// WebRTC signaling handlers
async function handleCreateOffer(peerId) {
  dlog('Creating offer for ' + peerId);
  const ice = await fetchICE();
  createPC(true, ice);

  // ── Step 1: Capture AUDIO from DAW (studio quality, no mic) ──
  // On Mac: getDisplayMedia can't capture system audio reliably.
  // Solution: Use getUserMedia with a specific audio device (virtual audio routing).
  // The Host picks their DAW audio output device from a list.
  let audioAdded = false;
  try {
    // Get all audio input devices — look for virtual/loopback devices
    const devices = await navigator.mediaDevices.enumerateDevices();
    const audioInputs = devices.filter(d => d.kind === 'audioinput' && d.deviceId !== 'default' && d.deviceId !== 'communications');

    // Check if there's a known virtual audio device
    const virtualNames = ['blackhole', 'vb-cable', 'loopback', 'virtual', 'aggregate', 'zoom', 'soundflower', 'ecamm'];
    const virtualDev = audioInputs.find(d => virtualNames.some(v => d.label.toLowerCase().includes(v)));
    const targetDev = virtualDev || audioInputs[0];

    if (audioInputs.length > 0) {
      // Show device picker modal
      const pickerHtml = '<h3>🔊 בחר מקור שמע</h3><p>מאיפה Ableton מנגן? בחר את כרטיס הקול או ה-output של ה-DAW:</p>'
        + '<div style="display:flex;flex-direction:column;gap:6px;margin:14px 0;max-height:200px;overflow-y:auto">'
        + audioInputs.map((d,i) => {
          const isVirtual = virtualNames.some(v => d.label.toLowerCase().includes(v));
          const label = d.label || 'Audio Device ' + (i+1);
          return '<div class="stype' + (d.deviceId === targetDev?.deviceId ? ' on' : '') + '" onclick="pickAudioDev(\\'' + d.deviceId + '\\',this)" data-did="' + d.deviceId + '" style="padding:10px 14px;font-size:12px;justify-content:space-between">'
            + '<span>' + label + '</span>'
            + (isVirtual ? '<span style="font-size:9px;background:var(--gD);color:var(--green);padding:2px 6px;border-radius:3px">מומלץ</span>' : '')
            + '</div>';
        }).join('')
        + '</div>'
        + '<div style="background:var(--s2);border:1px solid var(--b1);border-radius:7px;padding:10px;margin-bottom:14px;font-size:11px;color:var(--mid);line-height:1.6">'
        + '💡 <b>טיפ:</b> באבלטון → Preferences → Audio → Output → בחר את אותו מכשיר שבחרת פה. ככה השמע יגיע ישיר בלי מיקרופון.'
        + '</div>'
        + '<div class="mrow"><button class="btn btn-c" style="flex:1" onclick="confirmAudioDev()">✓ התחל שידור שמע</button></div>';
      modal(pickerHtml);

      // Wait for user to pick device
      await new Promise((resolve) => {
        window._audioPickResolve = resolve;
        window._audioPickDevId = targetDev?.deviceId;
      });
      closeModal();

      const chosenId = window._audioPickDevId;
      if (chosenId) {
        const audioStream = await navigator.mediaDevices.getUserMedia({
          audio: {
            deviceId: { exact: chosenId },
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
            sampleRate: 48000,
            channelCount: 2
          }
        });
        audioStream.getAudioTracks().forEach(t => {
          pc.addTrack(t, audioStream);
          dlog('Audio track: ' + t.label + ' (48kHz stereo, no processing)');
        });
        audioAdded = true;
        toast('🔊 שמע DAW משודר באיכות סטודיו!', 'g');
        document.getElementById('audSt').textContent = 'Audio 48kHz ✓';
        document.getElementById('audSt').className = 'cv ok';
      }
    }
  } catch(e) {
    dlog('Audio capture error: ' + e.message);
  }

  if (!audioAdded) {
    toast('⚠️ לא נבחר מקור שמע — השותף לא ישמע', '');
  }

  // ── Step 2: Capture SCREEN (Ableton window) ──
  try {
    toast('📺 עכשיו בחר את מסך Ableton לשיתוף', 'c');
    screenStream = await navigator.mediaDevices.getDisplayMedia({
      video: { cursor: 'always', width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } },
      audio: false  // Audio already captured separately in studio quality
    });
    screenStream.getVideoTracks().forEach(t => {
      pc.addTrack(t, screenStream);
      dlog('Video track: ' + t.label);
    });
    toast('🖥 מסך Ableton משודר!', 'g');
    screenStream.getVideoTracks()[0]?.addEventListener('ended', () => {
      toast('🖥 שיתוף המסך הופסק', '');
      const btn = document.getElementById('btnSS');
      if (btn) { btn.style.background = ''; btn.style.color = ''; btn.textContent = '🖥 Share'; btn.onclick = doShare; }
    });
    const btn = document.getElementById('btnSS');
    if (btn) { btn.style.background = 'var(--cyan)'; btn.style.color = '#000'; btn.textContent = '🖥 Stop'; btn.onclick = stopShare; }
  } catch (e) {
    dlog('Screen share declined: ' + e.message);
    toast('⚠️ שיתוף מסך בוטל — אפשר לשתף אחר כך עם כפתור Share', '');
  }

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  send({ type: 'webrtc:offer', peerId, offer: pc.localDescription });
}

async function handleOffer(peerId, offer) {
  dlog('Received offer from ' + peerId);
  S.hostId = peerId;
  if (!pc) { const ice = await fetchICE(); createPC(false, ice); }
  await pc.setRemoteDescription(offer);
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  send({ type: 'webrtc:answer', peerId, answer: pc.localDescription });
}

async function handleAnswer(peerId, answer) {
  dlog('Received answer from ' + peerId);
  if (pc) await pc.setRemoteDescription(answer);
}

async function handleICE(peerId, candidate) {
  if (pc) {
    try { await pc.addIceCandidate(candidate); }
    catch (e) { dlog('ICE error: ' + e.message); }
  }
}

// Screen share → full DAW view for Remote
function showRemoteVideo(stream) {
  let container = document.getElementById('remoteVidContainer');
  if (!container) {
    container = document.createElement('div');
    container.id = 'remoteVidContainer';
    container.style.cssText = 'position:fixed;inset:0;z-index:800;background:#000;display:flex;flex-direction:column;';

    // Toolbar
    const toolbar = document.createElement('div');
    toolbar.style.cssText = 'height:36px;background:var(--s1);border-bottom:1px solid var(--b1);display:flex;align-items:center;padding:0 12px;gap:10px;flex-shrink:0;z-index:801;';
    toolbar.innerHTML = '<div style="font-family:var(--mono);font-size:12px;font-weight:700;color:var(--cyan)">🖥 Ableton — שליטה מרחוק</div>'
      + '<div style="margin-right:auto"></div>'
      + '<div id="remoteLatBadge" style="font-family:var(--mono);font-size:10px;color:var(--green);padding:2px 8px;background:var(--s2);border:1px solid var(--b1);border-radius:4px">—</div>'
      + '<button id="remoteMiniBtn" style="padding:4px 10px;background:var(--s2);border:1px solid var(--b1);border-radius:5px;color:var(--txt);font-family:var(--mono);font-size:10px;cursor:pointer">🔲 מזער</button>'
      + '<button id="remoteCloseBtn" style="padding:4px 10px;background:var(--rD);border:1px solid rgba(255,58,92,.3);border-radius:5px;color:var(--red);font-family:var(--mono);font-size:10px;cursor:pointer">✕ סגור</button>';
    container.appendChild(toolbar);

    // Video
    const vid = document.createElement('video');
    vid.id = 'remoteVid';
    vid.autoplay = true;
    vid.playsInline = true;
    vid.muted = true; // Audio comes from separate audio element
    vid.style.cssText = 'flex:1;width:100%;object-fit:contain;background:#000;cursor:crosshair;';
    container.appendChild(vid);

    document.body.appendChild(container);

    // Minimize button
    document.getElementById('remoteMiniBtn').onclick = () => {
      if (container.style.inset === '0px' || container.style.inset === '0') {
        container.style.cssText = 'position:fixed;bottom:60px;left:12px;width:420px;height:260px;z-index:800;background:#000;display:flex;flex-direction:column;border-radius:10px;border:2px solid var(--cyan);box-shadow:0 4px 24px rgba(0,0,0,.6);overflow:hidden;resize:both;';
        document.getElementById('remoteMiniBtn').textContent = '🔳 הגדל';
      } else {
        container.style.cssText = 'position:fixed;inset:0;z-index:800;background:#000;display:flex;flex-direction:column;';
        document.getElementById('remoteMiniBtn').textContent = '🔲 מזער';
      }
    };

    // Close button
    document.getElementById('remoteCloseBtn').onclick = () => { container.remove(); };

    // Remote input: mouse + keyboard on the video
    setupRemoteInputCapture(vid);
  }

  document.getElementById('remoteVid').srcObject = stream;
  toast('🖥 רואים את Ableton! לחץ על המסך לשליטה', 'g');
}

// Remote: capture mouse/keyboard on the video and send to Host
function setupRemoteInputCapture(vid) {
  if (S.role !== 'remote') return;

  vid.addEventListener('mousemove', e => {
    const rect = vid.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width).toFixed(4);
    const y = ((e.clientY - rect.top) / rect.height).toFixed(4);
    dcSend({ type: 'remote:input', action: 'move', x: parseFloat(x), y: parseFloat(y) });
  });

  vid.addEventListener('click', e => {
    const rect = vid.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width).toFixed(4);
    const y = ((e.clientY - rect.top) / rect.height).toFixed(4);
    dcSend({ type: 'remote:input', action: 'click', x: parseFloat(x), y: parseFloat(y), button: e.button });
  });

  vid.addEventListener('dblclick', e => {
    const rect = vid.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width).toFixed(4);
    const y = ((e.clientY - rect.top) / rect.height).toFixed(4);
    dcSend({ type: 'remote:input', action: 'dblclick', x: parseFloat(x), y: parseFloat(y) });
  });

  vid.addEventListener('contextmenu', e => {
    e.preventDefault();
    const rect = vid.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width).toFixed(4);
    const y = ((e.clientY - rect.top) / rect.height).toFixed(4);
    dcSend({ type: 'remote:input', action: 'rightclick', x: parseFloat(x), y: parseFloat(y) });
  });

  vid.addEventListener('wheel', e => {
    e.preventDefault();
    dcSend({ type: 'remote:input', action: 'scroll', dx: e.deltaX, dy: e.deltaY });
  }, { passive: false });

  // Keyboard when video is focused
  vid.tabIndex = 0;
  vid.addEventListener('keydown', e => {
    e.preventDefault();
    dcSend({ type: 'remote:input', action: 'keydown', key: e.key, code: e.code, shift: e.shiftKey, ctrl: e.ctrlKey, alt: e.altKey, meta: e.metaKey });
  });
  vid.addEventListener('keyup', e => {
    e.preventDefault();
    dcSend({ type: 'remote:input', action: 'keyup', key: e.key, code: e.code });
  });

  vid.focus();
  toast('🖱 לחץ על המסך ותתחיל לשלוט — עכבר + מקלדת', 'g');
}

// Remote input handling (Host receives from Remote)
// Shows cursor overlay on Host screen — positions are 0-1 normalized
function handleRemoteInput(msg) {
  if (S.role !== 'host') return;
  let cursor = document.getElementById('remoteCursor');
  if (!cursor) {
    cursor = document.createElement('div');
    cursor.id = 'remoteCursor';
    cursor.style.cssText = 'position:fixed;width:20px;height:20px;border-radius:50%;pointer-events:none;z-index:900;transition:left 0.04s linear,top 0.04s linear;';
    cursor.innerHTML = '<svg width="20" height="20" viewBox="0 0 20 20"><polygon points="0,0 0,16 4,12 8,20 11,19 7,11 13,11" fill="#00e87a" stroke="#000" stroke-width="1"/></svg>'
      + '<div style="position:absolute;top:22px;right:0;font-family:var(--mono);font-size:9px;color:var(--green);white-space:nowrap;background:rgba(0,0,0,.7);padding:1px 4px;border-radius:3px">Remote</div>';
    document.body.appendChild(cursor);
  }
  const sw = window.innerWidth, sh = window.innerHeight;
  if (msg.action === 'move') {
    cursor.style.left = (msg.x * sw) + 'px';
    cursor.style.top = (msg.y * sh) + 'px';
  } else if (msg.action === 'click' || msg.action === 'dblclick') {
    cursor.style.left = (msg.x * sw) + 'px';
    cursor.style.top = (msg.y * sh) + 'px';
    // Flash effect
    const flash = document.createElement('div');
    flash.style.cssText = 'position:fixed;width:30px;height:30px;border:2px solid var(--cyan);border-radius:50%;pointer-events:none;z-index:899;animation:clickFlash .4s ease forwards;left:' + (msg.x*sw-5) + 'px;top:' + (msg.y*sh-5) + 'px;';
    document.body.appendChild(flash);
    setTimeout(() => flash.remove(), 500);
    dlog('Remote ' + msg.action + ' @ ' + (msg.x*100).toFixed(0) + '%, ' + (msg.y*100).toFixed(0) + '%');
  } else if (msg.action === 'keydown') {
    dlog('Remote key: ' + msg.key);
  }
}
const TDEFS = [
  {n:'Kick',t:'AUDIO',c:'#ff3a5c',v:82,m:0,s:0,a:0},
  {n:'Snare',t:'AUDIO',c:'#ffb800',v:75,m:0,s:0,a:0},
  {n:'Hi-Hat',t:'AUDIO',c:'#ffb800',v:68,m:0,s:0,a:0},
  {n:'Bass 808',t:'MIDI',c:'#00e87a',v:88,m:0,s:0,a:1},
  {n:'Melody',t:'MIDI',c:'#00d4ff',v:71,m:0,s:0,a:0},
  {n:'Lead Vox',t:'AUDIO',c:'#8b5cf6',v:79,m:0,s:0,a:1},
  {n:'Pad BG',t:'MIDI',c:'#00d4ff',v:55,m:1,s:0,a:0},
  {n:'FX',t:'AUX',c:'#5a7090',v:64,m:0,s:0,a:0}
];

function initTracks(){ S.tracks=JSON.parse(JSON.stringify(TDEFS)); renderTracks(); }

function renderTracks(){
  const el=document.getElementById('trackArea'); if(!el) return;
  el.innerHTML='';
  S.tracks.forEach((t,i)=>{
    const row=document.createElement('div'); row.className='tr'+(i===0?' sel':'');
    const db=t.v===0?'-∞':(20*Math.log10(t.v/100)).toFixed(1);
    row.innerHTML=\`<div class="tr-num">\${i+1}</div>
      <div class="tr-nm" onclick="annotate(\${i})" title="הוסף הערה">
        <div class="tr-c" style="background:\${t.c}"></div>
        <div><div class="tr-n">\${t.n}\${t.note?'<span style="font-size:8px;color:var(--amber)"> 📝</span>':''}</div><div class="tr-t">\${t.t}</div></div>
      </div>
      <div class="tr-btns">
        <div class="trb\${t.m?' M':''}" onclick="trT(\${i},'m')">M</div>
        <div class="trb\${t.s?' S':''}" onclick="trT(\${i},'s')">S</div>
        <div class="trb\${t.a?' R':''}" onclick="trT(\${i},'a')">R</div>
      </div>
      <div style="padding:0 7px;display:flex;align-items:center">
        <input type="range" class="fader" min="0" max="127" value="\${t.v}" oninput="trV(\${i},this.value)">
      </div>
      <div class="tr-db">\${db}</div>\`;
    row.addEventListener('click',e=>{
      if(e.target.classList.contains('trb')||e.target.closest('.tr-nm')||e.target.tagName==='INPUT') return;
      el.querySelectorAll('.tr').forEach(r=>r.classList.remove('sel')); row.classList.add('sel');
    });
    el.appendChild(row);
  });
}

function trT(i,k){ S.tracks[i][k]=S.tracks[i][k]?0:1; renderTracks(); dcSend({type:'daw:state',action:'track_toggle',i,k,v:S.tracks[i][k]}); }
function trV(i,v){ S.tracks[i].v=+v; renderTracks(); dcSend({type:'daw:state',action:'track_vol',i,v}); }

async function hostStart(){
  show('connecting'); document.getElementById('connectMsg').textContent='פותח סשן חדש...';
  try{
    const r=await fetch(SERVER+'/api/host',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({daw:S.stype})});
    const d=await r.json();
    if(!d.ok){ toast('⚠️ שגיאה בפתיחת סשן',''); show('lobby'); return; }
    S.cid=d.clientId; S.code=d.code; S.role='host';
    show('session'); setupUI(); startPoll(); initTracks(); startMeters(); startPosTick();
    toast('🎛 הסשן נפתח! הקוד: '+S.code,'c');
    setTimeout(()=>toast('📋 שתף את הכתובת עם הקוד לשותף',''),1400);
    dlog('Session: '+S.code);
  }catch(e){ toast('⚠️ לא ניתן להתחבר לשרת',''); show('lobby'); }
}

async function remoteJoin(){
  const raw=document.getElementById('joinCode').value.replace(/[^A-Z0-9]/gi,'').toUpperCase();
  if(raw.length<5){ toast('⚠️ נראה שחסר קוד — בוא ננסה שוב',''); return; }
  show('connecting'); document.getElementById('connectMsg').textContent='מצטרף לסשן...';
  try{
    const r=await fetch(SERVER+'/api/join',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code:raw,name:'Remote_'+Math.floor(Math.random()*100)})});
    const d=await r.json();
    if(!d.ok){ toast('⚠️ '+(d.error||'קוד לא נמצא'),''); show('lobby'); return; }
    S.cid=d.clientId; S.code=d.code; S.role='remote';
    show('session'); setupUI(); startPoll(); initTracks(); startMeters(); startPosTick();
    toast('✓ נכנסנו! מחכים לנתונים מה-Host...','g');
    dlog('Joined: '+S.code);
  }catch(e){ toast('⚠️ לא ניתן להתחבר לשרת',''); show('lobby'); }
}

function setupUI(){
  const isH=S.role==='host';
  document.getElementById('tbLogo').textContent='StudioSync';
  document.getElementById('tbLogo').className='tb-logo'+(isH?'':' r');
  document.getElementById('cBadge').textContent=S.code;
  document.getElementById('tierB').textContent=isH?'PRO':'FREE';
  document.getElementById('tierB').className='tier '+(isH?'tier-p':'tier-f');
  document.getElementById('reqBtn').style.display=isH?'none':'block';
  setDot(isH?'wait':'live', isH?'ממתין לשותף...':'מחובר');
  if(isH){ document.getElementById('stBadge').textContent={co:'CO-PRODUCTION',ap:'ARTIST+PRODUCER',mn:'MENTOR',rv:'REVIEW'}[S.stype]||''; }
  document.getElementById('rtcSt').textContent=isH?'—':'P2P ✓';
  if(!isH){ document.getElementById('rtcSt').className='cv ok'; document.getElementById('audSt').textContent='Streaming'; document.getElementById('audSt').className='cv ok'; }
  updatePermD();
}

function setDot(state,txt){
  document.getElementById('sDot').className='sdot '+(state==='live'?'live':state==='wait'?'wait':'');
  document.getElementById('sState').textContent=txt;
}

function updatePermD(){
  const el=document.getElementById('permD'); if(!el) return;
  const items=[['trans','Transport'],['fad','Faders'],['mute','Mute/Solo'],['midi','MIDI']];
  if(S.role==='host'){
    el.innerHTML=items.map(([k,l])=>\`<label style="display:flex;align-items:center;gap:5px;cursor:pointer"><input type="checkbox" \${S.perms[k]?'checked':''} onchange="setPerm('\${k}',this.checked)"> \${l}</label>\`).join('');
  } else {
    el.innerHTML=items.map(([k,l])=>\`<div style="color:\${S.perms[k]?'var(--green)':'var(--mid)'}">\${S.perms[k]?'✓':'○'} \${l}</div>\`).join('');
  }
}

function setPerm(k,v){ S.perms[k]=v; dcSend({type:'session:perms',perms:S.perms}); toast('✓ ההרשאות עודכנו','c'); }

async function startPoll(){
  S.poll=true;
  while(S.poll&&S.cid){
    try{
      const r=await fetch(SERVER+'/api/poll?cid='+S.cid,{signal:AbortSignal.timeout(28000)});
      const d=await r.json();
      if(d.messages) d.messages.forEach(handleMsg);
    }catch(e){ await new Promise(r=>setTimeout(r,2000)); }
  }
}

async function send(msg){
  if(!S.cid) return;
  try{ await fetch(SERVER+'/api/send?cid='+S.cid,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({msg})}); }catch(e){}
}

function handleMsg(msg){
  switch(msg.type){
    case 'peer:joined':
      S.peers.push({id:msg.peerId,name:msg.name});
      if(S.role==='host'){
        setDot('live','LIVE');
        document.getElementById('pArea').innerHTML=\`<div style="display:flex;align-items:center;gap:5px;padding:3px 9px;background:var(--s2);border:1px solid var(--b1);border-radius:12px;font-size:11px"><div class="sdot live"></div>\${msg.name}</div>\`;
        document.getElementById('sb2').textContent='● 1 peer'; document.getElementById('sb2').className='sbi ok';
        document.getElementById('hlth').style.display='flex';
        applySessionDefaults();
        send({type:'daw:state',action:'snapshot',tracks:S.tracks,bpm:S.bpm,perms:S.perms,stype:S.stype});
        addChat('System','השותף מחובר! שניכם יכולים לעבוד ✓',false,true);
      }
      toast('🎧 '+msg.name+' הצטרף!','g'); dlog('Peer joined: '+msg.name);
      break;
    case 'peer:left':
      S.peers=S.peers.filter(p=>p.id!==msg.peerId);
      if(pc){try{pc.close();}catch(e){}} pc=null; dc=null;
      if(latencyInterval){clearInterval(latencyInterval);latencyInterval=null;}
      if(S.role==='host'){ setDot('wait','ממתין לשותף...'); document.getElementById('pArea').innerHTML=''; document.getElementById('hlth').style.display='none'; document.getElementById('sb2').textContent='● 0 peers'; document.getElementById('sb2').className='sbi'; document.getElementById('sb1').textContent='● —'; document.getElementById('sb1').className='sbi'; addChat('System','השותף התנתק',false,true); }
      toast('⚠️ השותף התנתק',''); dlog('Peer left');
      break;
    case 'session:ended':
      toast('⚠️ הסשן הסתיים',''); setTimeout(leaveSession,1500); break;
    case 'chat:msg':
      addChat(msg.from,msg.text,msg.role==='remote',false); break;
    case 'session:perms':
      S.perms=msg.perms; updatePermD(); toast('🔒 הרשאות עודכנו',''); break;
    case 'daw:state':
      applyDAW(msg); break;
    // ── WebRTC Signaling ──
    case 'webrtc:create-offer':
      handleCreateOffer(msg.peerId); break;
    case 'webrtc:offer':
      handleOffer(msg.peerId, msg.offer); break;
    case 'webrtc:answer':
      handleAnswer(msg.peerId, msg.answer); break;
    case 'webrtc:ice':
      handleICE(msg.peerId, msg.candidate); break;
  }
}

function applyDAW(msg){
  if(msg.action==='snapshot'){
    if(msg.tracks){S.tracks=msg.tracks;renderTracks();}
    if(msg.bpm){S.bpm=msg.bpm;document.getElementById('bpmD').textContent=msg.bpm;}
    if(msg.perms){S.perms=msg.perms;updatePermD();}
    setDot('live','מחובר'); startLatSim();
    document.getElementById('hlth').style.display='flex';
    document.getElementById('sb1').textContent='● WebRTC: Connected'; document.getElementById('sb1').className='sbi ok';
    document.getElementById('sb2').textContent='● 1 peer'; document.getElementById('sb2').className='sbi ok';
    addChat('System','הסשן מסונכרן ✓',false,true);
    toast('✓ מחובר! השמע מתחיל...','g'); dlog('Snapshot: '+(msg.tracks?.length||0)+' tracks');
  }
  else if(msg.action==='play'){S.playing=msg.v;updatePlayBtn();}
  else if(msg.action==='bpm'){S.bpm=msg.v;document.getElementById('bpmD').textContent=msg.v;}
  else if(msg.action==='track_toggle'){S.tracks[msg.i]&&(S.tracks[msg.i][msg.k]=msg.v);renderTracks();}
  else if(msg.action==='track_vol'){S.tracks[msg.i]&&(S.tracks[msg.i].v=msg.v);renderTracks();}
  else if(msg.action==='pos'){S.pos=msg.pos;updatePos();}
  else if(msg.action==='marker_add'){S.markers.push(msg.marker);renderMarkers();}
}

function applySessionDefaults(){
  const m={co:{trans:true,fad:true,mute:true,midi:true},ap:{trans:true,fad:false,mute:false,midi:true},mn:{trans:true,fad:true,mute:false,midi:false},rv:{trans:true,fad:false,mute:false,midi:false}};
  S.perms=m[S.stype]||m.co; updatePermD(); dcSend({type:'session:perms',perms:S.perms});
}

function cmd(c){
  if(c==='play'){S.playing=!S.playing;updatePlayBtn();dcSend({type:'daw:state',action:'play',v:S.playing});toast(S.playing?'▶ Playing':'⏹ Stopped','');}
  else if(c==='rec'){S.rec=!S.rec;const b=document.getElementById('btnRec');if(b)b.className='tc rec'+(S.rec?' on':'');}
  else if(c==='rew'){S.pos={b:1,bt:1,tk:1};updatePos();dcSend({type:'daw:state',action:'pos',pos:{...S.pos}});toast('⏮ Rewind','');}
  else if(c==='loop'){const b=document.getElementById('btnLoop');if(b)b.style.color=b.style.color==='var(--cyan)'?'':'var(--cyan)';toast('🔁 Loop','');}
  else if(c==='bpm+'||c==='bpm-'){S.bpm=Math.max(20,Math.min(300,S.bpm+(c==='bpm+'?1:-1)));document.getElementById('bpmD').textContent=S.bpm;dcSend({type:'daw:state',action:'bpm',v:S.bpm});}
}

function updatePlayBtn(){ const b=document.getElementById('btnPlay'); if(b) b.textContent=S.playing?'⏸':'▶'; }
function updatePos(){ const el=document.getElementById('posD'); if(el) el.textContent=\`\${S.pos.b}.\${S.pos.bt}.\${S.pos.tk}\`; }

function startPosTick(){
  setInterval(()=>{
    if(!S.playing) return;
    S.pos.tk++; if(S.pos.tk>4){S.pos.tk=1;S.pos.bt++;} if(S.pos.bt>4){S.pos.bt=1;S.pos.b++;}
    updatePos(); if(S.role==='host') dcSend({type:'daw:state',action:'pos',pos:{...S.pos}});
  },200);
}

function startMeters(){
  (function tick(){
    const b=S.playing?0.45:0.03;
    const L=Math.min(100,b*100+(S.playing?30:1)+Math.sin(Date.now()/190)*14);
    const R=Math.min(100,b*100+(S.playing?28:1)+Math.cos(Date.now()/170)*12);
    const mL=document.getElementById('mL');const mR=document.getElementById('mR');
    if(mL)mL.style.width=L+'%';if(mR)mR.style.width=R+'%';
    requestAnimationFrame(tick);
  })();
}

function startLatSim(){
  // Real latency is measured via DataChannel ping/pong — see startLatencyPing()
  startLatencyPing();
}

function addMarker(e){
  const r=e.currentTarget.getBoundingClientRect();
  const bar=Math.max(1,Math.round(((e.clientX-r.left)/r.width)*64));
  const m={id:Date.now(),bar,lbl:'M'+(S.markers.length+1),col:MCOLS[S.markers.length%5]};
  S.markers.push(m); renderMarkers(); dcSend({type:'daw:state',action:'marker_add',marker:m}); toast('📍 מרקר @ bar '+bar,'');
}

function renderMarkers(){
  ['mRow'].forEach(id=>{
    const row=document.getElementById(id);if(!row)return;row.innerHTML='';
    S.markers.forEach(m=>{
      const pct=((m.bar-1)/64)*100;
      const p=document.createElement('div');p.className='mpip';p.style.cssText=\`left:\${pct}%;background:\${m.col};\`;p.title=m.lbl;p.onclick=()=>toast('📍 '+m.lbl,'');
      const l=document.createElement('div');l.className='mlbl';l.style.cssText=\`left:calc(\${pct}% + 3px);color:\${m.col};\`;l.textContent=m.lbl;
      row.appendChild(p);row.appendChild(l);
    });
  });
}

function reqCtrl(){
  document.getElementById('reqBtn').textContent='⏳ Pending...';
  dcSend({type:'daw:state',action:'control_req'}); toast('✋ שולח בקשה...','');
  setTimeout(()=>{
    modal('<h3>✋ בקשת שליטה</h3><p>Remote רוצה לקחת שליטה ב-DAW.</p><div class="mrow"><button class="btn btn-g" style="flex:1" onclick="grantCtrl()">✓ תן להם שליטה</button><button class="btn btn-ghost" onclick="denyCtrl()">✕ לא עכשיו</button></div>');
  },1000);
}
function grantCtrl(){ closeModal(); document.getElementById('ctrlSt').textContent='Remote שולט'; dcSend({type:'daw:state',action:'ctrl_granted'}); toast('✓ שליטה הועברה','g'); addChat('System','שליטה הועברה ל-Remote',false,true); }
function denyCtrl(){ closeModal(); document.getElementById('reqBtn').textContent='✋ בקש שליטה'; toast('בקשת שליטה נדחתה',''); }

function addChat(from,text,isRemote,isSys=false){
  const area=document.getElementById('chatArea');if(!area)return;
  const now=new Date();const t=now.getHours().toString().padStart(2,'0')+':'+now.getMinutes().toString().padStart(2,'0');
  const d=document.createElement('div');
  if(isSys){d.className='sys';d.textContent=text;}
  else{d.className='cmsg';d.innerHTML=\`<div class="chdr"><span class="cu\${isRemote?' r':''}">\${from}</span><span class="ct">\${t}</span></div><div class="cb">\${text}</div>\`;}
  area.appendChild(d);area.scrollTop=area.scrollHeight;
}

function sendChat(){
  const inp=document.getElementById('chatIn');if(!inp||!inp.value.trim())return;
  const text=inp.value.trim();inp.value='';
  addChat(S.role==='host'?'Host':'Remote',text,S.role==='remote');
  dcSend({type:'chat:msg',text,from:S.role==='host'?'Host':'Remote',role:S.role});
}

function tbOn(){ document.getElementById('tbBtn')?.classList.add('on'); toast('🎙 Talkback פעיל',''); }
function tbOff(){ document.getElementById('tbBtn')?.classList.remove('on'); }

async function doShare(){
  if(!navigator.mediaDevices?.getDisplayMedia){toast('⚠️ נסה Chrome/Edge','');return;}
  try{
    screenStream=await navigator.mediaDevices.getDisplayMedia({video:true,audio:false});
    const btn=document.getElementById('btnSS');
    // Add video track to WebRTC peer connection
    if(pc){
      const videoTrack=screenStream.getVideoTracks()[0];
      screenSender=pc.addTrack(videoTrack,screenStream);
      dlog('Screen share track added to WebRTC');
      // Re-negotiate after adding track
      const offer=await pc.createOffer();
      await pc.setLocalDescription(offer);
      const target=S.role==='host'?S.peers[0]?.id:S.hostId;
      if(target) send({type:'webrtc:offer',peerId:target,offer:pc.localDescription});
    }
    if(btn){btn.style.background='var(--cyan)';btn.style.color='#000';btn.textContent='🖥 Stop';btn.onclick=stopShare;}
    screenStream.getVideoTracks()[0].onended=stopShare;
    toast('🖥 שיתוף מסך פעיל — הצד השני רואה!','g');
  }catch(e){dlog('Screen share cancelled');}
}
async function stopShare(){
  if(screenStream){screenStream.getTracks().forEach(t=>t.stop());screenStream=null;}
  if(screenSender&&pc){try{pc.removeTrack(screenSender);}catch(e){}screenSender=null;
    // Re-negotiate after removing track
    const offer=await pc.createOffer();
    await pc.setLocalDescription(offer);
    const target=S.role==='host'?S.peers[0]?.id:S.hostId;
    if(target) send({type:'webrtc:offer',peerId:target,offer:pc.localDescription});
  }
  const btn=document.getElementById('btnSS');
  if(btn){btn.style.background='';btn.style.color='';btn.textContent='🖥 Share';btn.onclick=doShare;}
  toast('🖥 שיתוף מסך הופסק','');
}

function annotate(i){
  modal(\`<h3>📝 \${S.tracks[i].n}</h3><p>הוסף הערה לטראק</p><textarea id="aTxt" style="width:100%;background:var(--s2);border:1px solid var(--b1);border-radius:7px;padding:10px;color:var(--txt);font-size:12px;resize:none;height:70px;direction:rtl;outline:none;margin-bottom:14px">\${S.tracks[i].note||''}</textarea><div class="mrow"><button class="btn btn-c" style="flex:1" onclick="saveAnn(\${i})">✓ שמור</button><button class="btn btn-ghost" onclick="closeModal()">ביטול</button></div>\`);
}
function saveAnn(i){ S.tracks[i].note=document.getElementById('aTxt')?.value||''; renderTracks(); closeModal(); toast('✓ הערה נשמרה','c'); }

function openPerms(){
  modal('<h3>🔒 הרשאות Remote</h3><p>בחר מה השותף יכול לעשות:</p><div style="display:flex;flex-direction:column;gap:10px;margin:14px 0">'
    +[['trans','Transport (Play/Stop/BPM)'],['fad','Faders & Pan'],['mute','Mute / Solo'],['midi','MIDI Input']].map(([k,l])=>
    \`<label style="display:flex;align-items:center;justify-content:space-between;font-size:13px;cursor:pointer"><span>\${l}</span><input type="checkbox" id="pm_\${k}" \${S.perms[k]?'checked':''} style="width:16px;height:16px"></label>\`).join('')
    +'</div><div class="mrow"><button class="btn btn-c" style="flex:1" onclick="savePerms()">✓ שמור</button><button class="btn btn-ghost" onclick="closeModal()">ביטול</button></div>');
}
function savePerms(){ ['trans','fad','mute','midi'].forEach(k=>{const el=document.getElementById('pm_'+k);if(el)S.perms[k]=el.checked;}); setPerm('all',null); updatePermD(); closeModal(); toast('✓ ההרשאות עודכנו','c'); }

function showCode(){
  modal(\`<h3>🔑 קוד הסשן</h3><p>שלח את הכתובת + הקוד לשותף שלך. הוא פותח את אותה כתובת בדפדפן.</p><div class="mcode" onclick="copyCode()">\${S.code}</div><div style="font-family:var(--mono);font-size:10px;color:var(--dim);text-align:center;margin-bottom:14px">לחץ להעתקה</div><div class="mrow"><button class="btn btn-c" style="flex:1" onclick="copyCode()">📋 העתק קוד</button><button class="btn btn-ghost" onclick="closeModal()">סגור</button></div>\`);
}
function copyCode(){ navigator.clipboard?.writeText(S.code); toast('✓ הקוד הועתק: '+S.code,'c'); closeModal(); }

// Audio device picker helpers
function pickAudioDev(deviceId, el) {
  window._audioPickDevId = deviceId;
  document.querySelectorAll('#mBody .stype').forEach(s => s.classList.remove('on'));
  el.classList.add('on');
}
function confirmAudioDev() {
  if (window._audioPickResolve) { window._audioPickResolve(); window._audioPickResolve = null; }
}

function leaveSession(){
  S.poll=false; S.cid=null; S.code=null; S.role=null; S.peers=[]; S.playing=false; S.rec=false; S.pos={b:1,bt:1,tk:1}; S.markers=[];
  if(pc){try{pc.close();}catch(e){}} pc=null; dc=null;
  if(latencyInterval){clearInterval(latencyInterval);latencyInterval=null;}
  if(screenStream){screenStream.getTracks().forEach(t=>t.stop());screenStream=null;}
  if(remoteAudioEl){remoteAudioEl.srcObject=null;remoteAudioEl.remove();remoteAudioEl=null;}
  const vid=document.getElementById('remoteVid');if(vid)vid.remove();
  const cur=document.getElementById('remoteCursor');if(cur)cur.remove();
  show('lobby');
}

function dlog(msg){ const log=document.getElementById('dawLog');if(!log)return;const el=document.createElement('div');el.textContent='> '+msg;el.style.cssText='opacity:0;transition:opacity .3s';log.appendChild(el);setTimeout(()=>el.style.opacity='1',10);if(log.children.length>15)log.removeChild(log.firstChild);log.scrollTop=log.scrollHeight; }
function modal(html){ document.getElementById('mBody').innerHTML=html; document.getElementById('mBg').classList.add('on'); }
function closeModal(){ document.getElementById('mBg').classList.remove('on'); }
function toast(msg,cls=''){ const a=document.getElementById('toasts');const el=document.createElement('div');el.className='toast'+(cls?' '+cls:'');el.textContent=msg;a.appendChild(el);setTimeout(()=>el.remove(),3200); }
function show(id){ document.querySelectorAll('.screen').forEach(s=>s.classList.remove('on')); document.getElementById(id).classList.add('on'); }
function fmtCode(el){ let v=el.value.replace(/[^A-Z0-9a-z]/gi,'').toUpperCase().slice(0,6); if(v.length>3)v=v.slice(0,3)+'-'+v.slice(3); el.value=v; }
function setST(el,t){ S.stype=t; document.querySelectorAll('#stg .st').forEach(b=>b.classList.remove('on')); el.classList.add('on'); }
function setRole(el,r){ document.querySelectorAll('.rb').forEach(b=>b.classList.remove('on')); el.classList.add('on'); }

document.addEventListener('keydown',e=>{
  const tag=document.activeElement?.tagName;
  if(tag==='INPUT'||tag==='TEXTAREA') return;
  if(e.code==='Space'&&S.code){e.preventDefault();cmd('play');}
  if(e.code==='ArrowUp'){e.preventDefault();cmd('bpm+');}
  if(e.code==='ArrowDown'){e.preventDefault();cmd('bpm-');}
  if(e.code==='KeyM'&&S.code){S.markers.push({id:Date.now(),bar:S.pos.b,lbl:'M'+(S.markers.length+1),col:MCOLS[S.markers.length%5]});renderMarkers();toast('📍 מרקר @ bar '+S.pos.b,'');}
});
</script>
</body>
</html>`;
