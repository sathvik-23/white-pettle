# ════════════════════════════════════════════════════════════════════════════
#  The EXISTING PerfStaq estate, looked up — never managed.
#
#  Everything in this file is owned by PerfStaq's Terraform (state prefix
#  `infra`). Declaring any of it as a `resource` here would give one object
#  two owners, and the next apply of either stack would fight the other.
#  Data sources read; they cannot change, import or destroy.
# ════════════════════════════════════════════════════════════════════════════

data "google_project" "this" {
  project_id = var.project_id
}

# perfstaq-pg: POSTGRES_17, db-f1-micro, ENTERPRISE, public + private IP,
# ssl_mode ENCRYPTED_ONLY.
#
# White Petal gets a DATABASE on it, not an instance. A second db-f1-micro is
# $0.0105/hour ≈ $7.70/month (~₹750) before storage — more than everything
# else in this stack combined, for a workload that is a few hundred rows a day.
# The cost of sharing is in the README: one more tenant on 25 connection slots
# and a shared-core CPU with no SLA.
data "google_sql_database_instance" "shared" {
  name = var.sql_instance
}

# PerfStaq's pool. Its provider `github-oidc` only admits Perfstaq repos, and
# that is left untouched; github.tf adds a SECOND provider with its own
# repository condition.
data "google_iam_workload_identity_pool" "github" {
  workload_identity_pool_id = var.wif_pool_id
}
