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
