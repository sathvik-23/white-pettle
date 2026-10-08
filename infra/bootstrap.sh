#!/usr/bin/env bash
# ════════════════════════════════════════════════════════════════════════════
#  White Petal on Google Cloud — the one-time setup, safe to re-run.
#
#      infra/bootstrap.sh                 # from the repo root, on the Mac
#      infra/bootstrap.sh --rebuild       # also rebuild + roll out local code
#      ENV_FILE=~/keys.env infra/bootstrap.sh
#      NO_PROMPT=1 infra/bootstrap.sh     # never ask for keys interactively
#
#  What it does, in order (every step is idempotent):
#    1. checks gcloud / terraform / curl, and that you are logged in;
#    2. points gcloud at the project and enables the APIs;
#    3. terraform init + apply (database + user on perfstaq-pg, registry,
#       secrets, Cloud Run service, scheduler, WIF provider, deployer, budget);
#    4. stores provider keys from .env.local (or prompts, input hidden) —
#       only non-empty, non-placeholder, CHANGED values;
#    5. builds the first image with Cloud Build and rolls it out — skipped on
#       re-runs once a real image is serving, unless --rebuild;
#    6. waits for /api/health;
#    7. sets the GitHub Actions repository variables with `gh`;
#    8. prints the URL and the remaining manual steps.
#
#  After this, deploys are GitHub Actions on every push to main. This script
#  never needs to run again unless the infrastructure changes.
#
#  bash 3.2-safe (macOS's /bin/bash): no associative arrays, no mapfile, no
#  empty-array expansions under `set -u`.
# ════════════════════════════════════════════════════════════════════════════
set -euo pipefail

PROJECT="global-bridge-508618-u6"
REGION="us-central1"
SERVICE="whitepetal"
# The repository allowed to deploy: terraform.tfvars `github_repo` when set
# (infra/move-repo.sh writes it), else the Terraform default.
GITHUB_REPO="$(sed -n -E 's/^[[:space:]]*github_repo[[:space:]]*=[[:space:]]*"([^"]+)".*/\1/p' "$(cd "$(dirname "$0")" && pwd)/terraform/terraform.tfvars" 2>/dev/null | tail -1)"
GITHUB_REPO="${GITHUB_REPO:-sathvik-23/white-pettle}"
STATE_BUCKET="perfstaq-tfstate-global-bridge-508618-u6"
PLACEHOLDER="us-docker.pkg.dev/cloudrun/container/hello"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TF_DIR="$ROOT/infra/terraform"
REBUILD=0
for a in "$@"; do
  case "$a" in
    --rebuild) REBUILD=1 ;;
    -h|--help) sed -n '2,30p' "$0"; exit 0 ;;
    *) echo "unknown option: $a" >&2; exit 1 ;;
  esac
done

STEP=0
step() { STEP=$((STEP + 1)); printf '\n\033[1m==> [%s] %s\033[0m\n' "$STEP" "$*"; }
info() { printf '    %s\n' "$*"; }
warn() { printf '\033[33m    ! %s\033[0m\n' "$*"; }
die()  { printf '\033[31merror: %s\033[0m\n' "$*" >&2; exit 1; }
gc()   { gcloud --project="$PROJECT" --quiet "$@"; }
tf()   { terraform -chdir="$TF_DIR" "$@"; }

# ── 1. Tools and logins ─────────────────────────────────────────────────────
step "Checking tools and logins"
for t in gcloud terraform curl git; do
  command -v "$t" >/dev/null || die "$t is not installed"
done
TF_VER="$(terraform version | head -1 | sed -E 's/[^0-9]*([0-9]+\.[0-9]+).*/\1/')"
case "$TF_VER" in
  0.*|1.[0-4]) die "terraform $TF_VER is too old; versions.tf needs >= 1.5" ;;
esac
info "terraform $TF_VER, $(gcloud version 2>/dev/null | head -1)"

ACCOUNT="$(gcloud auth list --filter=status:ACTIVE --format='value(account)' 2>/dev/null | head -1)"
[ -n "$ACCOUNT" ] || die "gcloud is not logged in: run 'gcloud auth login'"
info "gcloud account: $ACCOUNT"

