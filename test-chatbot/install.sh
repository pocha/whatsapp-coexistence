#!/usr/bin/env bash
# Sets up the test chatbot: checks Node.js and npm, installs the dependencies
# (including cloudflared, which gives the bot its public HTTPS URL), and creates
# .env from .env.example. On Windows without bash, run `npm install` and copy
# .env.example to .env by hand.
set -euo pipefail
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  echo "Node.js and npm are required. Install Node.js 20.6 or newer from https://nodejs.org/ (npm comes with it), then run this again."
  exit 1
fi

node_version="$(node -p 'process.versions.node')"
if ! node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>20||(a===20&&b>=6)?0:1)'; then
  echo "Node.js $node_version is too old. Install Node.js 20.6 or newer from https://nodejs.org/, then run this again."
  exit 1
fi

npm install

if [ ! -f .env ]; then
  cp .env.example .env
  echo "Created .env from .env.example."
fi

echo
echo "Next: fill in .env with the values from the 'Using the test chatbot?' box on your WABA's page, then run: npm start"
