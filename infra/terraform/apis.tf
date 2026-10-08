# ════════════════════════════════════════════════════════════════════════════
#  APIs.
#
#  Most of these are already on — PerfStaq enabled them — and enabling an
#  enabled API is a no-op. They are listed so this stack works on its own and
#  so a reader can see everything White Petal depends on.
#
#  disable_on_destroy = false is THE line that matters in this file. The
#  default is true, which means `terraform destroy` of White Petal would
#  DISABLE Cloud Run, Cloud SQL Admin and Secret Manager for the whole
#  project — and take every PerfStaq service down with it.
# ════════════════════════════════════════════════════════════════════════════

locals {
  apis = toset([
    "run.googleapis.com",              # the service
    "sqladmin.googleapis.com",         # Cloud Run's /cloudsql socket is the Auth Proxy, which calls this API
    "secretmanager.googleapis.com",    # the app reads its keys at boot
    "artifactregistry.googleapis.com", # images
    "cloudscheduler.googleapis.com",   # the hourly cron tick
    "iamcredentials.googleapis.com",   # WIF → short-lived deployer token
    "sts.googleapis.com",              # WIF token exchange (PerfStaq's deploys already use it)
    "iam.googleapis.com",              # service accounts, WIF provider
    "cloudbuild.googleapis.com",       # bootstrap.sh's first image only
    "billingbudgets.googleapis.com",   # budget.tf
    "logging.googleapis.com",          # logging.tf exclusion
    "kgsearch.googleapis.com",         # Knowledge Graph Search, used by the entity integration with GOOGLE_API_KEY (free)
  ])
}

resource "google_project_service" "this" {
  for_each = local.apis

  project            = var.project_id
  service            = each.value
  disable_on_destroy = false

  # Also false, for the same reason one level down: disabling with
  # dependents would cascade into services PerfStaq uses.
  disable_dependent_services = false
}
