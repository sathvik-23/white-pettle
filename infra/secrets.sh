#!/usr/bin/env bash
# ════════════════════════════════════════════════════════════════════════════
#  Add, rotate or remove ONE White Petal key in Secret Manager.
#
#    infra/secrets.sh                          # which keys are set (never values)
#    infra/secrets.sh OPENAI_API_KEY           # prompt (input hidden), set/rotate
#    printf %s "$V" | infra/secrets.sh NAME -  # value from stdin (used by bootstrap.sh)
#    infra/secrets.sh NAME --unset             # remove every version: engine off
#
#  Options:  --no-restart   do not roll a new Cloud Run revision afterwards
#
#  WHY A SCRIPT and not a bare `gcloud secrets versions add`:
#    * the name gets its WHITEPETAL_ prefix — this project is shared with
#      PerfStaq, which owns the unprefixed OPENAI_API_KEY; writing that one by
#      mistake would change PerfStaq's key, not White Petal's;
#    * an unchanged value is NOT re-added. Every active version is billed
#      ($0.06/month), so re-running bootstrap must not grow the bill;
#    * older versions are DESTROYED after a rotation, for the same reason — a
#      disabled version is still an active, billed one. The trade: no rollback
#      to the previous value from Secret Manager; keep it in your password
#      manager;
#    * the app reads keys at BOOT, so a new value needs a new revision. This
#      re-deploys the image already running (gcloud forces a fresh revision),
#      which is a no-code-change restart.
#
#  bash 3.2-safe (macOS's /bin/bash): no associative arrays, no mapfile.
# ════════════════════════════════════════════════════════════════════════════
set -euo pipefail

PROJECT="${GCP_PROJECT:-global-bridge-508618-u6}"
REGION="${GCP_REGION:-us-central1}"
SERVICE="whitepetal"
PREFIX="WHITEPETAL_"

# Keys a human sets. MUST match local.secret_names in infra/terraform/secrets.tf
# minus the three Terraform writes itself.
MANUAL_KEYS="OPENAI_API_KEY GEMINI_API_KEY PERPLEXITY_API_KEY GROQ_API_KEY ANTHROPIC_API_KEY GOOGLE_OAUTH_CLIENT_ID GOOGLE_OAUTH_CLIENT_SECRET GOOGLE_API_KEY DATAFORSEO_LOGIN DATAFORSEO_PASSWORD SERPAPI_KEY ACCESS_CODE"
# Written by Terraform from generated values. Editing them by hand would make
# Secret Manager disagree with the state (and the Scheduler job's header).
TF_KEYS="DATABASE_URL APP_SECRET CRON_SECRET"

die() { echo "error: $*" >&2; exit 1; }
contains() { case " $1 " in *" $2 "*) return 0 ;; *) return 1 ;; esac; }

gc() { gcloud --project="$PROJECT" --quiet "$@"; }

live_versions() { # names of every non-destroyed version, newest first
  gc secrets versions list "$1" --filter='state!=DESTROYED' --format='value(name)' 2>/dev/null \
    | sed 's#.*/##'
}

restart_service() {
  # Re-deploying the running image makes gcloud attach a fresh nonce to the
  # template, which creates a new revision; its instances boot and read the
  # latest secret versions. Old instances drain normally.
  if ! gc run services describe "$SERVICE" --region="$REGION" >/dev/null 2>&1; then
    echo "  (service not deployed yet — the first deploy will pick the key up)"
    return 0
  fi
  local img
  img="$(gc run services describe "$SERVICE" --region="$REGION" --format='value(spec.template.spec.containers[0].image)')"
  echo "==> Rolling a new revision so the app re-reads its keys (image unchanged)"
  gc run services update "$SERVICE" --region="$REGION" --image="$img" >/dev/null
  echo "  done"
}

