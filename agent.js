#!/usr/bin/env node
// ══════════════════════════════════════════════════════════
// StudioSync Agent — runs on the teacher's Mac
// Mouse + Keyboard + MIDI injection via IAC Driver
// ══════════════════════════════════════════════════════════

const http  = require('http');
const https = require('https');

// ── Load robotjs (mouse/keyboard) ──
let robot = null;
try {
  robot = require('robotjs');
  robot.setMouseDelay(1);
  robot.setKeyboardDelay(1);
  const sz = robot.getScreenSize();
  console.log('   🖱  Mouse/Keyboard: ready (' + sz.width + 'x' + sz.height + ')');
} catch(e) {
  console.log('   ⚠️  Mouse/Keyboard: not available (run: npm install)');
}

// ── Load MIDI (easymidi → IAC Driver) ──
let midi = null;
let midiOut = null;
try {
  midi = require('easymidi');
  const outputs = midi.getOutputs();
  console.log('   🎹 MIDI ports:', outputs.length ? outputs.join(', ') : 'none');
  // Find IAC Driver first, then any virtual port
  const iac = outputs.find(o => /IAC|Bus|Virtual|StudioSync/i.test(o));
  const port = iac || outputs[0];
  if (port) {
    midiOut = new midi.Output(port);
    console.log('   ✅ MIDI output: ' + port);
  } else {
    console.log('   ⚠️  No MIDI output port found — enable IAC Driver in Audio MIDI Setup');
  }
} catch(e) {
  console.log('   ℹ️  MIDI not available (npm install easymidi to enable)');
}

// ── Config ──
const SERVER = process.argv[2] || 'http://localhost:4444';
const SCREEN = robot ? robot.getScreenSize() : { width: 1920, height: 1080 };

console.log('\n🎛  StudioSync Agent');
console.log('   Server:', SERVER);

let clientId   = null;
let sessionCode = null;
let polling    = false;

// ── Key map: browser → robotjs ──
const KEY_MAP = {
  ' ':'space','Space':'space','Enter':'enter','Escape':'escape','Tab':'tab',
  'Backspace':'backspace','Delete':'delete',
  'ArrowUp':'up','ArrowDown':'down','ArrowLeft':'left','ArrowRight':'right',
  'Shift':'shift','Control':'control','Alt':'alt','Meta':'command',
  'CapsLock':'caps_lock',
  'F1':'f1','F2':'f2','F3':'f3','F4':'f4','F5':'f5','F6':'f6',
  'F7':'f7','F8':'f8','F9':'f9','F10':'f10','F11':'f11','F12':'f12',
  '+':'plus','-':'minus','=':'equal','[':'[',']':']','\\':'\\','/':'/',
  ';':';',"'":"'",',':',','.':'.','`':'`',
};
function mapKey(k) { return KEY_MAP[k] || (k.length === 1 ? k.toLowerCase() : null); }

// ── HTTP helpers ──
function post(path, data) {
  return new Promise((resolve, reject) => {
    const url  = new URL(path, SERVER);
    const body = JSON.stringify(data);
    const mod  = url.protocol === 'https:' ? https : http;
    const req  = mod.request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, res => {
      let s = '';
      res.on('data', d => s += d);
      res.on('end', () => { try { resolve(JSON.parse(s)); } catch { resolve({}); } });
    });
    req.on('error', reject);
    req.end(body);
  });
}

function poll() {
  return new Promise((resolve, reject) => {
    const url = new URL('/api/poll?cid=' + clientId, SERVER);
    const mod = url.protocol === 'https:' ? https : http;
    const req = mod.get(url, { timeout: 30000 }, res => {
      let s = '';
      res.on('data', d => s += d);
      res.on('end', () => { try { resolve(JSON.parse(s)); } catch { resolve({}); } });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); resolve({}); });
  });
}

