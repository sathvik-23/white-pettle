# ════════════════════════════════════════════════════════════════════════════
#  Artifact Registry — White Petal's own repository.
#
#  Its own repo rather than a package inside PerfStaq's `perfstaq` repo, for
#  two reasons: the deployer can be granted writer on THIS repository only (a
#  leaked White Petal token cannot overwrite PerfStaq's api image), and the
#  cleanup policy below can be strict without touching PerfStaq's images.
# ════════════════════════════════════════════════════════════════════════════

resource "google_artifact_registry_repository" "whitepetal" {
  repository_id = "whitepetal"
  location      = var.region # same region as Cloud Run: image pulls are free
  format        = "DOCKER"
  description   = "White Petal images. Pushed by GitHub Actions; rebuilt from git on every deploy."

  # ── Cleanup ───────────────────────────────────────────────────────────────
  # A KEEP policy on its own deletes NOTHING. Keep rules only rescue
  # artifacts that a DELETE rule matched; with no DELETE rule nothing is ever
  # matched. (PerfStaq's repo has exactly that — one KEEP, no DELETE — so it
  # keeps every image it has ever pushed. See docs/perfstaq-cost-review.md.)
  #
  # The resulting rule, in words: the 5 newest images of each package are
  # always kept; anything else is deleted once it is 7 days old (untagged —
  # i.e. orphaned layers of a re-pushed :latest) or 30 days old (tagged).
  #
  # Durations are written in seconds. The API stores "604800s" whatever you
  # send, and a "7d" in config can show up as a perpetual diff.
  # Cleanup runs as a background job about once a day, so the effect is not
  # immediate.

  cleanup_policy_dry_run = false # the default is "off" only by omission; say it

  cleanup_policies {
    id     = "delete-untagged-7d"
    action = "DELETE"
    condition {
      tag_state  = "UNTAGGED"
      older_than = "604800s" # 7 days
    }
  }

  cleanup_policies {
    id     = "delete-tagged-30d"
    action = "DELETE"
    condition {
      tag_state  = "ANY"
      older_than = "2592000s" # 30 days
    }
  }

  # Wins over both DELETE rules: an artifact matched by a DELETE and a KEEP is
  # kept. Five is enough to roll back a bad week without a rebuild.
  #
  # Why this rule is not optional: Cloud Run pulls the image on every COLD
  # START. Delete the digest a serving revision points at and the service
  # keeps working only until it next scales from zero. Because every deploy
  # pushes a new image, the serving one is always among the newest five —
  # unless you roll traffic back to a revision older than that, in which case
  # redeploy (rebuild) instead of shifting traffic.
  cleanup_policies {
    id     = "keep-5-most-recent"
    action = "KEEP"
    most_recent_versions {
      keep_count = 5
    }
  }

  # Vulnerability scanning is $0.26 PER PUSHED DIGEST once the Container
  # Scanning API is on in the project, and every deploy pushes a new digest.
  # At a deploy a day that is ~$8/month (~₹750) — eight times this stack's
  # whole target. DISABLED here; INHERITED would follow the project setting
  # (which PerfStaq controls). Scan on demand before a release if wanted.
  vulnerability_scanning_config {
    enablement_config = "DISABLED"
  }

  depends_on = [google_project_service.this]
}
