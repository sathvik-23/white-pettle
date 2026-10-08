# ════════════════════════════════════════════════════════════════════════════
#  White Petal's database ON PerfStaq's instance.
#
#  Creating a database and a user is an online operation: perfstaq-pg is not
#  restarted, and PerfStaq's database is not touched.
#
#  The app creates its own tables at boot, into schema `whitepetal`, under a
#  Postgres advisory lock (so two instances starting together cannot both run
#  a migration). That is why neither CI nor this file needs a database
#  connection, and why there is no Cloud SQL proxy step anywhere.
# ════════════════════════════════════════════════════════════════════════════

resource "google_sql_database" "whitepetal" {
  name     = "whitepetal"
  instance = data.google_sql_database_instance.shared.name

  # ABANDON, not the default DELETE. A `terraform destroy` of this stack must
  # never DROP DATABASE on an instance that also holds PerfStaq's customers.
  # To really remove the data: `gcloud sql databases delete whitepetal
  # --instance=perfstaq-pg`, by hand, on purpose.
  deletion_policy = "ABANDON"
}

resource "google_sql_user" "app" {
  name     = "whitepetal_app"
  instance = data.google_sql_database_instance.shared.name
  password = random_password.db_app.result

  # ABANDON because Postgres refuses to drop a role that still owns objects —
  # and this role owns every table in schema `whitepetal`. With the default,
  # a destroy fails half-way with "role cannot be dropped because some
  # objects depend on it", leaving the stack in a state nobody planned.
  deletion_policy = "ABANDON"
}

# special = false: the password is embedded in a postgresql:// URL, and a
# `@`, `/`, `?` or `#` in it silently changes which host or database the URL
# means. 32 alphanumerics is ~190 bits; nothing is gained by punctuation.
#
# It lives in the Terraform state (as PerfStaq's do). The state is the private
# GCS bucket in versions.tf; see README "Secrets in state".
resource "random_password" "db_app" {
  length  = 32
  special = false
}
