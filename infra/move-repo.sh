#!/usr/bin/env bash
# ════════════════════════════════════════════════════════════════════════════
#  Move the White Petal GitHub repository into an organisation, and point the
#  deploy setup at its new name. Safe to re-run.
#
#      infra/move-repo.sh perfstaq          # the org's GitHub handle
#      infra/bootstrap.sh --rebuild         # then: re-applies the deploy trust
#                                           # and sets the Actions variables there
#
#  What it does:
#    1. checks you are logged in with `gh` and can see the organisation;
#    2. transfers sathvik-23/white-pettle to it (GitHub keeps redirects from
#       the old URL, and moves issues, PRs, Actions secrets and variables);
#    3. points this clone's `origin` at the new URL;
#    4. writes github_repo = "<org>/white-pettle" into terraform.tfvars, using
#       GitHub's exact spelling (the deploy trust compares it case-sensitively);
#    5. commits that and pushes the current branch to the new repository.
#
#  Why step 4 matters: Google trusts GitHub Actions deploys only from the repo
#  named in infra/terraform (github.tf). After a transfer, the deploy token says
#  "<org>/white-pettle", so until bootstrap.sh re-applies with the new name,
#  pushes to main build but cannot deploy.
#
#  bash 3.2-safe (macOS's /bin/bash).
# ════════════════════════════════════════════════════════════════════════════
set -euo pipefail

ORG="${1:-}"
OLD="sathvik-23/white-pettle"
NAME="white-pettle"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TFVARS="$ROOT/infra/terraform/terraform.tfvars"

step() { printf '\n==> %s\n' "$*"; }
info() { printf '    %s\n' "$*"; }
die()  { printf '\n!!  %s\n' "$*" >&2; exit 1; }

command -v gh >/dev/null || die "gh is not installed: brew install gh && gh auth login"
gh auth status >/dev/null 2>&1 || die "gh is not logged in: gh auth login"
ME="$(gh api user --jq .login)"

if [ -z "$ORG" ]; then
  echo "usage: infra/move-repo.sh <github-org>"
  echo "Organisations $ME belongs to:"
  gh api user/orgs --jq '.[].login' | sed 's/^/  /'
  exit 1
fi

step "[1] Checking the organisation '$ORG'"
gh api "orgs/$ORG" --jq .login >/dev/null 2>&1 || {
  echo "    Can't see an organisation called '$ORG' as $ME. Yours are:"
  gh api user/orgs --jq '.[].login' | sed 's/^/      /'
  die "pass the exact handle from that list (it is the name in github.com/<handle>)."
}
info "ok, logged in as $ME"

step "[2] Transferring $OLD → $ORG/$NAME"
NEW="$(gh api "repos/$ORG/$NAME" --jq .full_name 2>/dev/null || true)"
if [ -n "$NEW" ] && [ "$(echo "$NEW" | tr 'A-Z' 'a-z')" = "$(echo "$ORG/$NAME" | tr 'A-Z' 'a-z')" ]; then
  info "already in the organisation: $NEW"
else
  if ! gh api -X POST "repos/$OLD/transfer" -f new_owner="$ORG" >/dev/null; then
    die "GitHub refused the transfer. Usual causes: the organisation does not let
    members create repositories, or $ME is not allowed to. An org owner can
    allow it (Org settings → Member privileges → Repository creation), or do it
    by hand: github.com/$OLD → Settings → Danger zone → Transfer. Then re-run
    this script; it carries on from here."
  fi
  info "transfer requested; waiting for it to finish"
  for i in $(seq 1 30); do
    NEW="$(gh api "repos/$ORG/$NAME" --jq .full_name 2>/dev/null || true)"
    [ -n "$NEW" ] && break
    sleep 2
  done
  [ -n "$NEW" ] || die "the transfer did not show up after 60 s. If the organisation needs an
    owner to accept incoming transfers, accept it, then re-run this script."
  info "moved: $NEW"
fi

step "[3] Pointing this clone at https://github.com/$NEW"
git -C "$ROOT" remote set-url origin "https://github.com/$NEW.git"
info "origin → $(git -C "$ROOT" remote get-url origin)"

step "[4] Telling the deploy setup the new name"
touch "$TFVARS"
if grep -qE '^[[:space:]]*github_repo[[:space:]]*=' "$TFVARS"; then
  sed -i.bak -E "s|^[[:space:]]*github_repo[[:space:]]*=.*$|github_repo = \"$NEW\"|" "$TFVARS" && rm -f "$TFVARS.bak"
else
  printf '\n# The only GitHub repository allowed to deploy (see github.tf). Set by infra/move-repo.sh.\ngithub_repo = "%s"\n' "$NEW" >> "$TFVARS"
fi
info "terraform.tfvars: github_repo = \"$NEW\""

step "[5] Committing and pushing"
BRANCH="$(git -C "$ROOT" rev-parse --abbrev-ref HEAD)"
git -C "$ROOT" add "$TFVARS"
if git -C "$ROOT" diff --cached --quiet; then
  info "nothing new to commit"
else
  git -C "$ROOT" commit -q -m "Deploy from $NEW (repository moved into the $ORG organisation)"
  info "committed on $BRANCH"
fi
git -C "$ROOT" push -u origin "$BRANCH"

step "Done"
echo "Next, run:  infra/bootstrap.sh --rebuild"
echo "It re-applies Terraform so Google trusts deploys from $NEW, deploys the app,"
echo "and sets the GitHub Actions variables on $NEW."
echo
echo "Also check: Vercel's Git link to $OLD (disconnect it), and any local clone"
echo "elsewhere (git remote set-url origin https://github.com/$NEW.git)."
