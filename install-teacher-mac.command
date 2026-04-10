#!/bin/bash
# ══════════════════════════════════════════════════════════════
# StudioSync — התקנה + הגדרה למארח (Mac)
# דאבל-קליק על הקובץ הזה ← הכל מותקן בלחיצה אחת
# ══════════════════════════════════════════════════════════════

set -e

CYAN='\033[0;36m'
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
DIM='\033[2m'
NC='\033[0m'
BOLD='\033[1m'

INSTALL_DIR="$HOME/StudioSync"
APP_URL="https://studiosync-nxu0.onrender.com"
REPO_RAW="https://raw.githubusercontent.com/Almog369Cohen/studiosync/master"

ok()   { echo -e "  ${GREEN}✓${NC} $1"; }
info() { echo -e "  ${YELLOW}→${NC} $1"; }
fail() { echo -e "  ${RED}✗${NC} $1"; }
step() { echo ""; echo -e "${BOLD}[$1] $2${NC}"; }

clear
echo ""
echo -e "${CYAN}${BOLD}══════════════════════════════════════════════${NC}"
echo -e "${CYAN}${BOLD}   🎛  StudioSync — התקנה למארח (Mac)${NC}"
echo -e "${CYAN}${BOLD}══════════════════════════════════════════════${NC}"
echo ""
echo -e "${DIM}   גרסה 2.0 | $(date +%Y-%m-%d)${NC}"
echo ""

mkdir -p "$INSTALL_DIR"

# ── Step 1: Homebrew ──
step "1/5" "בודק Homebrew..."
if command -v brew &>/dev/null; then
    ok "Homebrew מותקן"
else
    info "מתקין Homebrew (ייתכן שתתבקש להכניס סיסמת מחשב)..."
    /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
    if [ -f /opt/homebrew/bin/brew ]; then
        eval "$(/opt/homebrew/bin/brew shellenv)"
        echo 'eval "$(/opt/homebrew/bin/brew shellenv)"' >> "$HOME/.zprofile" 2>/dev/null
    fi
    ok "Homebrew הותקן"
fi

# ── Step 2: Node.js ──
step "2/5" "בודק Node.js..."
if command -v node &>/dev/null; then
    NODE_VER=$(node -v)
    NODE_MAJOR=$(echo "$NODE_VER" | sed 's/v\([0-9]*\).*/\1/')
    if [ "$NODE_MAJOR" -ge 18 ]; then
        ok "Node.js $NODE_VER מותקן"
    else
        info "מעדכן Node.js ($NODE_VER → 20)..."
        brew install node@20
        ok "Node.js עודכן"
    fi
else
    info "מתקין Node.js..."
    brew install node
    ok "Node.js הותקן ($(node -v))"
fi

# ── Step 3: BlackHole (virtual audio) ──
step "3/5" "בודק BlackHole (שידור סאונד)..."
if brew list blackhole-2ch &>/dev/null 2>&1; then
    ok "BlackHole 2ch מותקן"
else
    info "מתקין BlackHole 2ch (כרטיס קול וירטואלי)..."
    brew install blackhole-2ch
    ok "BlackHole הותקן — צריך להגדיר Multi-Output Device (ראה בסוף)"
fi

# ── Step 4: Agent + robotjs ──
step "4/5" "מתקין StudioSync Agent..."

info "מוריד agent.js..."
curl -fsSL "${REPO_RAW}/agent.js" -o "$INSTALL_DIR/agent.js"
ok "agent.js הורד"

# package.json for agent dependencies
cat > "$INSTALL_DIR/package.json" << 'PKGJSON'
{
  "name": "studiosync-agent",
  "version": "2.0.0",
  "private": true,
  "dependencies": {
    "robotjs": "^0.7.0"
  },
  "optionalDependencies": {
    "easymidi": "^3.0.0"
  }
}
PKGJSON

info "מתקין robotjs + easymidi (עד 2 דקות)..."
cd "$INSTALL_DIR"
npm install --no-audit --no-fund 2>&1 | tail -3