list_status() {
  echo "White Petal keys in project $PROJECT (values are never printed):"
  local k n
  for k in $TF_KEYS $MANUAL_KEYS; do
    n="$(live_versions "${PREFIX}${k}" | wc -l | tr -d ' ')"
    if [ "$n" -gt 0 ]; then
      printf '  %-28s set   (%s active version%s)\n' "$k" "$n" "$([ "$n" = 1 ] || echo s)"
    else
      printf '  %-28s -\n' "$k"
    fi
  done
  echo
  echo "Set one with: infra/secrets.sh NAME"
}

# ── Arguments ───────────────────────────────────────────────────────────────
NAME=""; MODE="prompt"; RESTART=1
for a in "$@"; do
  case "$a" in
    --no-restart) RESTART=0 ;;
    --unset) MODE="unset" ;;
    -) MODE="stdin" ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    -*) die "unknown option $a" ;;
    *) NAME="${a#"$PREFIX"}" ;; # accept the name with or without the prefix
  esac
done

command -v gcloud >/dev/null || die "gcloud is not installed"

if [ -z "$NAME" ]; then list_status; exit 0; fi

if contains "$TF_KEYS" "$NAME"; then
  die "$NAME is generated and written by Terraform. Rotate it with
  terraform -chdir=infra/terraform apply -replace=random_password.$(echo "$NAME" | tr '[:upper:]' '[:lower:]' | sed 's/database_url/db_app/')"
fi
contains "$MANUAL_KEYS" "$NAME" || die "unknown key '$NAME'. Known: $MANUAL_KEYS"

SECRET="${PREFIX}${NAME}"
gc secrets describe "$SECRET" >/dev/null 2>&1 \
  || die "secret $SECRET does not exist — run infra/bootstrap.sh (terraform creates the containers)"

# ── Unset ───────────────────────────────────────────────────────────────────
if [ "$MODE" = "unset" ]; then
  for v in $(live_versions "$SECRET"); do
    gc secrets versions destroy "$v" --secret="$SECRET" >/dev/null
    echo "  destroyed $SECRET version $v"
  done
  [ "$RESTART" = 1 ] && restart_service
  exit 0
fi

# ── Read the value without echoing it ───────────────────────────────────────
VALUE=""
if [ "$MODE" = "stdin" ]; then
  VALUE="$(cat)"
else
  [ -t 0 ] || die "no terminal to prompt on; pipe the value in with '-'"
  printf '%s (input hidden, Enter to skip): ' "$NAME" >&2
  IFS= read -rs VALUE || true
  echo >&2
fi
# Strip a trailing newline/CR (pasted values, `echo` without -n).
VALUE="$(printf '%s' "$VALUE" | tr -d '\r\n')"

# Empty, or the "[SENSITIVE]" placeholder some exports write in place of a
# real value: nothing to store. Storing it would make the app believe the
# engine is configured and fail at the first real call.
if [ -z "$VALUE" ] || [ "$VALUE" = "[SENSITIVE]" ]; then
  echo "  $NAME: skipped (empty or placeholder)"
  exit 0
fi

# ── Idempotency: unchanged value → no new (billed) version ──────────────────
CURRENT="$(gc secrets versions access latest --secret="$SECRET" 2>/dev/null || true)"
if [ -n "$CURRENT" ] && [ "$CURRENT" = "$VALUE" ]; then
  echo "  $NAME: unchanged"
  exit 0
fi

NEW="$(printf '%s' "$VALUE" | gc secrets versions add "$SECRET" --data-file=- --format='value(name)' | sed 's#.*/##')"
echo "  $NAME: stored as version $NEW"

# Destroy everything older. Billing is per ACTIVE version (enabled OR disabled).
for v in $(live_versions "$SECRET"); do
  [ "$v" = "$NEW" ] && continue
  gc secrets versions destroy "$v" --secret="$SECRET" >/dev/null
  echo "  $NAME: destroyed old version $v"
done

if [ "$RESTART" = 1 ]; then restart_service; fi
