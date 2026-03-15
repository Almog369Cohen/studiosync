#!/bin/bash
# ══════════════════════════════════════════════════════════
# StudioSync — Mac Installer Builder
# Creates a .pkg installer that users double-click to install
# ══════════════════════════════════════════════════════════

set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
BUILD_DIR="$SCRIPT_DIR/build"
PKG_ROOT="$BUILD_DIR/pkgroot"

echo "🎛  StudioSync Installer Builder"
echo "================================"

# Clean build dir
rm -rf "$BUILD_DIR"
mkdir -p "$PKG_ROOT/usr/local/studiosync"
mkdir -p "$BUILD_DIR/scripts"

# Copy app files
echo "📦 Copying files..."
cp "$ROOT_DIR/agent.js" "$PKG_ROOT/usr/local/studiosync/"
cp "$ROOT_DIR/package.json" "$PKG_ROOT/usr/local/studiosync/"

# ── postinstall script (runs after pkg install) ──
cat > "$BUILD_DIR/scripts/postinstall" << 'POSTINSTALL'
#!/bin/bash
set -e

# ── Install Homebrew if needed ──
if ! command -v brew &>/dev/null; then
  echo "Installing Homebrew..."
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
fi

# ── Install BlackHole if needed ──
if ! brew list --cask blackhole-2ch &>/dev/null; then
  echo "Installing BlackHole (virtual audio driver)..."
  brew install --cask blackhole-2ch
fi

# ── Install Node.js if needed ──
if ! command -v node &>/dev/null; then
  echo "Installing Node.js..."
  brew install node
fi

# ── Install robotjs ──
echo "Installing StudioSync agent dependencies..."
cd /usr/local/studiosync
npm install robotjs 2>/dev/null || npm install --build-from-source robotjs

# ── Create StudioSync.app launcher (appears in Applications) ──
APP_DIR="/Applications/StudioSync Agent.app"
mkdir -p "$APP_DIR/Contents/MacOS"
mkdir -p "$APP_DIR/Contents/Resources"

cat > "$APP_DIR/Contents/MacOS/StudioSync Agent" << 'APPSCRIPT'
#!/bin/bash
# StudioSync Agent Launcher
osascript -e 'display dialog "StudioSync Agent\n\nהכנס את קוד הסשן:" default answer "" with title "StudioSync" buttons {"ביטול", "התחל"} default button "התחל"' 2>/dev/null
CODE=$(osascript -e 'set answer to button returned of (display dialog "הכנס קוד סשן:" default answer "" with title "StudioSync Agent" buttons {"ביטול", "התחל"} default button "התחל")
set code to text returned of result
return code' 2>/dev/null)

if [ -n "$CODE" ]; then
  /usr/local/bin/node /usr/local/studiosync/agent.js https://studiosync-nxu0.onrender.com "$CODE"
fi
APPSCRIPT
chmod +x "$APP_DIR/Contents/MacOS/StudioSync Agent"

cat > "$APP_DIR/Contents/Info.plist" << 'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>StudioSync Agent</string>
  <key>CFBundleExecutable</key><string>StudioSync Agent</string>
  <key>CFBundleIdentifier</key><string>com.studiosync.agent</string>
  <key>CFBundleVersion</key><string>1.0</string>
  <key>LSUIElement</key><false/>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
PLIST

echo ""
echo "✅ StudioSync Agent הותקן בהצלחה!"
echo ""
echo "📌 הגדרת סאונד (פעם אחת בלבד):"
echo "   1. פתח Audio MIDI Setup (Spotlight → Audio MIDI Setup)"
echo "   2. לחץ + → Create Multi-Output Device"
echo "   3. סמן: Built-in Output + BlackHole 2ch"
echo "   4. ב-Ableton → Preferences → Audio → Output: BlackHole 2ch"
echo ""
echo "🎛  כדי להפעיל: פתח 'StudioSync Agent' מ-Applications"
POSTINSTALL
chmod +x "$BUILD_DIR/scripts/postinstall"

# ── Distribution XML ──
cat > "$BUILD_DIR/distribution.xml" << 'DISTXML'
<?xml version="1.0" encoding="utf-8"?>
<installer-gui-script minSpecVersion="1">
  <title>StudioSync Agent</title>
  <welcome file="welcome.html" mime-type="text/html"/>
  <license file="license.txt" mime-type="text/plain"/>
  <conclusion file="conclusion.html" mime-type="text/html"/>
  <options customize="never" require-scripts="false" rootVolumeOnly="true"/>
  <domains enable_localSystem="true"/>
  <pkg-ref id="com.studiosync.agent"/>
  <choices-outline>
    <line choice="default">
      <line choice="com.studiosync.agent"/>
    </line>
  </choices-outline>
  <choice id="default"/>
  <choice id="com.studiosync.agent" visible="false">
    <pkg-ref id="com.studiosync.agent"/>
  </choice>
  <pkg-ref id="com.studiosync.agent" version="1.0" onConclusion="none">StudioSync.pkg</pkg-ref>
</installer-gui-script>
DISTXML

# ── Welcome page ──
mkdir -p "$BUILD_DIR/resources"
cat > "$BUILD_DIR/resources/welcome.html" << 'HTML'
<html><body style="font-family: -apple-system; padding: 20px; direction: rtl;">
<h2>ברוכים הבאים ל-StudioSync Agent</h2>
<p>תוכנה זו תאפשר לתלמידים שלך לשלוט בעכבר ובמקלדת שלך מרחוק בזמן סשן מוזיקה.</p>
<p><b>מה יותקן:</b></p>
<ul>
  <li>BlackHole — כרטיס קול וירטואלי לשידור שמע</li>
  <li>StudioSync Agent — תוכנת השליטה מרחוק</li>
</ul>
<p>ההתקנה אוטומטית לחלוטין.</p>
</body></html>
HTML

cat > "$BUILD_DIR/resources/conclusion.html" << 'HTML'
<html><body style="font-family: -apple-system; padding: 20px; direction: rtl;">
<h2>✅ ההתקנה הושלמה!</h2>
<p><b>צעד אחרון — הגדרת שמע (פעם אחת):</b></p>
<ol>
  <li>פתח <b>Audio MIDI Setup</b> (Spotlight → חפש "Audio MIDI Setup")</li>
  <li>לחץ <b>+</b> בתחתית → <b>Create Multi-Output Device</b></li>
  <li>סמן: <b>Built-in Output</b> + <b>BlackHole 2ch</b></li>
  <li>ב-Ableton: Preferences → Audio → Output Device: <b>BlackHole 2ch</b></li>
</ol>
<p>אחרי זה — פתח <b>StudioSync Agent</b> מה-Applications והתחל סשן!</p>
</body></html>
HTML

cat > "$BUILD_DIR/resources/license.txt" << 'TXT'
StudioSync License
==================
This software is provided for use with StudioSync sessions only.
TXT

echo "🔨 Building component package..."
pkgbuild \
  --root "$PKG_ROOT" \
  --scripts "$BUILD_DIR/scripts" \
  --identifier com.studiosync.agent \
  --version 1.0 \
  --install-location / \
  "$BUILD_DIR/StudioSync.pkg"

echo "🔨 Building distribution package..."
productbuild \
  --distribution "$BUILD_DIR/distribution.xml" \
  --resources "$BUILD_DIR/resources" \
  --package-path "$BUILD_DIR" \
  "$SCRIPT_DIR/StudioSync-Installer.pkg"

echo ""
echo "✅ נוצר: installer/StudioSync-Installer.pkg"
echo "   לחץ עליו דאבל-קליק כדי להתקין!"
