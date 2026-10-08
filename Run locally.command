#!/bin/bash
# Double-click to run White Petal on your Mac at http://localhost:3000
cd "$(dirname "$0")"
if [ ! -f .env ]; then cp .env.example .env; [ -f ../.env ] && grep -E '^(OPENAI|PERPLEXITY|GEMINI)_API_KEY=.+' ../.env >> .env; fi
[ -d node_modules ] || npm ci --omit=dev
(sleep 1.5; open http://localhost:3000) &
node dev.mjs
