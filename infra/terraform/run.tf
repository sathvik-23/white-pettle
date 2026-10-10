# ════════════════════════════════════════════════════════════════════════════
#  The Cloud Run service — the whole of White Petal's compute.
#
#  Scales to ZERO, request-based billing. Unlike PerfStaq's worker (min 1,
#  CPU always on, ≈ ₹4,400 of PerfStaq's ≈ ₹5,500/month), nothing here runs
#  between requests: the hourly cron is an HTTP request from Cloud Scheduler,
#  so even scheduled work wakes the service rather than keeping it awake.
#
#  What it does NOT have, each on purpose:
#    - no VPC egress / connector / NAT: the database is reached through the
#      Cloud SQL socket volume over perfstaq-pg's public IP (Auth Proxy, TLS,
#      IAM-checked), and every other call is to the public internet anyway;
#    - no load balancer: the run.app URL, or a free domain mapping;
#    - no secret_key_ref env: the app loads secrets itself (see secrets.tf).
# ════════════════════════════════════════════════════════════════════════════

# Its own identity, not PerfStaq's `perfstaq-runtime`. That account can read
# every PerfStaq secret; White Petal's can read only the WHITEPETAL_* ones.
resource "google_service_account" "runtime" {
  account_id   = "whitepetal-runtime"
  display_name = "White Petal Cloud Run runtime"
}

# Cloud SQL Client is what the /cloudsql socket (the built-in Auth Proxy)
# checks. Project-level because Cloud SQL has no per-instance IAM; the only
# instance in the project is the shared one anyway, and the database
# password is still required on top.
#
# cloudsql.instanceUser is NOT granted: that is for IAM database
# authentication, and this user is a password (BUILT_IN) user.
resource "google_project_iam_member" "runtime_sql" {
  project = var.project_id
  role    = "roles/cloudsql.client"
  member  = "serviceAccount:${google_service_account.runtime.email}"
}

locals {
  # The address the app should treat as canonical (OAuth redirect URIs,
  # links in emails/Slack).
  #
  # With no custom domain this is Cloud Run's DETERMINISTIC URL,
  # https://<service>-<project-number>.<region>.run.app, which is known before
  # the service exists. Using `google_cloud_run_v2_service.whitepetal.uri`
  # here instead would be a cycle (the service referencing its own output),
  # and Terraform refuses it. The service also answers on a second, hashed
  # *.a.run.app hostname; the app falls back to the request Host header, so
  # either works for browsing — this value is the one to register with OAuth.
  public_origin = var.domain != "" ? "https://${var.domain}" : "https://whitepetal-${data.google_project.this.number}.${var.region}.run.app"
}

