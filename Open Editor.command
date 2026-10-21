#!/bin/bash
# Double-click to open free247editor in your browser (macOS). Keep the window open while you edit.
cd "$(dirname "$0")"
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is not installed. Install it with: brew install node"
  read -n 1 -s -r -p "Press any key to close."
  exit 1
fi
node app/server.mjs
