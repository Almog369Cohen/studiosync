/**
 * StudioSync — DAW Bridge Agent
 * ===============================
 * Runs on the HOST machine (the studio computer).
 * Bridges between:
 *   - DAW  ←→  OSC/MIDI  ←→  this agent  ←→  WebRTC DataChannel  ←→  Remote
 *   - Virtual Audio Device  →  WebRTC Audio Track  →  Remote
 *
 * Per-DAW support:
 *   ableton  : AbletonOSC (UDP 11000)
 *   logic    : OSC UDP 8000 (Logic Control Surface protocol)
 *   cubase   : MIDI Remote JS API (virtual MIDI port)
 *   fl       : MIDI CC + MMC (virtual MIDI port)
 *   protools : HUI emulation (virtual MIDI port)
 *
 * npm install osc easymidi node-record-lpcm16 ws
 */

'use strict';

const osc       = require('osc');
const midi      = require('easymidi');
const { spawn } = require('child_process');
const WebSocket = require('ws');

// ── Config ────────────────────────────────────────────────────
const CONFIG = {
  daw:            process.env.DAW          || 'ableton',  // ableton|logic|cubase|fl|protools
  oscLocalPort:   parseInt(process.env.OSC_LOCAL_PORT)  || 11000,
  oscRemotePort:  parseInt(process.env.OSC_REMOTE_PORT) || 11001,
  oscHost:        process.env.OSC_HOST     || '127.0.0.1',
  midiPortName:   process.env.MIDI_PORT    || 'StudioSync',
  audioDevice:    process.env.AUDIO_DEVICE || 'BlackHole 2ch',  // or 'VB-Cable Output'
  signalingUrl:   process.env.SIGNALING    || 'ws://localhost:3001',
  sampleRate:     parseInt(process.env.SAMPLE_RATE) || 48000,
  bitDepth:       parseInt(process.env.BIT_DEPTH)   || 16,
  channels:       parseInt(process.env.CHANNELS)    || 2,
};

// ── State ─────────────────────────────────────────────────────
const state = {
  dawConnected:   false,
  peers:          new Map(),   // peerId → { dataChannel, perms }
  isPlaying:      false,
  bpm:            120,
  tracks:         [],
  audioStream:    null,
};

// ── OSC Setup ─────────────────────────────────────────────────
let oscPort = null;

function initOSC() {
  if (!['ableton', 'logic'].includes(CONFIG.daw)) return;

  oscPort = new osc.UDPPort({
    localAddress:  '0.0.0.0',
    localPort:     CONFIG.oscLocalPort,
    remoteAddress: CONFIG.oscHost,
    remotePort:    CONFIG.oscRemotePort,
    metadata: true
  });

  oscPort.on('ready', () => {
    console.log(`[OSC] Listening on ${CONFIG.oscLocalPort}`);
    state.dawConnected = true;

    // Subscribe to Ableton state changes
    if (CONFIG.daw === 'ableton') {
      oscPort.send({ address: '/live/song/start_listen/beat',    args: [] });
      oscPort.send({ address: '/live/song/start_listen/is_playing', args: [] });
      oscPort.send({ address: '/live/song/start_listen/tempo',   args: [] });
      fetchAbletonTracks();
    }
  });

  oscPort.on('message', handleOSCMessage);
  oscPort.on('error', (err) => console.error('[OSC Error]', err.message));
  oscPort.open();
}

// ── OSC Message Handler ───────────────────────────────────────
function handleOSCMessage(msg) {
  const addr = msg.address;
  const val  = msg.args?.[0]?.value;

  // Ableton-specific parsing
  if (addr === '/live/song/get/is_playing') {
    state.isPlaying = !!val;
    broadcastDAWState({ type: 'transport', isPlaying: state.isPlaying });
  }
  else if (addr === '/live/song/get/tempo') {
    state.bpm = val;
    broadcastDAWState({ type: 'bpm', value: val });
  }
  else if (addr === '/live/beat') {
    broadcastDAWState({ type: 'beat', beat: val });
  }
  else if (addr.startsWith('/live/track')) {
    // Track state changes
    const match = addr.match(/\/live\/track\/(\d+)\/get\/(.*)/);
    if (match) {
      broadcastDAWState({ type: 'track', index: parseInt(match[1]), param: match[2], value: val });
    }
  }
}