resource "google_cloud_run_v2_service" "whitepetal" {
  name     = "whitepetal"
  location = var.region

  # Public WITHOUT an IAM binding. An organization policy (Domain Restricted
  # Sharing) refuses `allUsers` outright on this project, so the
  # roles/run.invoker approach cannot be applied here at all — this flag is
  # how every public PerfStaq service is reachable too.
  #
  # If it ever drifts back to IAM-enforced, every request gets a bare 403
  # while /api/health checks done WITH credentials still pass. The deploy job
  # checks unauthenticated reachability for exactly that reason.
  invoker_iam_disabled = true

  # Disposable by design (stateless; data is in Cloud SQL, which this stack
  # cannot delete — see database.tf).
  deletion_protection = false

  ingress = "INGRESS_TRAFFIC_ALL"

  template {
    service_account = google_service_account.runtime.email

    # GEN2 because of the database socket. Cloud Run's first-generation
    # environment can only reach Cloud SQL instances whose server CA mode is
    # the per-instance GOOGLE_MANAGED_INTERNAL_CA. That is Cloud SQL's
    # documented default, so gen1 would PROBABLY work today — but
    # perfstaq-pg's CA mode is not pinned in PerfStaq's Terraform, and a CA
    # rotation to the shared or customer-managed CA would then cut White
    # Petal off from its database with no change on this side. Gen2 works
    # under every CA mode, at the same price; its one constraint — at least
    # 512 MiB of memory — is exactly what we set. (Check the current mode:
    # gcloud sql instances describe perfstaq-pg --format='value(settings.ipConfiguration.serverCaMode)')
    execution_environment = "EXECUTION_ENVIRONMENT_GEN2"

    # The cron tick runs brand checks INSIDE the request and may take ~30
    # minutes; Cloud Scheduler's ceiling for HTTP targets is 30 min, so it
    # gives up first. 3600 s (Cloud Run's maximum) leaves room for long SSE
    # agent runs from the browser too. A timeout costs nothing until used.
    timeout = "3600s"

    # Request-based billing charges per INSTANCE-second while ≥1 request is
    # in flight, not per request — so packing 40 mostly-I/O-waiting requests
    # (LLM streams, page fetches) into one instance is up to 40× cheaper than
    # concurrency 1. Node handles this on one thread fine; CPU-bound work is
    # not what this app does.
    max_instance_request_concurrency = 40

    scaling {
      # ZERO: an idle White Petal costs nothing. The price is a cold start
      # (~1–2 s for a Node image this small, softened by startup_cpu_boost).
      min_instance_count = 0

      # The spend ceiling. Also the DB connection ceiling: perfstaq-pg is a
      # db-f1-micro with max_connections = 25, SHARED with PerfStaq. Keep
      # (max_instances × the app's pg pool size) ≤ ~6–9. With the default of
      # 3 the app's pool should be max 2–3 per instance.
      max_instance_count = var.max_instances
    }

    # The shared Postgres, as a Unix socket at /cloudsql/<connection_name>.
    # Cloud Run runs the Cloud SQL Auth Proxy for us: TLS + IAM to the
    # instance's public IP, no VPC, no connector, no NAT, no IP allowlist.
    volumes {
      name = "cloudsql"
      cloud_sql_instance {
        instances = [data.google_sql_database_instance.shared.connection_name]
      }
    }

    containers {
      image = var.image

      resources {
        limits = {
          cpu    = "1"
          memory = "512Mi"
        }

        # REQUEST-BASED BILLING. CPU is allocated only while a request is
        # being handled, and billed only then. The single biggest cost lever
        # in this file: the same instance with cpu_idle = false (PerfStaq's
        # worker) is billed for every second it exists.
        #
        # The catch, and the contract for the app: work done AFTER the
        # response ends is throttled to near zero. The cron tick must do its
        # work before it responds, not fire-and-forget.
        cpu_idle = true

        # Extra CPU during startup only (billed only for those seconds):
        # shortens the cold start that scale-to-zero buys, and the app's
        # boot-time migrations + secret loading with it.
        startup_cpu_boost = true
      }

      volume_mounts {
        name       = "cloudsql"
        mount_path = "/cloudsql"
      }

      ports {
        container_port = 8080
      }

      env {
        name  = "NODE_ENV"
        value = "production"
      }

      # The app reads WHITEPETAL_<NAME> from Secret Manager at boot, via the
      # metadata-server token of the runtime account above.
      env {
        name  = "SECRETS_FROM_GSM"
        value = "1"
      }

      env {
        name  = "GCP_PROJECT"
        value = var.project_id
      }

      env {
        name  = "PUBLIC_ORIGIN"
        value = local.public_origin
      }

      env {
        name  = "PLATFORM_OPERATORS"
        value = var.platform_operators
      }

      env {
        name  = "EMAIL_FROM"
        value = var.email_from
      }

      # Paid plans. Off unless billing_enabled says otherwise; the Razorpay
      # keys themselves are secrets (secrets.tf), the plan ids are not.
      env {
        name  = "BILLING_ENABLED"
        value = var.billing_enabled
      }

      dynamic "env" {
        for_each = { for k, v in var.razorpay_plan_ids : k => v if v != "" }
        content {
          name  = "RAZORPAY_PLAN_${env.key}"
          value = env.value
        }
      }

      # No PORT: Cloud Run reserves it, injects 8080, and rejects a service
      # that sets it.

      # Boot = load secrets + run migrations under an advisory lock + listen.
      # /api/health answers 200 even when the database is down ({db:false}),
      # so a Postgres blip during a deploy does not fail the revision — the
      # deploy job checks `ok:true` separately. 5 s × 24 = two minutes of
      # grace, generous because a cold db-f1-micro can be slow to answer the
      # first migration query.
      startup_probe {
        http_get {
          path = "/api/health"
        }
        initial_delay_seconds = 0
        period_seconds        = 5
        timeout_seconds       = 4
        failure_threshold     = 24
      }
    }
  }

  lifecycle {
    # The image tag is owned by the deploy workflow, not by Terraform. Without
    # this, every `terraform apply` would roll production back to var.image —
    # Google's hello page.
    #
    # The other four are what `gcloud run services update` writes on every
    # deploy and would otherwise show as drift on every plan: client and
    # client_version; a random `client.knative.dev/nonce` template label (how
    # gcloud forces a new revision); and, for `gcloud run deploy`, a generated
    # revision name. This stack sets no template labels and no revision name,
    # so ignoring them hides nothing Terraform owns.
    ignore_changes = [
      template[0].containers[0].image,
      template[0].labels,
      template[0].revision,
      client,
      client_version,
      # Service-level scaling (not template.scaling, which this stack sets):
      # `gcloud run services update` writes manual_instance_count = 0 and
      # min_instance_count = 0 here. Without this, every apply after a deploy
      # "updates" the service, which rolls a new revision of whatever image is
      # current — and if that image is broken, the apply fails before
      # bootstrap.sh can build the fixed one.
      scaling,
    ]
  }

  # The IAM grant must exist before the first revision boots, or the app's
  # first secret read is a 403 and it starts with no database URL. The
  # DATABASE_URL version must exist too (the provider keys may not; that is
  # fine — see secrets.tf).
  depends_on = [
    google_project_service.this,
    google_project_iam_member.runtime_sql,
    google_secret_manager_secret_iam_member.runtime,
    google_secret_manager_secret_version.database_url,
    google_secret_manager_secret_version.app_secret,
    google_secret_manager_secret_version.cron_secret,
  ]
}

# ── Custom domain (optional, free) ──────────────────────────────────────────
# Only when var.domain is set. A domain mapping costs nothing; the HTTPS load
# balancer alternative is ~$18/month for its forwarding rule alone.
#
# After apply, add the DNS records from the `domain_dns_records` output at the
# registrar (for a subdomain: one CNAME to ghs.googlehosted.com.). Google
# issues the certificate once DNS resolves, retrying for up to ~24 h; the
# mapping shows "Certificate pending" until then, which is normal.
resource "google_cloud_run_domain_mapping" "custom" {
  count = var.domain == "" ? 0 : 1

  name     = var.domain
  location = var.region

  metadata {
    namespace = var.project_id
  }

  spec {
    route_name = google_cloud_run_v2_service.whitepetal.name
  }
}