# Terraform authenticates with Application Default Credentials, which are a
# SEPARATE login from `gcloud auth login`. Missing ADC surfaces as a baffling
# "could not find default credentials" half-way through init.
if ! gcloud auth application-default print-access-token >/dev/null 2>&1; then
  warn "No Application Default Credentials — opening the browser for them."
  gcloud auth application-default login
fi

HAVE_GH=0
if command -v gh >/dev/null && gh auth status >/dev/null 2>&1; then HAVE_GH=1; fi
if [ "$HAVE_GH" = 1 ]; then info "gh: logged in"; else warn "gh missing or logged out — GitHub variables will be printed instead of set"; fi

# ── 2. Project and APIs ─────────────────────────────────────────────────────
step "Pointing gcloud at $PROJECT and enabling APIs"
gcloud config set project "$PROJECT" >/dev/null 2>&1
# Terraform enables these too (apis.tf); doing it first means the data
# sources in data.tf can be read on the very first plan. Already-enabled APIs
# are a no-op, so this is cheap on re-runs.
gc services enable \
  run.googleapis.com sqladmin.googleapis.com secretmanager.googleapis.com \
  artifactregistry.googleapis.com cloudscheduler.googleapis.com \
  iamcredentials.googleapis.com sts.googleapis.com iam.googleapis.com \
  cloudbuild.googleapis.com billingbudgets.googleapis.com \
  logging.googleapis.com kgsearch.googleapis.com
info "APIs enabled"

gcloud storage buckets describe "gs://$STATE_BUCKET" >/dev/null 2>&1 \
  || die "state bucket gs://$STATE_BUCKET not found — it is PerfStaq's and must exist already"

# ── 2b. With --rebuild on an existing service: ship the code BEFORE Terraform ─
# Any Terraform change to the service (an env var, a probe) rolls a new
# revision of the image the service CURRENTLY runs. If that image is broken,
# every apply fails there, and step 5 (which would replace it) never runs. So
# when the service and registry already exist, build and roll out first;
# Terraform then applies its changes on top of a working image.
EARLY=0
if [ "$REBUILD" = 1 ] \
   && gc run services describe "$SERVICE" --region="$REGION" >/dev/null 2>&1 \
   && gc artifacts repositories describe "$SERVICE" --location="$REGION" >/dev/null 2>&1; then
  step "Building and rolling out the code first (--rebuild)"
  if [ -n "$(git -C "$ROOT" status --porcelain 2>/dev/null)" ]; then
    warn "the working tree has uncommitted changes — they WILL be in this image"
  fi
  IMAGE="$REGION-docker.pkg.dev/$PROJECT/$SERVICE/$SERVICE:bootstrap-$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || date +%s)"
  gc builds submit "$ROOT" --tag="$IMAGE" || die "Cloud Build failed (see the build log above)."
  gc run services update "$SERVICE" --region="$REGION" --image="$IMAGE" || die "the new image did not start. Its logs:
  gcloud logging read 'resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"$SERVICE\"' --project=$PROJECT --limit=60 --format='value(timestamp,severity,textPayload)'"
  info "running $IMAGE"
  EARLY=1
fi

# ── 3. Terraform ────────────────────────────────────────────────────────────
step "terraform init + apply (state: gs://$STATE_BUCKET/whitepetal)"
tf init -input=false >/dev/null
info "init ok"
# Interactive approval on purpose: this applies to the project PerfStaq's
# customers run in. Read the plan. AUTO_APPROVE=1 skips the prompt.
if [ "${AUTO_APPROVE:-0}" = 1 ]; then
  tf apply -input=false -auto-approve
else
  tf apply -input=false
fi

REGISTRY="$(tf output -raw registry)"
WIF_PROVIDER="$(tf output -raw wif_provider)"
DEPLOYER_SA="$(tf output -raw deployer_sa)"
SERVICE_URL="$(tf output -raw service_url)"
PUBLIC_ORIGIN="$(tf output -raw public_origin)"
info "registry:   $REGISTRY"
info "service:    $SERVICE_URL"

