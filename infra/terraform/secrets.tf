# ════════════════════════════════════════════════════════════════════════════
#  Secret Manager.
#
#  Terraform creates the CONTAINERS. Provider keys are added by hand —
#
#      infra/secrets.sh OPENAI_API_KEY            (prompts, input hidden)
#
#  — because a key written in a .tf file is a key in plaintext in git, in the
#  state bucket and in every plan output.
#
#  THE DIFFERENCE FROM PERFSTAQ, and why it matters: PerfStaq mounts each
#  secret as a Cloud Run env var (`secret_key_ref`), and Cloud Run REFUSES TO
#  START a revision whose referenced secret has no version — which is how a
#  key nobody had set yet took the PerfStaq admin console down. White Petal
#  instead reads its secrets ITSELF at boot (SECRETS_FROM_GSM=1), and a secret
#  with no version is skipped. So:
#
#    * a missing key disables one engine; it never stops the service booting;
#    * there are NO secret references on the Cloud Run service, so adding a
#      key needs no Terraform change — `secrets.sh` + a new revision.
#
#  Every name is prefixed WHITEPETAL_ because the project is shared: PerfStaq
#  already owns DATABASE_URL, OPENAI_API_KEY and ANTHROPIC_API_KEY, and two
#  products reading one DATABASE_URL would be a very quiet disaster.
#
#  COST: $0.06 per ACTIVE VERSION per month; the 6 free versions per billing
#  account are already used by PerfStaq's ~20 secrets. An EMPTY container
#  costs nothing. So the bill is (keys you actually set + 3) × $0.06, and
#  secrets.sh DESTROYS the previous version on rotation — a disabled version
#  is still an active, billed version.
# ════════════════════════════════════════════════════════════════════════════

locals {
  # MUST MATCH the list the app loads at boot. A name here that the app does
  # not read costs nothing (no version, no bill); a name the app reads that is
  # missing here can never be set.
  secret_names = toset([
    "DATABASE_URL",
    "APP_SECRET",
    "CRON_SECRET",
    "OPENAI_API_KEY",
    "GEMINI_API_KEY",
    "PERPLEXITY_API_KEY",
    "GROQ_API_KEY",
    "ANTHROPIC_API_KEY",
    "GOOGLE_OAUTH_CLIENT_ID",
    "GOOGLE_OAUTH_CLIENT_SECRET",
    "GOOGLE_API_KEY",
    "DATAFORSEO_LOGIN",
    "DATAFORSEO_PASSWORD",
    "SERPAPI_KEY",
    "ACCESS_CODE",
    "RESEND_API_KEY",
    # Razorpay (paid plans). Test and live sets are separate values in
    # separate environments; set them with infra/secrets.sh, never in a file.
    "RAZORPAY_KEY_ID",
    "RAZORPAY_KEY_SECRET",
    "RAZORPAY_WEBHOOK_SECRET",
  ])

  # node-postgres reads a Unix socket from `?host=/cloudsql/<connection>`
  # and appends `/.s.PGSQL.5432` itself. (postgres.js cannot — that is why
  # PerfStaq needed a VPC and a private IP. White Petal needs neither.)
  #
  # No sslmode: the socket is local to the instance; Cloud Run's built-in Auth
  # Proxy carries it to Cloud SQL over TLS with mutual identity, which is what
  # satisfies perfstaq-pg's ssl_mode = ENCRYPTED_ONLY. Do not add
  # sslmode=require "for safety": it makes node-postgres ask the local proxy
  # socket for TLS, which that socket does not offer.
  database_url = format(
    "postgresql://%s:%s@/%s?host=/cloudsql/%s",
    google_sql_user.app.name,
    random_password.db_app.result,
    google_sql_database.whitepetal.name,
    data.google_sql_database_instance.shared.connection_name,
  )
}

resource "google_secret_manager_secret" "app" {
  for_each  = local.secret_names
  secret_id = "WHITEPETAL_${each.value}"

  # Automatic replication is billed as ONE location. User-managed replication
  # to N regions would multiply every version's $0.06 by N.
  replication {
    auto {}
  }

  depends_on = [google_project_service.this]
}

# Per-secret, NOT project-wide secretAccessor. A project-level grant would let
# White Petal's runtime read PerfStaq's DATABASE_URL, OPENAI_ADMIN_KEY and
# every OAuth token secret in the project — the shared project makes this the
# most important IAM line in the stack.
resource "google_secret_manager_secret_iam_member" "runtime" {
  for_each = google_secret_manager_secret.app

  secret_id = each.value.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.runtime.email}"
}

# ── The three values Terraform writes itself ────────────────────────────────
# They are generated here, so they are in state already; writing them to
# Secret Manager adds no exposure and saves pasting a 48-character string.

resource "google_secret_manager_secret_version" "database_url" {
  secret      = google_secret_manager_secret.app["DATABASE_URL"].id
  secret_data = local.database_url
}

resource "google_secret_manager_secret_version" "app_secret" {
  secret      = google_secret_manager_secret.app["APP_SECRET"].id
  secret_data = random_password.app_secret.result
}

resource "google_secret_manager_secret_version" "cron_secret" {
  secret      = google_secret_manager_secret.app["CRON_SECRET"].id
  secret_data = random_password.cron_secret.result
}

# Alphanumeric: CRON_SECRET travels in an HTTP header and in shell commands
# (`curl -H x-cron-secret:...`) where `$`, `!` and quotes cause grief. 48
# alphanumerics is ~285 bits.
resource "random_password" "app_secret" {
  length  = 48
  special = false
}

resource "random_password" "cron_secret" {
  length  = 48
  special = false
}
