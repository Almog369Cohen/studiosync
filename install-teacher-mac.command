#!/bin/bash
# ══════════════════════════════════════════════════════════════
# StudioSync — התקנת מחשב המורה (Mac)
# קובץ זה מתקין את כל מה שצריך בלחיצה אחת:
#   1. Node.js (אם לא מותקן)
#   2. BlackHole (לשידור סאונד מ-Ableton)
#   3. Agent (לשליטה מרחוק בעכבר+מקלדת)
# ══════════════════════════════════════════════════════════════

set -e

CYAN='\033[0;36m'
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'
BOLD='\033[1m'

clear
echo ""
echo -e "${CYAN}${BOLD}══════════════════════════════════════════${NC}"
echo -e "${CYAN}${BOLD}   🎛  StudioSync — התקנת מחשב המורה${NC}"
echo -e "${CYAN}${BOLD}══════════════════════════════════════════${NC}"
echo ""

INSTALL_DIR="$HOME/StudioSync"
mkdir -p "$INSTALL_DIR"
cd "$INSTALL_DIR"

# ── Step 1: Homebrew ──
echo -e "${BOLD}[1/4] בודק Homebrew...${NC}"
if command -v brew &>/dev/null; then
    echo -e "  ${GREEN}✓ Homebrew מותקן${NC}"
else
    echo -e "  ${YELLOW}→ מתקין Homebrew (מנהל חבילות למק)...${NC}"
    echo -e "  ${YELLOW}  ייתכן שתתבקש להכניס סיסמת מחשב${NC}"
    /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
    # Add brew to PATH for Apple Silicon
    if [ -f /opt/homebrew/bin/brew ]; then
        eval "$(/opt/homebrew/bin/brew shellenv)"
        echo 'eval "$(/opt/homebrew/bin/brew shellenv)"' >> "$HOME/.zprofile"
    fi
    echo -e "  ${GREEN}✓ Homebrew הותקן${NC}"
fi
echo ""

# ── Step 2: Node.js ──
echo -e "${BOLD}[2/4] בודק Node.js...${NC}"
if command -v node &>/dev/null; then
    NODE_VER=$(node -v)
    echo -e "  ${GREEN}✓ Node.js $NODE_VER מותקן${NC}"
else
    echo -e "  ${YELLOW}→ מתקין Node.js...${NC}"
    brew install node
    echo -e "  ${GREEN}✓ Node.js הותקן${NC}"
fi
echo ""

# ── Step 3: BlackHole (virtual audio) ──
echo -e "${BOLD}[3/4] בודק BlackHole (שידור סאונד)...${NC}"
if brew list blackhole-2ch &>/dev/null 2>&1; then
    echo -e "  ${GREEN}✓ BlackHole מותקן${NC}"
else
    echo -e "  ${YELLOW}→ מתקין BlackHole 2ch (כרטיס קול וירטואלי)...${NC}"
    echo -e "  ${YELLOW}  זה מה שמאפשר לשדר סאונד מ-Ableton לתלמיד${NC}"
    brew install blackhole-2ch
    echo -e "  ${GREEN}✓ BlackHole הותקן${NC}"
fi
echo ""

# ── Step 4: Download agent + install robotjs ──
echo -e "${BOLD}[4/4] מתקין StudioSync Agent...${NC}"

# Download latest agent.js
echo -e "  ${YELLOW}→ מוריד agent.js...${NC}"
curl -fsSL "https://raw.githubusercontent.com/Almog369Cohen/studiosync/master/agent.js" -o "$INSTALL_DIR/agent.js"
echo -e "  ${GREEN}✓ agent.js הורד${NC}"

# Create package.json if needed
if [ ! -f "$INSTALL_DIR/package.json" ]; then
    cat > "$INSTALL_DIR/package.json" << 'PKGJSON'
{
  "name": "studiosync-agent",
  "version": "1.0.0",
  "private": true,
  "dependencies": {
    "robotjs": "^0.7.0"
  }
}
PKGJSON
fi

# Install robotjs
echo -e "  ${YELLOW}→ מתקין robotjs (שליטה בעכבר+מקלדת)...${NC}"
echo -e "  ${YELLOW}  זה עלול לקחת דקה-שתיים...${NC}"
cd "$INSTALL_DIR"
npm install --no-audit --no-fund 2>&1 | tail -1
echo -e "  ${GREEN}✓ robotjs הותקן${NC}"
echo ""

# ── Create launcher script ──
cat > "$INSTALL_DIR/start.command" << 'LAUNCHER'
#!/bin/bash
cd "$(dirname "$0")"
clear
echo ""
echo "🎛  StudioSync Agent"
echo "   שליטה מרחוק על העכבר והמקלדת"
echo ""
echo "   הכנס את קוד הסשן (לדוגמה: ABC-123):"
echo ""
read -p "   קוד: " CODE
if [ -z "$CODE" ]; then
    echo ""
    echo "❌ לא הוכנס קוד!"
    read -p "לחץ Enter לסגירה..."
    exit 1
fi
echo ""
echo "   🚀 מתחבר..."
echo ""
node agent.js "https://studiosync-nxu0.onrender.com" "$CODE"
echo ""
read -p "לחץ Enter לסגירה..."
LAUNCHER
chmod +x "$INSTALL_DIR/start.command"

# ── Create Multi-Output Device automatically ──
echo -e "${BOLD}══════════════════════════════════════════${NC}"
echo ""
echo -e "${GREEN}${BOLD}   ✅ ההתקנה הושלמה!${NC}"
echo ""
echo -e "${BOLD}   📁 הקבצים הותקנו ב: $INSTALL_DIR${NC}"
echo ""
echo -e "${CYAN}${BOLD}   ═══ מה עכשיו? 3 צעדים קלים ═══${NC}"
echo ""
echo -e "${BOLD}   צעד 1: הגדרת סאונד (פעם אחת בלבד)${NC}"
echo ""
echo "   א. פתח: Audio MIDI Setup (חפש ב-Spotlight)"
echo "   ב. לחץ + למטה משמאל → Create Multi-Output Device"
echo "   ג. סמן ✓ ליד BlackHole 2ch + ליד הרמקולים שלך"
echo "   ד. באבלטון → Preferences → Audio → Output →"
echo "      בחר: Multi-Output Device"
echo ""
echo -e "${BOLD}   צעד 2: פתיחת סשן${NC}"
echo ""
echo "   א. פתח https://studiosync-nxu0.onrender.com בדפדפן"
echo "   ב. לחץ 'פתח סשן חדש'"
echo "   ג. שתף מסך → בחר את מסך Ableton"
echo ""
echo -e "${BOLD}   צעד 3: הפעלת שליטה מרחוק${NC}"
echo ""
echo "   א. דאבל-קליק על: ${INSTALL_DIR}/start.command"
echo "   ב. הכנס את קוד הסשן"
echo "   ג. זהו! התלמיד שולט בעכבר ומקלדת 🎉"
echo ""
echo -e "${CYAN}══════════════════════════════════════════${NC}"
echo ""

# Open the install folder in Finder
open "$INSTALL_DIR"

read -p "לחץ Enter לסגירה..."