# ── 4. Provider keys ────────────────────────────────────────────────────────
step "Storing provider keys in Secret Manager"
ENV_PATH=""
for f in "${ENV_FILE:-}" "$ROOT/.env.local" "$ROOT/../white-petal-app/.env.local" "$ROOT/.env"; do
  if [ -n "$f" ] && [ -f "$f" ]; then ENV_PATH="$f"; break; fi
done
if [ -n "$ENV_PATH" ]; then info "reading keys from $ENV_PATH"; else info "no .env.local found"; fi

# Parse KEY=VALUE without `source`-ing the file: sourcing would execute any
# shell in it and mangle values containing $ or spaces.
env_value() {
  [ -n "$ENV_PATH" ] || return 0
  sed -n -E "s/^[[:space:]]*(export[[:space:]]+)?$1[[:space:]]*=[[:space:]]*(.*)$/\\2/p" "$ENV_PATH" \
    | tail -1 | sed -E "s/^[\"'](.*)[\"'][[:space:]]*$/\\1/; s/[[:space:]]+$//"
}

KEYS="OPENAI_API_KEY GEMINI_API_KEY PERPLEXITY_API_KEY GROQ_API_KEY ANTHROPIC_API_KEY GOOGLE_OAUTH_CLIENT_ID GOOGLE_OAUTH_CLIENT_SECRET GOOGLE_API_KEY DATAFORSEO_LOGIN DATAFORSEO_PASSWORD SERPAPI_KEY ACCESS_CODE"
CHANGED=0
for k in $KEYS; do
  v="$(env_value "$k")"
  if [ -z "$v" ] || [ "$v" = "[SENSITIVE]" ]; then
    # Not in the file. Prompt only for keys that have NO value in Secret
    # Manager yet, so a re-run does not interrogate you about every key.
    has="$(gc secrets versions list "WHITEPETAL_$k" --filter='state=ENABLED' --limit=1 --format='value(name)' 2>/dev/null || true)"
    if [ -n "$has" ]; then info "$k: already set"; continue; fi
    if [ "${NO_PROMPT:-0}" = 1 ] || [ ! -t 0 ]; then info "$k: not set (skipped)"; continue; fi
    printf '    %s (input hidden, Enter to skip): ' "$k"
    IFS= read -rs v || true
    echo
  fi
  out="$(printf '%s' "$v" | "$ROOT/infra/secrets.sh" "$k" - --no-restart)"
  while IFS= read -r line; do info "${line#"${line%%[! ]*}"}"; done <<<"$out"
  case "$out" in *"stored as version"*) CHANGED=1 ;; esac
done

# ── 5. First image ──────────────────────────────────────────────────────────
CURRENT_IMAGE="$(gc run services describe "$SERVICE" --region="$REGION" --format='value(spec.template.spec.containers[0].image)')"
DEPLOYED=0
if [ "$EARLY" = 1 ]; then
  info "already rolled out before Terraform: $CURRENT_IMAGE"
elif [ "$REBUILD" = 1 ] || [ "$CURRENT_IMAGE" = "$PLACEHOLDER" ] || [ -z "$CURRENT_IMAGE" ]; then
  step "Building the first image with Cloud Build"
  if [ -n "$(git -C "$ROOT" status --porcelain 2>/dev/null)" ]; then
    warn "the working tree has uncommitted changes — they WILL be in this image"
  fi
  # Cloud Build, not a local `docker build`: the Mac is arm64 and Cloud Run is
  # amd64, so a local build needs buildx emulation (slow) and Docker Desktop.
  # The default e2-standard-2 pool is covered by the 2,500 free build-minutes
  # per billing account per month; this build takes ~1–2 of them. The upload
  # honours .gitignore, so .env.local never leaves the laptop.
  IMAGE="$REGISTRY/$SERVICE:bootstrap"
  if ! gc builds submit "$ROOT" --tag="$IMAGE"; then
    die "Cloud Build failed. If the error is a permission denial for the build
  service account, either grant it roles/artifactregistry.writer on the
  'whitepetal' repo, or skip Cloud Build entirely: re-run this script after
  pushing to main, and let GitHub Actions build and deploy instead
  (gh workflow run ci.yml --ref main)."
  fi

  step "Rolling out $IMAGE"
  gc run services update "$SERVICE" --region="$REGION" --image="$IMAGE"
  DEPLOYED=1