# Verify robotjs actually works
if node -e "require('robotjs').getScreenSize()" 2>/dev/null; then
    ok "robotjs פועל — שליטה מרחוק מוכנה"
    ROBOT_OK=true
else
    fail "robotjs לא הצליח — שליטה מרחוק לא תעבוד"
    echo -e "  ${DIM}   ייתכן שצריך: xcode-select --install${NC}"
    ROBOT_OK=false
fi

# Verify MIDI
if node -e "require('easymidi')" 2>/dev/null; then
    ok "easymidi פועל — MIDI מוכן"
else
    echo -e "  ${DIM}   easymidi לא מותקן — MIDI לא זמין (לא חובה)${NC}"
fi

# ── Step 5: Create launcher scripts ──
step "5/5" "יוצר סקריפטי הפעלה..."

# ── Main launcher: start.command ──
cat > "$INSTALL_DIR/start.command" << 'LAUNCHER'
#!/bin/bash
cd "$(dirname "$0")"

CYAN='\033[0;36m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
DIM='\033[2m'
NC='\033[0m'
BOLD='\033[1m'

clear
echo ""
echo -e "${CYAN}${BOLD}══════════════════════════════════════${NC}"
echo -e "${CYAN}${BOLD}   🎛  StudioSync — הפעלת סשן${NC}"
echo -e "${CYAN}${BOLD}══════════════════════════════════════${NC}"
echo ""

# ── Which DAW? ──
echo -e "${BOLD}   בחר תוכנת הפקה:${NC}"
echo ""
echo "   1) Ableton Live"
echo "   2) Logic Pro"
echo "   3) Cubase"
echo "   4) FL Studio"
echo "   5) Pro Tools"
echo "   6) ללא — רק Agent"
echo ""
read -p "   בחר (1-6): " DAW_CHOICE

case "$DAW_CHOICE" in
    1) DAW_APP="Ableton Live"
       DAW_BUNDLE=$(ls -d /Applications/Ableton\ Live\ *.app 2>/dev/null | head -1)
       ;;
    2) DAW_APP="Logic Pro"
       DAW_BUNDLE="/Applications/Logic Pro X.app"
       [ ! -d "$DAW_BUNDLE" ] && DAW_BUNDLE="/Applications/Logic Pro.app"
       ;;
    3) DAW_APP="Cubase"
       DAW_BUNDLE=$(ls -d /Applications/Cubase*.app 2>/dev/null | head -1)
       ;;
    4) DAW_APP="FL Studio"
       DAW_BUNDLE=$(ls -d /Applications/FL\ Studio*.app 2>/dev/null | head -1)
       ;;
    5) DAW_APP="Pro Tools"
       DAW_BUNDLE="/Applications/Pro Tools.app"
       ;;
    *) DAW_APP=""
       DAW_BUNDLE=""
       ;;
esac

# Open DAW if selected
if [ -n "$DAW_BUNDLE" ] && [ -d "$DAW_BUNDLE" ]; then
    echo ""
    echo -e "   ${GREEN}→ פותח $DAW_APP...${NC}"
    open "$DAW_BUNDLE"
elif [ -n "$DAW_APP" ]; then
    echo ""
    echo -e "   ${YELLOW}⚠ $DAW_APP לא נמצא ב-Applications${NC}"
fi

# Open StudioSync in browser
echo ""
echo -e "   ${GREEN}→ פותח StudioSync בדפדפן...${NC}"
open "https://studiosync-nxu0.onrender.com"

sleep 2

# Wait for session code
echo ""
echo -e "${BOLD}   ═══════════════════════════════════${NC}"
echo ""
echo -e "${BOLD}   הכנס קוד סשן (מופיע למעלה בדפדפן):${NC}"
echo ""
read -p "   קוד: " CODE

if [ -z "$CODE" ]; then
    echo ""
    echo -e "   ${YELLOW}Agent לא הופעל — לא הוכנס קוד${NC}"
    echo -e "   ${DIM}StudioSync עדיין פועל בדפדפן${NC}"
    echo ""
    read -p "   לחץ Enter לסגירה..."
    exit 0
