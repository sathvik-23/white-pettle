# ════════════════════════════════════════════════════════════════════════════
#  Log exclusion — drop the request logs that carry no information.
#
#  Cloud Logging is free to 50 GiB per PROJECT per month, then $0.50/GiB, and
#  that 50 GiB is shared with PerfStaq. Cloud Run writes one request-log entry
#  (~1 KB) per HTTP request, and a single page load of White Petal is a dozen
#  static files. An excluded entry is never ingested, so it is never billed.
#
#  Kept, always: every error (status ≥ 400), every /api/* request (including
#  the cron tick and the agent's streams), every non-GET, and every line the
#  app itself prints (stdout/stderr are a different log). Dropped: successful
#  GETs of static assets for this one service.
# ════════════════════════════════════════════════════════════════════════════

resource "google_logging_project_exclusion" "static_requests" {
  count = var.exclude_static_request_logs ? 1 : 0

  name        = "whitepetal-static-2xx"
  description = "White Petal: drop successful static-asset GET request logs (cost guardrail; errors and /api/* are kept)."

  filter = join(" AND ", [
    "resource.type=\"cloud_run_revision\"",
    "resource.labels.service_name=\"${google_cloud_run_v2_service.whitepetal.name}\"",
    "logName=\"projects/${var.project_id}/logs/run.googleapis.com%2Frequests\"",
    "httpRequest.requestMethod=\"GET\"",
    "httpRequest.status<400",
    "NOT httpRequest.requestUrl:\"/api/\"",
  ])

  depends_on = [google_project_service.this]
}