// ── Fetch all Ableton tracks ──────────────────────────────────
function fetchAbletonTracks() {
  if (!oscPort) return;
  oscPort.send({ address: '/live/song/get/num_tracks', args: [] });
  // Response comes back async → handled in handleOSCMessage
}

// ── Send OSC command to DAW ───────────────────────────────────
function sendOSC(address, args = []) {
  if (!oscPort) return;
  oscPort.send({ address, args: args.map(v => ({
    type: typeof v === 'number' ? (Number.isInteger(v) ? 'i' : 'f') : 's',
    value: v
  }))});
}

// ── DAW Command Dispatch ──────────────────────────────────────
// Called when a remote peer sends a control message
function handleRemoteCommand(cmd, peerId) {
  const sess = state.peers.get(peerId);
  if (!sess) return;
  const perms = sess.perms;

  console.log(`[CMD] ${cmd.type} from ${peerId}`);

  switch (CONFIG.daw) {
    case 'ableton': handleAbletonCommand(cmd, perms); break;
    case 'logic':   handleLogicCommand(cmd, perms);   break;
    case 'cubase':  handleMIDICommand(cmd, perms);    break;
    case 'fl':      handleMIDICommand(cmd, perms);    break;
    case 'protools':handleHUICommand(cmd, perms);     break;
  }
}

// ── Ableton Commands ──────────────────────────────────────────
function handleAbletonCommand(cmd, perms) {
  switch (cmd.type) {
    case 'play':
      if (!perms.transport) return;
      sendOSC(cmd.value ? '/live/song/start_playing' : '/live/song/stop_playing');
      break;
    case 'stop':
      if (!perms.transport) return;
      sendOSC('/live/song/stop_playing');
      break;
    case 'bpm':
      if (!perms.transport) return;
      sendOSC('/live/song/set/tempo', [parseFloat(cmd.value)]);
      break;
    case 'track_volume':
      if (!perms.faders) return;
      sendOSC(`/live/track/${cmd.index}/set/volume`, [parseFloat(cmd.value) / 127]);
      break;
    case 'track_mute':
      if (!perms.mute) return;
      sendOSC(`/live/track/${cmd.index}/set/mute`, [cmd.value ? 1 : 0]);
      break;
    case 'track_solo':
      if (!perms.mute) return;
      sendOSC(`/live/track/${cmd.index}/set/solo`, [cmd.value ? 1 : 0]);
      break;
    case 'track_arm':
      if (!perms.faders) return;
      sendOSC(`/live/track/${cmd.index}/set/arm`, [cmd.value ? 1 : 0]);
      break;
    case 'clip_launch':
      if (!perms.transport) return;
      sendOSC(`/live/clip_slot/${cmd.track}/${cmd.slot}/fire`);
      break;
    case 'midi_note':
      if (!perms.midi) return;
      // Forward MIDI note to Ableton via virtual port
      sendMIDINote(cmd.channel, cmd.note, cmd.velocity, cmd.on);
      break;
  }
}

// ── Logic Commands ────────────────────────────────────────────
function handleLogicCommand(cmd, perms) {
  // Logic uses predefined OSC paths from Logic Remote protocol
  const map = {
    play:        '/mixer/play',
    stop:        '/mixer/stop',
    bpm:         (c) => sendOSC('/mixer/tempo', [c.value]),
    track_volume:(c) => sendOSC(`/mixer/volume/volume${c.index + 1}`, [c.value / 127]),
    track_mute:  (c) => sendOSC(`/mixer/mute/mute${c.index + 1}`, [c.value ? 1 : 0]),
  };
  if (typeof map[cmd.type] === 'function') map[cmd.type](cmd);
  else if (map[cmd.type]) sendOSC(map[cmd.type]);
}

// ── MIDI Commands (Cubase/FL via virtual MIDI port) ───────────
let midiOutput = null;

function initMIDI() {
  if (['cubase', 'fl', 'protools'].includes(CONFIG.daw)) {
    try {
      midiOutput = new midi.Output(CONFIG.midiPortName, true); // true = virtual
      console.log(`[MIDI] Virtual port created: ${CONFIG.midiPortName}`);
    } catch (e) {
      console.warn('[MIDI] Could not create virtual port:', e.message);
    }
  }
}

