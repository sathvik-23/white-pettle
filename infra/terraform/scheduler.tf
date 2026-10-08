# ════════════════════════════════════════════════════════════════════════════
#  The hourly cron tick.
#
#  Cloud Scheduler, not an always-on worker: a job is $0.10/month and each
#  billing account gets 3 jobs free (PerfStaq uses none), so this is ₹0. The
#  service sleeps at zero instances between ticks and is billed only for the
#  seconds a tick actually runs.
#
#  ONE job. A 4th job across the billing account starts costing; a paused job
#  still counts as a job.
# ════════════════════════════════════════════════════════════════════════════

resource "google_cloud_scheduler_job" "cron_tick" {
  name        = "whitepetal-cron-tick"
  description = "POST /api/cron/tick — runs the brand checks that are due."
  region      = var.region
  schedule    = var.cron_schedule
  time_zone   = "Etc/UTC"

  # 30 minutes is the MAXIMUM Cloud Scheduler allows for an HTTP target
  # (default is 3 min, which would cut a tick off almost immediately). After
  # it, Scheduler records a failure and drops the connection; with
  # request-based billing the instance's CPU is then throttled as soon as the
  # request is gone, so the app must finish — or checkpoint — inside 30 min.
  attempt_deadline = "1800s"

  # NO retries. A tick that timed out has probably done most of its work and
  # spent real LLM money doing it; a blind retry repeats the spend. The next
  # hourly tick picks up whatever is still due.
  retry_config {
    retry_count = 0
  }

  http_target {
    http_method = "POST"
    uri         = "${google_cloud_run_v2_service.whitepetal.uri}/api/cron/tick"

    # The shared secret the app checks. Two places hold the plaintext and
    # that is a conscious trade: the Terraform state (private bucket) and this
    # job's definition, readable by anyone with cloudscheduler.jobs.get in the
    # project (i.e. project viewers). The alternative — an OIDC token from a
    # scheduler service account, verified by the app — keeps no shared secret
    # anywhere, but needs app code to verify Google-signed JWTs. Rotate with:
    #   terraform apply -replace=random_password.cron_secret
    # (new secret version + new header in one apply; the app reads the new
    # value on its next boot — force one with a new revision).
    headers = {
      "x-cron-secret" = random_password.cron_secret.result
      "Content-Type"  = "application/json"
    }

    # An explicit empty JSON body, so a body parser on the route never sees
    # an empty POST. Scheduler wants it base64-encoded.
    body = base64encode("{}")
  }

  depends_on = [google_project_service.this]
}
