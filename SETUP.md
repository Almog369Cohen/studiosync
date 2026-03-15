# StudioSync Desktop — Setup & Build Guide

## סביבת פיתוח

### דרישות
```
Node.js  >= 18
Rust     >= 1.77  (rustup.rs)
Tauri CLI >= 1.6
```

### Mac בלבד
```bash
xcode-select --install
brew install create-dmg   # לבניית DMG
```

### Windows בלבד
```
Visual Studio Build Tools 2022
  - MSVC compiler
  - Windows 10/11 SDK
WebView2 Runtime (מובנה ב-Windows 11)
```

---

## התקנה

```bash
cd studiosync/desktop
npm install
cargo install tauri-cli --version "^1.6"
```

---

## פיתוח (Dev mode)

```bash
npm run tauri:dev
```

פותח את האפליקציה עם hot-reload.
הדפדפן מוגש מ-localhost:5173.
שינויים ב-JS נטענים אוטומטית.
שינויים ב-Rust → restart.

---

## בנייה לייצור

### Mac (Universal Binary — Intel + Apple Silicon)
```bash
npm run tauri:mac
```

פלט:
```
target/universal-apple-darwin/release/bundle/
  dmg/StudioSync_1.0.0_universal.dmg   (~8MB)
  macos/StudioSync.app
```

### Windows
```bash
npm run tauri:win
```

פלט:
```
target/x86_64-pc-windows-msvc/release/bundle/
  nsis/StudioSync_1.0.0_x64-setup.exe  (~4MB)
  msi/StudioSync_1.0.0_x64_en-US.msi
```

---

## חתימה ו-Notarization (Mac)

### דרישות
- Apple Developer account ($99/year)
- Developer ID Application certificate

```bash
# ייצוא certificate מ-Keychain → .p12 file
export APPLE_CERTIFICATE="base64_encoded_cert"
export APPLE_CERTIFICATE_PASSWORD="cert_password"
export APPLE_ID="your@apple.id"
export APPLE_PASSWORD="app-specific-password"
export APPLE_TEAM_ID="XXXXXXXXXX"

npm run tauri:mac
# Tauri auto-signs + notarizes
```

### Windows Code Signing
```bash
export TAURI_PRIVATE_KEY="your_private_key"
export TAURI_KEY_PASSWORD="key_password"

npm run tauri:win
```

---

## TURN Server (Self-hosted Coturn)

### התקנה על VPS ($6/חודש — DigitalOcean/Hetzner)
```bash
apt update && apt install -y coturn certbot

# SSL certificate
certbot certonly --standalone -d turn.studiosync.io

# Config
cat > /etc/turnserver.conf << EOF
listening-port=3478
tls-listening-port=5349
fingerprint
use-auth-secret
static-auth-secret=REPLACE_WITH_STRONG_SECRET_32CHARS
realm=turn.studiosync.io
cert=/etc/letsencrypt/live/turn.studiosync.io/fullchain.pem
pkey=/etc/letsencrypt/live/turn.studiosync.io/privkey.pem
log-file=/var/log/coturn/turn.log
no-stdout-log
stale-nonce=600
min-port=49152
max-port=65535
EOF

systemctl enable coturn && systemctl start coturn
```

### עדכון ב-index.html
```js
ICE_SERVERS: [
  { urls: 'stun:stun.studiosync.io:3478' },
  { urls: 'turn:turn.studiosync.io:3478',
    username: 'ss_user', credential: 'YOUR_SECRET_HERE' },
]
```

---

## Signaling Server

```bash
cd studiosync/server
npm install
# Deploy to VPS
pm2 start signaling-server.js --name studiosync-signal
# Or with Docker:
docker build -t studiosync-signal .
docker run -d -p 3001:3001 studiosync-signal
```

---

## Virtual Audio Driver (Mac)

הקובץ `StudioSyncVirtual.dylib` נבנה בנפרד.

```bash
# בניית ה-AudioServerPlugin
cd audio-driver/
swift build -c release
cp .build/release/StudioSyncVirtual.dylib \
   ../desktop/src-tauri/resources/

# הדרייבר מותקן אוטומטית ע"י virtual_device.rs
# ללא סיסמת admin, ללא kext
```

---

## מבנה קבצים

```
studiosync/
├── index.html              ← Web UI (Free + Pro)
├── server/
│   └── signaling-server.js ← WebRTC signaling (our VPS)
├── agent/
│   └── daw-bridge.js       ← Legacy browser DAW bridge
└── desktop/
    ├── package.json
    ├── vite.config.js
    ├── src/
    │   └── tauri-bridge.js ← JS ↔ Rust IPC
    └── src-tauri/
        ├── Cargo.toml
        ├── build.rs
        ├── tauri.conf.json
        ├── entitlements.plist
        └── src/
            ├── main.rs         ← Entry point + Tauri commands
            ├── audio.rs        ← CoreAudio / WASAPI capture
            ├── virtual_device.rs ← Virtual audio device install
            ├── screen.rs       ← Screen capture + input injection
            ├── daw_bridge.rs   ← OSC/MIDI/HUI DAW control
            └── ipc.rs          ← Shared types JS ↔ Rust
```

---

## מה הלקוח מוריד

| Tier | מה מוריד | גודל | מה מקבל |
|------|----------|------|----------|
| Free | כלום — רק URL | 0MB | שמע מיק, screen share, 2 peers |
| Pro (Host) | StudioSync.dmg / .exe | ~8MB | שמע DAW, שליטה מלאה, הקלטה, 4 peers |
| Guest (כל tier) | כלום — רק URL | 0MB | שמע מלא, שליטה (אם הורשה), chat |

**רק ה-Host Pro מוריד. כל שאר המשתמשים — דפדפן בלבד.**
