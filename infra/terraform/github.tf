# ════════════════════════════════════════════════════════════════════════════
#  Workload Identity Federation — GitHub Actions deploys with NO long-lived key.
#
#  A service-account JSON in a repo secret never expires, works from anywhere
#  and is invisible once copied. WIF trades it for a token minted per run,
#  valid for minutes, and only for a workflow in the named repository.
#
#  A NEW PROVIDER IN PERFSTAQ'S EXISTING POOL. PerfStaq's provider
#  `github-oidc` admits only Perfstaq repos, and editing its condition from
#  this stack would give one object two owners. A second provider with its
#  own condition leaves PerfStaq's untouched.
# ════════════════════════════════════════════════════════════════════════════

resource "google_iam_workload_identity_pool_provider" "github_whitepetal" {
  workload_identity_pool_id          = data.google_iam_workload_identity_pool.github.workload_identity_pool_id
  workload_identity_pool_provider_id = "github-whitepetal"
  display_name                       = "GitHub: white-pettle"
  description                        = "Deploys from ${var.github_repo} only. Managed by White Petal's Terraform (state prefix whitepetal)."

  attribute_mapping = {
    "google.subject"       = "assertion.sub"
    "attribute.repository" = "assertion.repository"
    "attribute.ref"        = "assertion.ref"
  }

  # THE LOAD-BEARING LINE. Without a condition, any GitHub repository on the
  # internet can exchange its OIDC token at this provider. Google now rejects
  # GitHub providers created without one, which is the right default.
  #
  # Hardening for later: repository NAMES can be re-registered after a rename
  # or delete. `assertion.repository_id == '<numeric id>'` pins the repository
  # itself (`gh api repos/sathvik-23/white-pettle --jq .id`).
  attribute_condition = "assertion.repository == '${var.github_repo}'"

  oidc {
    issuer_uri = "https://token.actions.githubusercontent.com"
  }

  # NB: deleting a provider SOFT-deletes it for 30 days, during which the same
  # ID cannot be re-created. If you destroy and re-apply, either wait, undelete
  # it (`gcloud iam workload-identity-pools providers undelete github-whitepetal
  # --workload-identity-pool=github --location=global`), or change the ID.
}

resource "google_service_account" "deployer" {
  account_id   = "whitepetal-deployer"
  display_name = "White Petal GitHub Actions deployer"
}

# Only this repository may impersonate the deployer. principalSet is scoped to
# the POOL, so a token from PerfStaq's provider (a Perfstaq repo) carries a
# different attribute.repository and can never match this binding.
resource "google_service_account_iam_member" "deployer_wif" {
  service_account_id = google_service_account.deployer.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${data.google_iam_workload_identity_pool.github.name}/attribute.repository/${var.github_repo}"
}

# ── Least privilege, every grant on a RESOURCE, none on the project ─────────
# PerfStaq's deployer holds artifactregistry.writer, run.developer and
# cloudsql.client PROJECT-wide. In a shared project that would let a leaked
# White Petal token push over PerfStaq's images and redeploy PerfStaq's
# services. Every grant below is scoped to White Petal's own resources.

# Push images — to the whitepetal repository only.
resource "google_artifact_registry_repository_iam_member" "deployer_push" {
  project    = google_artifact_registry_repository.whitepetal.project
  location   = google_artifact_registry_repository.whitepetal.location
  repository = google_artifact_registry_repository.whitepetal.name
  role       = "roles/artifactregistry.writer"
  member     = "serviceAccount:${google_service_account.deployer.email}"
}

# Roll out a new image — on the whitepetal service only. Cloud Run supports
# run.developer at service level; it covers get/update/describe, which is all
# `gcloud run services update --image` and the verify step use.
resource "google_cloud_run_v2_service_iam_member" "deployer_run" {
  project  = google_cloud_run_v2_service.whitepetal.project
  location = google_cloud_run_v2_service.whitepetal.location
  name     = google_cloud_run_v2_service.whitepetal.name
  role     = "roles/run.developer"
  member   = "serviceAccount:${google_service_account.deployer.email}"
}

# A new revision runs AS the runtime account, so the deployer must be allowed
# to act as it — that account, and no other. This is the grant people forget;
# the failure is an "iam.serviceAccounts.actAs" denial at deploy time.
resource "google_service_account_iam_member" "deployer_actas" {
  service_account_id = google_service_account.runtime.name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${google_service_account.deployer.email}"
}

# Deliberately NOT granted:
#   cloudbuild.*      CI builds on the GitHub runner (free minutes, gha cache);
#                     Cloud Build is only used once, by bootstrap.sh, as you.
#   cloudsql.client   the app migrates itself at boot; CI never touches the DB.
#   secretmanager.*   CI needs no secret; the app reads its own at runtime.
