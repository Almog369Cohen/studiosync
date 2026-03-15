#!/usr/bin/env node
// ══════════════════════════════════════════════════════════
// StudioSync Agent — רץ על מחשב המורה
// מזריק עכבר ומקלדת אמיתיים + תופס שמע מכרטיס הקול
// ══════════════════════════════════════════════════════════

const robot = require('robotjs');
const http = require('http');
const https = require('https');

// ── Config ──
const SERVER = process.argv[2] || 'http://localhost:4444';
const screen = robot.getScreenSize();
console.log('\n🎛  StudioSync Agent');
console.log('   שרת:', SERVER);
console.log('   מסך:', screen.width + 'x' + screen.height);

// Speed up mouse movement
robot.setMouseDelay(2);
robot.setKeyboardDelay(2);

let clientId = null;
let sessionCode = null;
let polling = false;

// ── Key mapping: browser key names → robotjs key names ──
const KEY_MAP = {
  ' ': 'space', 'Space': 'space',
  'Enter': 'enter', 'Escape': 'escape', 'Tab': 'tab',
  'Backspace': 'backspace', 'Delete': 'delete',
  'ArrowUp': 'up', 'ArrowDown': 'down', 'ArrowLeft': 'left', 'ArrowRight': 'right',
  'Shift': 'shift', 'Control': 'control', 'Alt': 'alt', 'Meta': 'command',
  'CapsLock': 'caps_lock',
  'F1': 'f1', 'F2': 'f2', 'F3': 'f3', 'F4': 'f4', 'F5': 'f5',
  'F6': 'f6', 'F7': 'f7', 'F8': 'f8', 'F9': 'f9', 'F10': 'f10',
  'F11': 'f11', 'F12': 'f12',
  '+': 'plus', '-': 'minus', '=': 'equal',
  '[': '[', ']': ']', '\\': '\\', '/': '/',
  ';': ';', "'": "'", ',': ',', '.': '.', '`': '`',
};

function mapKey(browserKey) {
  if (KEY_MAP[browserKey]) return KEY_MAP[browserKey];
  // Single character keys
  if (browserKey.length === 1) return browserKey.toLowerCase();
  return null;
}

// ── HTTP/HTTPS helpers ──
const client = SERVER.startsWith('https') ? https : http;

function post(path, data) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, SERVER);
    const body = JSON.stringify(data);
    const mod = url.protocol === 'https:' ? https : http;
    const req = mod.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, res => {
      let s = '';
      res.on('data', d => s += d);
      res.on('end', () => { try { resolve(JSON.parse(s)); } catch { resolve({}); } });
    });
    req.on('error', reject);
    req.end(body);
  });
}

function get(path) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, SERVER);
    const mod = url.protocol === 'https:' ? https : http;
    mod.get(url, { timeout: 30000 }, res => {
      let s = '';
      res.on('data', d => s += d);
      res.on('end', () => { try { resolve(JSON.parse(s)); } catch { resolve({}); } });
    }).on('error', reject);
  });
}

// ── Handle remote input — the magic happens here ──
function handleInput(msg) {
  if (msg.type !== 'remote:input') return;

  const x = Math.round((msg.x || 0) * screen.width);
  const y = Math.round((msg.y || 0) * screen.height);

  switch (msg.action) {
    case 'move':
      robot.moveMouse(x, y);
      break;

    case 'click':
      robot.moveMouse(x, y);
      robot.mouseClick(msg.button === 2 ? 'right' : 'left');
      log('🖱  Click @ ' + x + ',' + y);
      break;

    case 'dblclick':
      robot.moveMouse(x, y);
      robot.mouseClick('left', true); // double click
      log('🖱  DblClick @ ' + x + ',' + y);
      break;

    case 'rightclick':
      robot.moveMouse(x, y);
      robot.mouseClick('right');
      log('🖱  RightClick @ ' + x + ',' + y);
      break;

    case 'scroll':
      robot.scrollMouse(msg.dx || 0, msg.dy || 0);
      break;

    case 'keydown': {
      const key = mapKey(msg.key);
      if (!key) break;
      const mods = [];
      if (msg.shift) mods.push('shift');
      if (msg.ctrl) mods.push('control');
      if (msg.alt) mods.push('alt');
      if (msg.meta) mods.push('command');
      try {
        if (mods.length > 0) {
          robot.keyTap(key, mods);
        } else {
          robot.keyTap(key);
        }
        log('⌨️  Key: ' + (mods.length ? mods.join('+') + '+' : '') + key);
      } catch (e) {
        // Some keys may not be supported
      }
      break;
    }
  }
}