// ── Handle mouse / keyboard ──
function handleInput(msg) {
  if (!robot) return;
  const x = Math.round((msg.x || 0) * SCREEN.width);
  const y = Math.round((msg.y || 0) * SCREEN.height);

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
      robot.mouseClick('left', true);
      log('🖱  DblClick @ ' + x + ',' + y);
      break;
    case 'rightclick':
      robot.moveMouse(x, y);
      robot.mouseClick('right');
      log('🖱  RightClick @ ' + x + ',' + y);
      break;
    case 'scroll':
      robot.scrollMouse(Math.round(msg.dx || 0), Math.round(msg.dy || 0));
      break;
    case 'keydown': {
      const key = mapKey(msg.key);
      if (!key) break;
      const mods = [];
      if (msg.shift) mods.push('shift');
      if (msg.ctrl)  mods.push('control');
      if (msg.alt)   mods.push('alt');
      if (msg.meta)  mods.push('command');
      try {
        mods.length ? robot.keyTap(key, mods) : robot.keyTap(key);
        log('⌨️  ' + (mods.length ? mods.join('+') + '+' : '') + key);
      } catch(e) { /* unsupported key */ }
      break;
    }
  }
}

// ── Handle MIDI ──
function handleMidi(msg) {
  if (!midiOut) {
    log('⚠️  MIDI msg received but no output port — enable IAC Driver');
    return;
  }
  try {
    switch (msg.action) {
      case 'noteon':
        midiOut.send('noteon', { note: msg.note, velocity: msg.velocity || 100, channel: msg.channel || 0 });
        log('🎹 Note ON  ' + noteToName(msg.note) + ' vel=' + (msg.velocity||100));
        break;
      case 'noteoff':
        midiOut.send('noteoff', { note: msg.note, velocity: 0, channel: msg.channel || 0 });
        log('🎹 Note OFF ' + noteToName(msg.note));
        break;
      case 'cc':
        midiOut.send('cc', { controller: msg.cc, value: msg.value, channel: msg.channel || 0 });
        log('🎛  CC ' + msg.cc + '=' + msg.value);
        break;
      case 'pitchbend':
        midiOut.send('pitch', { value: msg.value, channel: msg.channel || 0 });
        break;
    }
  } catch(e) {
    log('⚠️  MIDI error: ' + e.message);
  }
}

function noteToName(n) {
  const names = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
  return names[n % 12] + Math.floor(n / 12 - 1);
}

// ── Route all messages ──
function handleMsg(msg) {
  if (msg.type === 'remote:input') {
    handleInput(msg);
  } else if (msg.type === 'remote:midi') {
    handleMidi(msg);
  } else if (msg.type === 'peer:joined') {
    log('🎧 Joined: ' + msg.name);
  } else if (msg.type === 'peer:left') {
    log('👋 Left: ' + (msg.name || 'peer'));
  } else if (msg.type === 'chat:msg') {
    log('💬 ' + msg.name + ': ' + msg.text);
  }
}

// ── Poll loop ──
async function startPoll() {
  polling = true;
  log('✅ Listening for remote events...');
  while (polling && clientId) {
    try {
      const data = await poll();
      if (data.messages) data.messages.forEach(handleMsg);
    } catch(e) {
      await sleep(2000);
    }
  }
}

// ── Join session ──
async function joinAsAgent(code) {
  try {
    const res = await post('/api/join', {
      code,
      name:       'Agent',
      color:      '#6c47ff',
      instrument: 'Agent',
      isAgent:    true
    });
    if (!res.ok) { console.error('\n✗ Session not found: ' + code); process.exit(1); }
    clientId    = res.clientId;
    sessionCode = res.code;
    console.log('\n   ✅ Connected to session: ' + sessionCode);
    console.log('   🖱  Mouse/keyboard: ' + (robot ? 'active' : 'inactive'));
    console.log('   🎹 MIDI: ' + (midiOut ? 'active' : 'inactive'));
    console.log('\n   Press Ctrl+C to disconnect\n');
    startPoll();
  } catch(e) {
    console.error('\n✗ Connection error:', e.message);
    process.exit(1);
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function log(msg)  { console.log('   ' + msg); }

// ── Start ──
const code = process.argv[3];
if (code && /^[A-Z0-9]{3}-[A-Z0-9]{3}$/i.test(code)) {
  console.log('   Joining session: ' + code.toUpperCase() + '\n');
  joinAsAgent(code.toUpperCase());
} else {
  console.log('\n   Usage:');
  console.log('   node agent.js <server-url> <session-code>');
  console.log('   Example: node agent.js https://studiosync-nxu0.onrender.com ABC-123\n');
  console.log('   For MIDI: enable IAC Driver in Audio MIDI Setup, then install easymidi:');
  console.log('   npm install easymidi\n');
}
