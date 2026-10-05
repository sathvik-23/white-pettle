#!/bin/bash
# Double-click to push White Petal to github.com/sathvik-23/white-pettle
cd "$(dirname "$0")"
if [ ! -d .git ]; then git init -q -b main; fi
git add -A
git commit -qm "White Petal by Perfstaq: live AI-visibility agent" 2>/dev/null || true
git remote get-url origin >/dev/null 2>&1 || git remote add origin https://github.com/sathvik-23/white-pettle.git
git branch -M main
git push -u origin main && echo "" && echo "Pushed. Now deploy: open the repo on GitHub and click 'Deploy with Vercel' in the README." && open "https://github.com/sathvik-23/white-pettle"