fi

# Validate code format
CODE=$(echo "$CODE" | tr '[:lower:]' '[:upper:]')

echo ""
echo -e "   🚀 מפעיל Agent (שליטה מרחוק)..."
echo -e "   ${DIM}   סשן: $CODE${NC}"
echo -e "   ${DIM}   Ctrl+C לניתוק${NC}"
echo ""

node agent.js "https://studiosync-nxu0.onrender.com" "$CODE"

echo ""
read -p "   לחץ Enter לסגירה..."
LAUNCHER
chmod +x "$INSTALL_DIR/start.command"

# ── Quick start (no DAW picker, just agent) ──
cat > "$INSTALL_DIR/agent-only.command" << 'AGENTONLY'
#!/bin/bash
cd "$(dirname "$0")"
clear
echo ""
echo "🎛  StudioSync Agent — שליטה מרחוק"
echo ""
read -p "   קוד סשן: " CODE
if [ -z "$CODE" ]; then echo "❌ לא הוכנס קוד"; read -p "Enter..."; exit 1; fi
CODE=$(echo "$CODE" | tr '[:lower:]' '[:upper:]')
echo ""
echo "   🚀 מתחבר ל-$CODE..."
echo "   Ctrl+C לניתוק"
echo ""
node agent.js "https://studiosync-nxu0.onrender.com" "$CODE"
echo ""
read -p "   לחץ Enter לסגירה..."
AGENTONLY
chmod +x "$INSTALL_DIR/agent-only.command"

ok "start.command — הפעלה מלאה (DAW + Agent)"
ok "agent-only.command — Agent בלבד"

# ── macOS Accessibility permission (required for robotjs) ──
echo ""
echo -e "${YELLOW}${BOLD}   ⚠ הרשאת נגישות נדרשת!${NC}"
echo ""
echo "   כדי ש-Agent ישלוט על העכבר והמקלדת,"
echo "   Terminal צריך הרשאת נגישות:"
echo ""
echo "   System Settings → Privacy & Security → Accessibility"
echo "   → הוסף את Terminal (או iTerm)"
echo ""

# Try to trigger the permission dialog
if [ "$ROBOT_OK" = true ]; then
    node -e "try{require('robotjs').moveMouse(0,0)}catch(e){}" 2>/dev/null &
fi

# ── Summary ──
echo -e "${CYAN}${BOLD}══════════════════════════════════════════════${NC}"
echo ""
echo -e "${GREEN}${BOLD}   ✅ ההתקנה הושלמה!${NC}"
echo ""
echo -e "${BOLD}   📁 הקבצים ב: $INSTALL_DIR${NC}"
echo ""
echo -e "${BOLD}   ═══ 3 צעדים אחרונים (פעם אחת בלבד) ═══${NC}"
echo ""
echo -e "${BOLD}   1. הגדרת Multi-Output Device:${NC}"
echo "      פתח Spotlight (⌘+Space) → חפש Audio MIDI Setup"
echo "      לחץ + למטה משמאל → Create Multi-Output Device"
echo "      סמן ✓ ליד: BlackHole 2ch + הרמקולים שלך"
echo ""
echo -e "${BOLD}   2. ב-DAW — Audio Output → Multi-Output Device${NC}"
echo "      (Ableton: Preferences → Audio → Output)"
echo ""
echo -e "${BOLD}   3. הרשאת נגישות ל-Terminal${NC}"
echo "      System Settings → Privacy → Accessibility → Terminal ✓"
echo ""
echo -e "${CYAN}${BOLD}   ═══ איך להתחיל סשן ═══${NC}"
echo ""
echo -e "   דאבל-קליק על ${GREEN}start.command${NC} בתיקיית StudioSync"
echo "   הקובץ פותח את ה-DAW + הדפדפן + Agent אוטומטית"
echo ""
echo -e "${CYAN}══════════════════════════════════════════════${NC}"
echo ""

# Open the install folder in Finder
open "$INSTALL_DIR"

read -p "   לחץ Enter לסגירה..."
