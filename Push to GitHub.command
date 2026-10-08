#!/bin/bash
# Double-click to push the current branch of White Petal to its GitHub repository (origin).
cd "$(dirname "$0")"
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
git push -u origin "$BRANCH" && echo "" && echo "Pushed $BRANCH to $(git remote get-url origin)."