else
  info "service already runs $CURRENT_IMAGE — not rebuilding (use --rebuild to force)"
fi

# Keys changed but nothing was deployed: roll a revision so they are read.
if [ "$CHANGED" = 1 ] && [ "$DEPLOYED" = 0 ]; then
  step "Restarting so the app reads the new keys"
  gc run services update "$SERVICE" --region="$REGION" --image="$CURRENT_IMAGE"
fi

# ── 6. Health ───────────────────────────────────────────────────────────────
step "Waiting for $SERVICE_URL/api/health"
BODY=""
for i in $(seq 1 30); do
  BODY="$(curl -fsS --max-time 10 "$SERVICE_URL/api/health" 2>/dev/null || true)"
  case "$BODY" in *'"ok":true'*) break ;; esac
  sleep 5
  [ "$i" = 30 ] && die "no healthy answer after 150 s. Logs:
  gcloud run services logs read $SERVICE --region=$REGION --project=$PROJECT --limit=100"
done
info "health: $BODY"
case "$BODY" in
  *'"db":true'*) info "database: connected" ;;
  *) warn "the app is up but reports db:false — check DATABASE_URL and the logs" ;;
esac
# The org policy failure mode: IAM invoker check back on → bare 403 for
# everyone, while an authenticated health check would still pass.
code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$SERVICE_URL/" || true)"
[ "$code" = 403 ] && warn "/ returns 403: run gcloud run services update $SERVICE --region=$REGION --no-invoker-iam-check"

# ── 7. GitHub Actions variables ─────────────────────────────────────────────
step "GitHub Actions repository variables"
set_var() {
  if [ "$HAVE_GH" = 1 ]; then
    gh variable set "$1" --repo "$GITHUB_REPO" --body "$2" >/dev/null && info "$1 set"
  else
    info "$1=$2"
  fi
}
set_var GCP_WIF_PROVIDER "$WIF_PROVIDER"
set_var GCP_DEPLOYER_SA  "$DEPLOYER_SA"
set_var GCP_PROJECT      "$PROJECT"
set_var GCP_REGION       "$REGION"
set_var GCP_REGISTRY     "$REGISTRY"
[ "$HAVE_GH" = 1 ] || info "(add these at github.com/$GITHUB_REPO/settings/variables/actions)"

# ── 8. Done ─────────────────────────────────────────────────────────────────
step "Done"
info "White Petal: $PUBLIC_ORIGIN"
info "Cloud Run:   $SERVICE_URL"
echo
echo "Next steps:"
echo "  * Push to main: GitHub Actions now tests, builds and deploys every commit."
echo "  * Add or rotate a key any time:   infra/secrets.sh OPENAI_API_KEY"
echo "  * Which keys are set:             infra/secrets.sh"
echo "  * Google OAuth: add $PUBLIC_ORIGIN/ as an authorised origin (and the"
echo "    app's callback path under it) in the OAuth client."
DNS="$(tf output -json domain_dns_records 2>/dev/null || echo '[]')"
if [ "$DNS" != "[]" ] && [ "$DNS" != "null" ]; then
  echo "  * Custom domain — create these records at the registrar:"
  echo "$DNS" | tr '{' '\n' | sed -n -E 's/.*"name":"([^"]*)".*"rrdata":"([^"]*)".*"type":"([^"]*)".*/      \3  \1  →  \2/p'
  echo "    The certificate is issued automatically once DNS resolves (up to ~24 h)."
else
  echo "  * Custom domain (free, no load balancer): put"
  echo "      domain = \"whitepetal.perfstaq.com\""
  echo "    in infra/terraform/terraform.tfvars, re-run this script, and add the"
  echo "    CNAME it prints (whitepetal → ghs.googlehosted.com.) at the registrar."
fi
echo "  * Optional DB isolation hardening: see infra/terraform/README.md."
