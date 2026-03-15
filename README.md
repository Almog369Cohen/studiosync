# 🎛 StudioSync

> Real-time DAW collaboration — שני מחשבים, פרויקט אחד, שמע מלא

---

## ארכיטקטורה

```
[Host Machine]                         [Remote Machine]
  DAW (Ableton/Logic/...)                 Browser
  Virtual Audio Device                    WebRTC Audio ←─┐
  DAW Bridge Agent  ──OSC/MIDI──►  ──────DataChannel ────┤
  StudioSync App ──────────────────── P2P WebRTC ────────┘
        │                                    │
        └──── Signaling Server (WS) ─────────┘
              (SDP + ICE only, no audio)
```

---

## התקנה מהירה

### 1. שרת Signaling

```bash
npm install
npm run server
# Server runs on port 3001
```

### 2. Virtual Audio (Mac — BlackHole)

```bash
brew install blackhole-2ch
# Open: Audio MIDI Setup → Create Multi-Output Device
# Add: Your audio interface + BlackHole 2ch
# Set as default output in your DAW
```

### 2. Virtual Audio (Windows — VB-Cable)

```
Download: https://vb-audio.com/Cable/
Install VB-Cable Driver
In your DAW: Output → CABLE Input (VB-Audio)
```

### 3. DAW Setup per software

#### Ableton Live
```
1. Download AbletonOSC:
   https://github.com/ideoforms/AbletonOSC
2. Copy to: ~/Music/Ableton/User Library/Remote Scripts/AbletonOSC/
3. Ableton → Preferences → Link/MIDI → Control Surface: AbletonOSC
4. StudioSync auto-connects to port 11000
```

#### Logic Pro
```
1. Logic → Preferences → Control Surfaces → Setup
2. Add → "New" → Controller Type: Generic
3. Protocol: OSC, Port: 8000
4. StudioSync connects automatically
```

#### Cubase / Nuendo
```
Option A (VST Connect — built-in):
  Studio → VST Connect SE → Create VST Connect
  Full P2P recording, 16 channels — best option

Option B (MIDI Remote):
  Studio → Studio Setup → MIDI Remote
  Add StudioSync as MIDI Remote device
  Script: agent/cubase-remote-script.js
```

#### FL Studio
```
1. Options → MIDI Settings
2. Enable: Microsoft GS Wavetable Synth (or loopMIDI port)
3. Add Virtual MIDI port "StudioSync" via loopMIDI
   https://www.tobias-erichsen.de/software/loopmidi.html
4. StudioSync bridges MIDI over IP automatically
```

#### Pro Tools
```
1. Setup → Peripherals → MIDI Controllers
2. Type: HUI
3. Receive From: StudioSync Virtual MIDI Port
4. Send To: StudioSync Virtual MIDI Port
```

### 4. הפעל DAW Bridge Agent (Host מחשב)

```bash
# Ableton on Mac
DAW=ableton AUDIO_DEVICE="BlackHole 2ch" node agent/daw-bridge.js

# Logic on Mac
DAW=logic AUDIO_DEVICE="BlackHole 2ch" node agent/daw-bridge.js

# Cubase on Windows
DAW=cubase AUDIO_DEVICE="CABLE Output (VB-Audio)" node agent/daw-bridge.js

# FL Studio on Windows
DAW=fl AUDIO_DEVICE="CABLE Output (VB-Audio)" node agent/daw-bridge.js
```

### 5. פתח אפליקציה

```bash
# Host: open index.html in browser → "Host Session"
# Remote: open index.html → "Join Session" → enter code
```

---

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `DAW` | `ableton` | ableton / logic / cubase / fl / protools |
| `OSC_LOCAL_PORT` | `11000` | Port to receive OSC from DAW |
| `OSC_REMOTE_PORT` | `11001` | Port DAW listens on |
| `AUDIO_DEVICE` | `BlackHole 2ch` | Virtual audio device name |
| `MIDI_PORT` | `StudioSync` | Virtual MIDI port name |
| `SIGNALING` | `ws://localhost:3001` | Signaling server URL |
| `PORT` | `3001` | Signaling server port |

---

## Deploy Signaling Server

### Fly.io (free tier)
```bash
fly launch --name studiosync-signal
fly deploy
# Set SIGNALING_URL in index.html to: wss://studiosync-signal.fly.dev
```

### Railway
```bash
railway init
railway up
```

### Render
```
New Web Service → Connect GitHub repo
Build: npm install
Start: npm run server
```

---

## Security

- ✅ All WebRTC audio is E2E encrypted (DTLS-SRTP)
- ✅ Signaling server only handles SDP/ICE — never touches audio
- ✅ Sessions expire after 8 hours
- ✅ Session codes are randomly generated, 6 chars
- 🔜 Add TURN server for NAT traversal (Metered.ca free tier)
- 🔜 Session password protection
- 🔜 Rate limiting on signaling server

---

## Latency Guide

| Network | Expected Latency | Notes |
|---|---|---|
| Same LAN | 5–20ms | Ideal for in-studio use |
| Same city (fiber) | 20–50ms | Very usable |
| Cross-country | 60–120ms | Usable for arrangement |
| International | 120–250ms | Challenging for real-time |

**Tip:** Use a TURN server close to both parties to minimize relay latency.

---

## Roadmap

- [x] WebRTC P2P connection
- [x] Audio streaming (host → remote)
- [x] DAW control via OSC (Ableton)
- [x] DAW control via MIDI HUI (Pro Tools, Cubase, FL)
- [x] Chat + Talkback
- [x] Web MIDI API
- [x] Permissions system
- [ ] TURN server integration
- [ ] Screen share of DAW UI
- [ ] Multi-peer (up to 4 collaborators)
- [ ] Session recording
- [ ] Ableton Link integration for tempo sync
- [ ] Plugin parameter sync (VST/AU)
- [ ] Mobile app (React Native + WebRTC)