function handleMIDICommand(cmd, perms) {
  if (!midiOutput) return;
  switch (cmd.type) {
    case 'play':
      if (!perms.transport) return;
      // MMC Start/Stop
      midiOutput.send('sysex', [0xF0, 0x7F, 0x7F, 0x06, cmd.value ? 0x02 : 0x01, 0xF7]);
      break;
    case 'bpm':
      if (!perms.transport) return;
      // MIDI tempo via CC (DAW-specific mapping)
      midiOutput.send('cc', { controller: 14, value: Math.floor(cmd.value - 60), channel: 0 });
      break;
    case 'track_volume':
      if (!perms.faders) return;
      midiOutput.send('cc', { controller: 7, value: cmd.value, channel: cmd.index });
      break;
    case 'track_mute':
      if (!perms.mute) return;
      midiOutput.send('cc', { controller: 68, value: cmd.value ? 127 : 0, channel: cmd.index });
      break;
    case 'midi_note':
      if (!perms.midi) return;
      sendMIDINote(cmd.channel, cmd.note, cmd.velocity, cmd.on);
      break;
  }
}

// ── HUI Commands (Pro Tools) ──────────────────────────────────
function handleHUICommand(cmd, perms) {
  if (!midiOutput) return;
  // HUI uses SysEx + CC messages — simplified implementation
  switch (cmd.type) {
    case 'play':
      if (!perms.transport) return;
      // HUI transport: CC 0x0C zone select, then value
      midiOutput.send('cc', { controller: 0x0C, value: 0, channel: 0 });
      midiOutput.send('cc', { controller: 0x2C, value: cmd.value ? 0x7F : 0, channel: 0 });
      break;
    case 'track_volume':
      if (!perms.faders) return;
      // HUI fader: pitch bend per channel
      const pb = Math.floor((cmd.value / 127) * 16383);
      midiOutput.send('pitch', { value: pb, channel: cmd.index % 8 });
      break;
  }
}

// ── MIDI Note passthrough ─────────────────────────────────────
function sendMIDINote(channel, note, velocity, noteOn) {
  if (!midiOutput) return;
  midiOutput.send(noteOn ? 'noteon' : 'noteoff', {
    note, velocity, channel: channel % 16
  });
}

// ── Audio Capture ─────────────────────────────────────────────
// Captures from virtual audio device (BlackHole/VB-Cable)
// and feeds into a raw PCM stream for WebRTC
function startAudioCapture() {
  const platform = process.platform;

  // sox command differs by platform
  const soxArgs = platform === 'darwin'
    ? ['-d', '-t', 'coreaudio', CONFIG.audioDevice,
       '-e', 'signed-integer', '-b', '16', '-r', '48000', '-c', '2', '-t', 'raw', '-']
    : ['-t', 'waveaudio', CONFIG.audioDevice,
       '-e', 'signed-integer', '-b', '16', '-r', '48000', '-c', '2', '-t', 'raw', '-'];

  console.log('[Audio] Starting capture from:', CONFIG.audioDevice);

  const sox = spawn('sox', soxArgs);
  state.audioStream = sox.stdout;

  sox.stderr.on('data', d => {
    // SOX writes levels to stderr — parse peak level
    const match = d.toString().match(/In:.*?(\d+\.\d+)%/);
    if (match) broadcastAudioLevel(parseFloat(match[1]));
  });

  sox.on('error', (err) => {
    console.warn('[Audio] SOX not available — audio capture disabled:', err.message);
    console.warn('[Audio] Install SOX: brew install sox  OR  apt-get install sox');
  });

  return sox.stdout;
}

// ── Broadcast to all peers ────────────────────────────────────
function broadcastDAWState(payload) {
  const msg = JSON.stringify(payload);
  for (const [, peer] of state.peers) {
    if (peer.dataChannel?.readyState === 'open') {
      peer.dataChannel.send(msg);
    }
  }
}

function broadcastAudioLevel(level) {
  broadcastDAWState({ type: 'audio_level', level });
}

// ── Init ──────────────────────────────────────────────────────
async function init() {
  console.log('\n🎛  StudioSync DAW Bridge Agent');
  console.log(`    DAW:    ${CONFIG.daw}`);
  console.log(`    Audio:  ${CONFIG.audioDevice}`);
  console.log(`    Signal: ${CONFIG.signalingUrl}\n`);

  initOSC();
  initMIDI();
  startAudioCapture();

  console.log('[Agent] Ready. Waiting for session...');
  console.log('[Agent] Set SIGNALING env var to point to your server\n');
}

// ── Exports (for integration with main app) ───────────────────
module.exports = {
  init,
  handleRemoteCommand,
  broadcastDAWState,
  state,
  CONFIG,
  sendOSC,
};

// Run directly
if (require.main === module) init();
