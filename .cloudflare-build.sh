#!/usr/bin/env bash
set -euo pipefail

ARCHIVE="contentcraft (2).zip"
SRC_DIR="contentcraft-src"

if [ ! -f "$ARCHIVE" ]; then
  echo "ContentCraft source archive not found: $ARCHIVE" >&2
  exit 1
fi

rm -rf "$SRC_DIR"
mkdir -p "$SRC_DIR"
unzip -oq "$ARCHIVE" -d "$SRC_DIR"

for required in package.json index.html services/geminiService.ts services/firebase.ts vite.config.ts; do
  if [ ! -f "$SRC_DIR/$required" ]; then
    echo "Required ContentCraft source file missing: $required" >&2
    exit 1
  fi
done

cp .github/patches/contentcraft/services/geminiService.ts "$SRC_DIR/services/geminiService.ts"
cp .github/patches/contentcraft/services/firebase.ts "$SRC_DIR/services/firebase.ts"
cp .github/patches/contentcraft/vite.config.ts "$SRC_DIR/vite.config.ts"

# Never allow an archived local environment file to enter the build.
rm -f "$SRC_DIR/.env" "$SRC_DIR/.env.local" "$SRC_DIR/.env.production"

cd "$SRC_DIR"
npm install --no-audit --no-fund
npm run build

if grep -R -E 'AIza[0-9A-Za-z_-]{30,}|process\.env\.(API_KEY|GEMINI_API_KEY)' dist; then
  echo "Potential API secret or server-only environment access found in built assets." >&2
  exit 1
fi

test -s dist/index.html
echo "ContentCraft build completed; dist/index.html exists and secret scan passed."
