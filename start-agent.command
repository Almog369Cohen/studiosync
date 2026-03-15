#!/bin/bash
# ══════════════════════════════════════════════════════════
# StudioSync Agent — הפעלה קלה
# לחץ דאבל-קליק על הקובץ הזה כדי להפעיל
# ══════════════════════════════════════════════════════════

cd "$(dirname "$0")"

echo ""
echo "🎛  StudioSync Agent"
echo "   שליטה מרחוק על העכבר והמקלדת"
echo ""

# Check if Node.js is installed
if ! command -v node &> /dev/null; then
    echo "❌ Node.js לא מותקן!"
    echo "   הורד מ: https://nodejs.org"
    echo ""
    read -p "לחץ Enter לסגירה..."
    exit 1
fi

# Check if robotjs is installed
if ! node -e "require('robotjs')" 2>/dev/null; then
    echo "📦 מתקין robotjs (פעם ראשונה בלבד)..."
    npm install robotjs
    echo ""
fi

# Server URL
SERVER="https://studiosync-nxu0.onrender.com"

echo "   שרת: $SERVER"
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
echo "   🚀 מתחבר לסשן $CODE..."
echo ""

node agent.js "$SERVER" "$CODE"

echo ""
read -p "לחץ Enter לסגירה..."