// ── Handle all messages from polling ──
function handleMsg(msg) {
  if (msg.type === 'remote:input') {
    handleInput(msg);
  } else if (msg.type === 'peer:joined') {
    log('🎧 שותף מחובר: ' + msg.name);
  } else if (msg.type === 'peer:left') {
    log('⚠️  שותף התנתק');
  } else if (msg.type === 'webrtc:create-offer') {
    // Agent doesn't handle WebRTC — the browser does
  } else if (msg.type === 'chat:msg') {
    log('💬 ' + msg.from + ': ' + msg.text);
  }
}

// ── Polling loop ──
async function startPoll() {
  polling = true;
  while (polling && clientId) {
    try {
      const data = await get('/api/poll?cid=' + clientId);
      if (data.messages) {
        data.messages.forEach(handleMsg);
      }
    } catch (e) {
      await sleep(2000);
    }
  }
}

// ── Create or join session ──
async function hostSession() {
  try {
    const res = await post('/api/host', { daw: 'ableton' });
    if (!res.ok) { console.error('✗ שגיאה בפתיחת סשן'); process.exit(1); }
    clientId = res.clientId;
    sessionCode = res.code;
    console.log('\n   ✓ סשן נפתח!');
    console.log('   📋 קוד: ' + sessionCode);
    console.log('   🔗 שלח לתלמיד: ' + SERVER);
    console.log('\n   ממתין לתלמיד...\n');
    startPoll();
  } catch (e) {
    console.error('✗ לא מצליח להתחבר לשרת:', e.message);
    console.error('   וודא שהשרת רץ:', SERVER);
    process.exit(1);
  }
}

// ── Also register as a special agent client ──
async function joinAsAgent(code) {
  try {
    const res = await post('/api/join', { code, name: 'Agent (Mouse+Keyboard)' });
    if (!res.ok) { console.error('✗ קוד לא נמצא'); process.exit(1); }
    clientId = res.clientId;
    sessionCode = res.code;
    console.log('\n   ✓ Agent מחובר לסשן ' + sessionCode);
    console.log('   🖱  שליטת עכבר ומקלדת פעילה');
    console.log('   ⌨️  כל מה שהתלמיד לוחץ — מופעל על המחשב שלך\n');
    startPoll();
  } catch (e) {
    console.error('✗ שגיאה:', e.message);
    process.exit(1);
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function log(msg) { process.stdout.write('\r   ' + msg + '                    \n'); }

// ── Start ──
const arg = process.argv[3];
if (arg && arg.match(/^[A-Z0-9]{3}-[A-Z0-9]{3}$/i)) {
  // Join existing session: node agent.js http://localhost:4567 ABC-123
  console.log('   מצטרף לסשן: ' + arg);
  joinAsAgent(arg);
} else {
  console.log('\n   שימוש:');
  console.log('   node agent.js <server-url> <session-code>');
  console.log('   דוגמה: node agent.js https://studiosync-nxu0.onrender.com ABC-123');
  console.log('\n   ה-Agent מצטרף לסשן קיים ומזריק עכבר+מקלדת אמיתיים');
  console.log('   הפעל אותו אחרי שפתחת סשן בדפדפן\n');
}
