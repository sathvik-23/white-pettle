# PerfStaq — GCP cost review

*Reviewed: PerfStaq's `infra/terraform/*.tf`, `.github/workflows/ci.yml`,
`Dockerfile` and `infra/cloudbuild.yaml` (reference copy, 8 October 2026).
Every price was looked up the same day (sources at the end). Every Terraform
snippet below was validated against google provider **6.50.0**, the version
PerfStaq's lock file pins. **No PerfStaq file was changed.** These are
proposals, to apply in PerfStaq's own repo.*

**Currency.** Google bills this account in INR from its own price list. The
founder's observed figure of **≈ ₹4,400/month for the worker** matches its
list price ($52.60) at **≈ ₹84/US$**, so every ₹ figure in this review uses ₹84
to stay consistent with the real invoice. At today's market rate (₹96.8) each
figure would be about 15% higher. The savings ranking doesn't change.

---

## 1. Where the ₹5,500 goes

| # | Line item (from the Terraform) | How it bills | US$/month | ₹/month |
|---|---|---|---|---|
| 1 | **Worker**: `perfstaq-worker`, min 1 / max 1, 1 vCPU / 2 GiB, `cpu_idle = false` | Instance-based: CPU $0.000018/vCPU-s and memory $0.000002/GiB-s for all 2.63 M seconds of the month, less the 240k vCPU-s + 450k GiB-s free tier | **52.60** | **≈ 4,420** |
| 2 | **Cloud SQL** `perfstaq-pg`: db-f1-micro, 10 GB SSD, 7 daily backups | $0.0105/h + $0.17/GB-month SSD + ~1.5 GB backups. Public IPv4 is charged only while the instance is *idle* (stopped) | 9.49 | ≈ 800 |
| 3 | **Redis VM** `perfstaq-redis`: e2-micro, 30 GB pd-standard, **external IP** | VM and disk are always-free (one e2-micro per billing account). The in-use external IPv4 is $0.005/h | 3.65 | ≈ 305 |
| 4 | **Artifact Registry** `perfstaq` | $0.10/GB-month over 0.5 GB. **The cleanup policy deletes nothing** (§3.H), so this only grows | ~1–4 and rising | ≈ 100–350 |
| 5 | **Secret Manager**: ~22 secrets, ~30 active versions | $0.06/version/month past 6 free | ~1.4 | ≈ 120 |
| 6 | **Request-based services**: api, web, ai, admin, clipcut (all min 0) | Mostly inside the 180k vCPU-s / 360k GiB-s free tier, which is **shared with White Petal** | 0–2 | ≈ 0–150 |
| 7 | **Internet egress**: worker uploads to R2, provider calls | 1 GiB free, then $0.12/GiB. Unmeasured; see §3.N | 0–5 | ≈ 0–400 |
| 8 | **GCS** `…-clipcut-state`, versioned | $0.02/GB-month **plus every noncurrent version, forever** | small | ≈ 0–100 |
| 9 | **Cloud Logging** | 50 GiB/project free | 0 | 0 |
| 10 | VPC, firewall, private services access, WIF, IAM, budget | free | 0 | 0 |
| | **Modelled total** | | **≈ $68–80** | **≈ ₹5,700–6,700** (founder's observed ≈ ₹5,500) |

The worker is **≈ 80%** of the bill. Everything else together is a rounding
error next to it, so the review is mostly about the worker.

---

## 2. The savings, ranked

**Before** is today's cost. **After** is the cost with the change. The four
worker options **A–D are alternatives**: pick one. E is a quick first step
that is superseded by A, B or C.

| Rank | Change | Before ₹ | After ₹ | **Saves ₹/mo** | Effort | Risk |
|---|---|---|---|---|---|---|
| 0 | **Fix the budget's credit treatment.** It cannot fire during the trial (§3.0) | — | — | 0 (protects the ₹25,000 credit) | 5 min | none |
| 0 | **Check whether container scanning is on** (§3.I) | 0–3,900 | 0 | **0–3,900** | 5 min | none |
| 1 | **D. Port BullMQ to Cloud Tasks.** The worker becomes a scale-to-zero service and the Redis VM goes away | 4,420 + 305 | ≈ 0–250 | **≈ 4,450–4,700** | weeks | high |
| 2 | **C. Worker on a Spot e2-small VM** (MIG of 1, COS) next to Redis | 4,420 | ≈ 805 | **≈ 3,600** | 1–2 days | medium-high |
| 3 | **B. Worker as a GKE Autopilot Spot pod**, 1 vCPU / 1 GiB, cluster fee covered by the free-tier credit | 4,420 | ≈ 915 | **≈ 3,500** | 1–2 days | medium |
| 4 | **A. Worker as a Cloud Run *worker pool***, 1 vCPU / 1 GiB | 4,420 | ≈ 2,315 | **≈ 2,100** (1,830 at 2 GiB) | ½ day | low-medium |
| 5 | **E. Worker memory 2 GiB → 1 GiB**, same service | 4,420 | ≈ 3,975 | **≈ 440** | 5 min | low (measure first) |
| 6 | **G. Remove the Redis VM's external IP** (COS + Artifact Registry + Private Google Access) | 305 | 0 | **≈ 305** | 2 h | low-medium |
| 7 | **H. A cleanup policy that deletes** + scanning off on `perfstaq` | 100–350, growing | ≈ 40 | **≈ 60–310**, and stops the growth | 15 min | low |
| 8 | **J. Lifecycle on the ClipCut bucket** (noncurrent versions) | ? | ? | **0–100** (measure) | 10 min | low |
| 9 | **K. Prune superseded secret versions** | ≈ 120 | ≈ 50 | **≈ 50–70** | 10 min | low |
| 10 | **F. Cloud Run CUD**, 1 year | 4,420 | ≈ 3,600 | ≈ 830 | — | **not recommended** |
| — | **L. Cloud SQL** tier/edition/backups | 800 | 800 | 0. It's already at the floor; add a disk cap (§3.L) | 5 min | none |
| — | **M. Log exclusions** | 0 | 0 | 0 until 50 GiB; a guardrail | 10 min | none |
| — | **N. Budget kill switch** (Pub/Sub → function) | — | — | 0; caps the tail | ½ day | medium |

### Totals

| Package | Items | PerfStaq/month | Saving |
|---|---|---|---|
| Today | — | **≈ ₹5,500** | — |
| **Recommended now** | 0, A (1 GiB), G, H, K | **≈ ₹2,800** | **≈ ₹2,700 (−49%)** |
| Aggressive | 0, B or C, G, H, K | **≈ ₹1,400** | **≈ ₹4,100 (−74%)** |
| End state | 0, D, H, K (Redis gone) | **≈ ₹1,000–1,200** | **≈ ₹4,300–4,500 (−80%)** |

At ₹2,800 a month, the remaining trial credit lasts about twice as long.

**Not possible:** "worker to 0.5 vCPU". On a Cloud Run *service*, CPU below 1
requires **request-based billing, concurrency 1 and the gen1 environment**, and
more than 1 GiB of memory requires a full vCPU. The worker needs CPU that is
always on (`cpu_idle = false`), so fractional CPU is ruled out. The
right-sizing that *is* available is memory (E), or a platform with cheaper
always-on CPU (A, B, C).

---

## 3. The changes, with Terraform

### 0. The budget never fires during the trial (free; do it first)

`budget.tf` leaves `credit_types_treatment` at its default,
`INCLUDE_ALL_CREDITS`. That subtracts **every** credit from spend, and the
Google Cloud Free Trial credit *is* a credit (type `PROMOTION`). For as long as
the ₹25,000 lasts, the budget sees ≈ ₹0. Its 50/80/100% alerts can't fire
while the credit they are meant to protect is being spent. The first alert
will come after the credit is gone.

```diff
 # infra/terraform/budget.tf
   budget_filter {
     projects = ["projects/${data.google_project.this.number}"]
+
+    # Measure spend GROSS of the Free Trial credit (type PROMOTION). Subtract
+    # only credits that are permanent savings, so the alarm tracks the burn.
+    credit_types_treatment = "INCLUDE_SPECIFIED_CREDITS"
+    credit_types = [
+      "FREE_TIER", "SUSTAINED_USAGE_DISCOUNT", "COMMITTED_USAGE_DISCOUNT",
+      "COMMITTED_USAGE_DISCOUNT_DOLLAR_BASE", "DISCOUNT", "FEE_UTILIZATION_OFFSET",
+    ]
   }
@@
   threshold_rules {
     threshold_percent = 1.0
   }
+
+  # Fires mid-month when the TREND crosses 100%, days before actual spend does.
+  threshold_rules {
+    threshold_percent = 1.0
+    spend_basis       = "FORECASTED_SPEND"
+  }
```

Also lower `budget_amount_inr` from 20000 to **8000**. A ₹20,000 monthly
alarm on a ₹5,500 estate fires at 50% only once spend has nearly doubled.

### A. Worker → Cloud Run worker pool (recommended now)

Worker pools are Cloud Run's resource for **pull-based** workloads like a
BullMQ consumer. There is no HTTP endpoint, no request routing and no
min-instance workaround, and CPU is priced well below a service's
instance-based rate:

| | CPU / vCPU-s | Memory / GiB-s | Free tier / month |
|---|---|---|---|
| Service, instance-based (today) | $0.000018 | $0.000002 | 240,000 vCPU-s, 450,000 GiB-s |
| **Worker pool** | **$0.000011244** | **$0.000001235** | **384,204 vCPU-s, 728,744 GiB-s** |

Cost for 1 vCPU for the whole month: 2 GiB is **$30.82 (≈ ₹2,590)** and
1 GiB is **$27.58 (≈ ₹2,315)**, against $52.60 today.

```hcl
# infra/terraform/run.tf — replaces google_cloud_run_v2_service.worker
resource "google_cloud_run_v2_worker_pool" "worker" {
  name                = "perfstaq-worker-pool"
  location            = var.region
  deletion_protection = false
  # If the apply rejects the resource as pre-GA on your provider, add:
  # launch_stage = "BETA"

  # Exactly one consumer, as today ("a second consumer would double-process").
  # MANUAL scaling is how a pool holds a fixed count; 0 parks it at no cost.
  scaling {
    scaling_mode          = "MANUAL"
    manual_instance_count = 1
  }

  template {
    service_account = google_service_account.runtime.email

    vpc_access {
      network_interfaces {
        network    = google_compute_network.main.id
        subnetwork = google_compute_subnetwork.run_egress.id
      }
      egress = "PRIVATE_RANGES_ONLY"
    }

    containers {
      image = "us-docker.pkg.dev/cloudrun/container/worker-pool"

      resources {
        # 1 GiB: see E — measure the worker's peak before halving it.
        limits = { cpu = "1", memory = "1Gi" }
      }

      dynamic "env" {
        for_each = merge(local.common_env, local.release_flags, local.worker_drivers, {
          VIDEO_PROCESSOR = "ffmpeg"
          AI_DRIVER       = "service"
          AI_SERVICE_URL  = google_cloud_run_v2_service.ai.uri
        })
        content {
          name  = env.key
          value = env.value
        }
      }

      dynamic "env" {
        for_each = toset(concat([
          "DATABASE_URL", "REDIS_URL", "BETTER_AUTH_SECRET", "AI_SERVICE_TOKEN",
          "STORAGE_ACCESS_KEY_ID", "STORAGE_SECRET_ACCESS_KEY",
          "OPENAI_API_KEY", "RUNWAY_API_SECRET", "ELEVENLABS_API_KEY",
          "HIGGSFIELD_KEY_ID", "HIGGSFIELD_KEY_SECRET",
        ], local.posthog_secrets))
        content {
          name = env.value
          value_source {
            secret_key_ref {
              secret  = env.value
              version = "latest"
            }
          }
        }
      }
    }
  }

  lifecycle {
    ignore_changes = [template[0].containers[0].image, client, client_version]
  }

  depends_on = [
    google_secret_manager_secret_iam_member.runtime_access,
    google_secret_manager_secret_version.database_url,
    google_secret_manager_secret_version.redis_url,
  ]
}
```

```diff
 # .github/workflows/ci.yml — Deploy services
-          for svc in api worker web; do
+          for svc in api web; do
             ...
           done
+          gcloud run worker-pools update perfstaq-worker-pool \
+            --region=$REGION --image=$REGISTRY/worker:$SHA
```

**Cutover.** First apply the pool with `manual_instance_count = 0`, then
deploy the worker image to it once. In a **single** apply, delete the
`google_cloud_run_v2_service.worker` block and set the count to 1. The queue
lives in Redis, so the few seconds with no consumer lose nothing. Also remove
`worker` from the "Verify public reachability" loop, because a pool has no URL.

**Risk.** The worker's `WORKER_HEALTH_PORT` server becomes unused, which is
harmless. Make sure no external monitor polls the worker's URL. Roll back by
restoring the service block.

### B. Worker → GKE Autopilot Spot pod ("Kubernetes where it pays")

This is the place the founder's Kubernetes instinct is right. An always-on
consumer needs no load balancer, Autopilot doesn't bill system pods, and the
**$74.40/month GKE free-tier credit covers one Autopilot cluster's $73
management fee**. A Spot pod is $0.0133/vCPU-h and $0.0014767/GiB-h. At
1 vCPU / 1 GiB that's **$10.89 (≈ ₹915)**. At 2 GiB it's $11.97 (≈ ₹1,005).

```hcl
# infra/terraform/gke.tf (new)
resource "google_container_cluster" "workers" {
  name                = "perfstaq-workers"
  location            = var.region # Autopilot is regional; still covered by the free-tier credit
  enable_autopilot    = true
  network             = google_compute_network.main.id
  subnetwork          = google_compute_subnetwork.main.id # VPC-native; reaches Redis + SQL private IP
  deletion_protection = false

  # Secrets straight from Secret Manager (CSI), no copies in k8s Secrets.
  secret_manager_config {
    enabled = true
  }
}
```

```yaml
# k8s/worker.yaml (sketch). CI: kubectl set image deploy/worker worker=$REGISTRY/worker:$SHA
apiVersion: apps/v1
kind: Deployment
metadata: { name: worker }
spec:
  replicas: 1
  strategy: { type: Recreate }            # never two consumers at once
  selector: { matchLabels: { app: worker } }
  template:
    metadata: { labels: { app: worker } }
    spec:
      nodeSelector: { cloud.google.com/gke-spot: "true" }
      terminationGracePeriodSeconds: 25    # Spot gives ~30 s notice; BullMQ closes cleanly
      serviceAccountName: worker           # Workload Identity → perfstaq-runtime
      containers:
        - name: worker
          image: us-central1-docker.pkg.dev/global-bridge-508618-u6/perfstaq/worker:latest
          resources:
            requests: { cpu: "1", memory: 1Gi }
            limits:   { cpu: "1", memory: 1Gi }
```

**Risk.** A Spot pod can be preempted at any time. Autopilot reschedules it
within minutes, and BullMQ marks the in-flight job stalled and retries it. That
is safe **only because** ADR-004 keeps the durable truth in Postgres step rows.
Check that every step is idempotent before choosing this. Also note: the free
credit covers **one** zonal or Autopilot cluster per billing account. A second
cluster costs $73/month (₹6,130) and turns this saving into a loss.

### C. Worker → Spot e2-small VM next to Redis

Current E2 Spot rates in us-central1, derived from the listed Spot prices of
e2-highcpu-2 and e2-standard-2, are about $0.0131/vCPU-h and $0.00175/GB-h.
An e2-small (0.5 vCPU, 2 GB) comes to about **$0.0100/h = $7.34**. Add a Spot
external IP ($0.0025/h = $1.83) and 10 GB of pd-standard ($0.40), and the total
is **≈ $9.57 (≈ ₹805)**.

```hcl
resource "google_compute_instance_template" "worker" {
  name_prefix  = "perfstaq-worker-"
  machine_type = "e2-small"
  disk {
    source_image = "cos-cloud/cos-stable"
    disk_size_gb = 10
    disk_type    = "pd-standard"
    boot         = true
  }
  network_interface {
    subnetwork = google_compute_subnetwork.main.id
    access_config {} # the worker calls OpenAI, R2 and providers; Spot IP is $0.0025/h
  }
  scheduling {
    provisioning_model          = "SPOT"
    preemptible                 = true
    automatic_restart           = false
    instance_termination_action = "STOP"
  }
  service_account {
    email  = google_service_account.runtime.email
    scopes = ["cloud-platform"]
  }
  metadata = { user-data = file("${path.module}/worker.cloud-init.yaml") } # docker run the worker image
  lifecycle { create_before_destroy = true }
}

resource "google_compute_instance_group_manager" "worker" {
  name               = "perfstaq-worker"
  zone               = var.zone
  base_instance_name = "perfstaq-worker"
  target_size        = 1 # the MIG recreates a preempted VM
  version { instance_template = google_compute_instance_template.worker.id }
}
```

**Risk.** It has the same preemption semantics as B, plus things B handles for
you: OS images, the deploy path (a MIG rolling replace per release), logging
agent setup, and a sustained CPU of **0.5 vCPU** (e2-small) instead of 1. B
gives the same saving with less to run. Pick C only to avoid adding Kubernetes.

### D. Port BullMQ to Cloud Tasks (end state)

Each job becomes an HTTP task, pushed to a request-based Cloud Run service
that scales to zero. Cloud Tasks gives **1 M operations free per month**, then
$0.40/M. Handlers may run **up to 30 minutes** per attempt. The worker then
costs only the seconds it actually works, which is mostly inside the free tier.
The Redis VM, its IP, the firewall rule and the Direct VPC egress for Redis can
all be deleted.

This saves **≈ ₹4,450–4,700/month**. It is the CLAUDE.md "never long-running
work in a web request" rule implemented properly: Tasks retries and
rate-limits, and each step stays a short request. The cost is weeks of work.
ADR-004's workflow engine, every step's idempotency, and long provider polls
(video generation) must be reshaped into resumable steps of 30 minutes or less.
Do A or B now and plan D for when the workflow code is next touched.

### E. Worker memory 2 GiB → 1 GiB (same service)

```diff
 # infra/terraform/run.tf — google_cloud_run_v2_service.worker
       resources {
-        limits = { cpu = "1", memory = "2Gi" }
+        limits = { cpu = "1", memory = "1Gi" }
         cpu_idle = false
       }
```

This saves 1 GiB × 2.63 M s × $0.000002 = **$5.26 (≈ ₹440)**. Check first: in
Metrics Explorer, look at `run.googleapis.com/container/memory/utilizations`
for `perfstaq-worker` over 7 days. If p99 is under 60% of 2 GiB, 1 GiB is
safe. The static ffmpeg muxes are the peak to watch.

### G. Redis without an external IP

The IP exists only so `apt-get install redis-server` can reach Debian
mirrors. Container-Optimized OS pulls a Redis image from Artifact Registry
through **Private Google Access** instead, so the VM needs no route to the
internet. That saves **$3.65 (≈ ₹305)**, and the VM is no longer reachable
from the internet at all.

On costs, `data.tf` says Cloud NAT "would avoid it at ~$32/mo". For one VM,
Cloud NAT is actually $0.0014/h for the gateway plus $0.005/h for its IP, about
$4.67/month plus $0.045/GiB processed. That is still more than the bare IP, so
the decision held, but the reasoning overstated the alternative by about 7×.

```diff
 # infra/terraform/data.tf
 resource "google_compute_subnetwork" "main" {
   name          = "perfstaq-${var.region}"
   network       = google_compute_network.main.id
   region        = var.region
   ip_cidr_range = "10.10.0.0/24"
+  # Google APIs (Artifact Registry) over Google's network, no external IP.
+  private_ip_google_access = true
 }
+
+# Pin Redis's address: rebuilding the VM (image change below) would otherwise
+# give it a new IP, and REDIS_URL would change under the running services.
+resource "google_compute_address" "redis_internal" {
+  name         = "perfstaq-redis-internal"
+  region       = var.region
+  subnetwork   = google_compute_subnetwork.main.id
+  address_type = "INTERNAL"
+  address      = "10.10.0.10"
+}
+
+# Pull-through cache of Docker Hub, so the VM pulls redis from inside Google.
+resource "google_artifact_registry_repository" "dockerhub" {
+  repository_id = "dockerhub"
+  location      = var.region
+  format        = "DOCKER"
+  mode          = "REMOTE_REPOSITORY"
+  remote_repository_config {
+    description = "Docker Hub pull-through"
+    docker_repository {
+      public_repository = "DOCKER_HUB"
+    }
+  }
+}
+
+resource "google_artifact_registry_repository_iam_member" "redis_pull" {
+  location   = google_artifact_registry_repository.dockerhub.location
+  repository = google_artifact_registry_repository.dockerhub.name
+  role       = "roles/artifactregistry.reader"
+  member     = "serviceAccount:${google_service_account.redis_vm.email}"
+}

 resource "google_compute_instance" "redis" {
   ...
   boot_disk {
     initialize_params {
-      image = "debian-cloud/debian-12"
+      image = "cos-cloud/cos-stable" # still free: e2-micro + 30 GB pd-standard
       size  = 30
       type  = "pd-standard"
     }
   }

   network_interface {
     network    = google_compute_network.main.id
     subnetwork = google_compute_subnetwork.main.id
-    access_config {}
+    network_ip = google_compute_address.redis_internal.address
+    # No access_config: no external IP. SSH still works through IAP.
   }

-  metadata_startup_script = <<-EOT
-    ...apt-get install redis-server...
-  EOT
+  metadata = {
+    user-data = <<-EOT
+      #cloud-config
+      write_files:
+      - path: /etc/systemd/system/redis.service
+        permissions: "0644"
+        owner: root
+        content: |
+          [Unit]
+          Description=Redis for BullMQ
+          Wants=gcr-online.target
+          After=gcr-online.target
+          [Service]
+          Environment=HOME=/home/redis
+          ExecStartPre=/usr/bin/docker-credential-gcr configure-docker --registries ${var.region}-docker.pkg.dev
+          ExecStart=/usr/bin/docker run --rm --name redis -p 6379:6379 ${var.region}-docker.pkg.dev/${var.project_id}/dockerhub/library/redis:7.4-alpine redis-server --protected-mode no --maxmemory-policy noeviction
+          ExecStop=/usr/bin/docker stop redis
+          Restart=always
+      runcmd:
+      - systemctl daemon-reload
+      - systemctl start redis.service
+    EOT
+  }
```

**Risk.** The VM is replaced, so the queue empties. That is acceptable by the
ADR ("work to do, never durable truth"), but do it at a quiet hour. The pinned
IP keeps `REDIS_URL` stable. Verify the COS unit from the serial console on the
first boot.

### H. Artifact Registry: a cleanup policy that actually deletes

`run.tf` has one `KEEP` policy and no `DELETE` policy. Keep rules only rescue
artifacts that a delete rule matched, so **this repository has never deleted
anything**. Each deploy pushes api, worker and web, and ClipCut and Torch
layers run to gigabytes. Check the size with
`gcloud artifacts repositories describe perfstaq --location=us-central1`.

```diff
 resource "google_artifact_registry_repository" "images" {
   repository_id = "perfstaq"
   location      = var.region
   format        = "DOCKER"

+  # Start in dry run for a week; check the cleanup audit logs; then false.
+  cleanup_policy_dry_run = true
+
+  cleanup_policies {
+    id     = "delete-untagged-7d"
+    action = "DELETE"
+    condition {
+      tag_state  = "UNTAGGED"
+      older_than = "604800s"
+    }
+  }
+
+  cleanup_policies {
+    id     = "delete-older-than-30d"
+    action = "DELETE"
+    condition {
+      tag_state  = "ANY"
+      older_than = "2592000s"
+    }
+  }
+
   cleanup_policies {
     id     = "keep-recent"
     action = "KEEP"
     most_recent_versions {
       keep_count = 10   # per package: api, worker, web, admin, clipcut
     }
   }
+
+  vulnerability_scanning_config {
+    enablement_config = "DISABLED" # see I
+  }
 }
```

The retired ClipCut service still points at its last image. `keep_count = 10`
per package keeps it, because nothing new is pushed to `clipcut`. Never let a
serving revision's digest be deleted: Cloud Run pulls it again on every cold
start.

### I. Container scanning: check today

When `containerscanning.googleapis.com` is enabled, every pushed digest is
scanned **automatically at $0.26**. CI pushes three new digests per deploy,
which is **$0.78 (≈ ₹65) per deploy, or ≈ ₹3,900/month at two deploys a day**.

```bash
gcloud services list --enabled --filter=name:containerscanning.googleapis.com
```

If that prints a line, the repository-level `enablement_config = "DISABLED"`
in H stops it. Scan on demand before a release if you want the report.

### J. ClipCut bucket: stop keeping every overwritten file forever

`versioning { enabled = true }` with no lifecycle rule keeps every
overwritten or deleted render as a billed noncurrent object, indefinitely.
Measure it with `gcloud storage du -s gs://global-bridge-508618-u6-clipcut-state`.

```diff
 resource "google_storage_bucket" "clipcut_state" {
   ...
   versioning {
     enabled = true
   }
+
+  # Versioning is for undoing a bad `rm` this week, not an archive.
+  lifecycle_rule {
+    condition {
+      days_since_noncurrent_time = 7
+      with_state                 = "ARCHIVED"
+    }
+    action {
+      type = "Delete"
+    }
+  }
 }
```

### K. Secret Manager: destroy superseded versions

Billing is per **active** version, and a disabled version is still active.
Every sync that adds a version without destroying the old one adds
$0.06/month for good.

```bash
for s in $(gcloud secrets list --format='value(name)'); do
  latest=$(gcloud secrets versions list "$s" --filter='state=ENABLED' --sort-by=~createTime --limit=1 --format='value(name)')
  for v in $(gcloud secrets versions list "$s" --filter='state!=DESTROYED' --format='value(name)'); do
    [ "$v" = "$latest" ] || gcloud secrets versions destroy "$v" --secret="$s" --quiet
  done
done
```

Note that Terraform manages the `DATABASE_URL`, `DATABASE_OWNER_URL` and
`REDIS_URL` versions. The loop never destroys the latest version, which is the
one Terraform manages.

### L. Cloud SQL: already at the floor; add one guardrail

db-f1-micro on ENTERPRISE, zonal, 10 GB, is the cheapest Postgres Cloud SQL
sells, and `edition = "ENTERPRISE"` is correctly pinned (Enterprise Plus has
no shared core). Don't add HA, which doubles the price to $0.021/h. Don't add
read replicas. The one cost risk is `disk_autoresize` with no ceiling:
storage can only grow, and a runaway log table ratchets the bill up
permanently.

```diff
     disk_size         = 10
     disk_autoresize   = true
+    # Autoresize can never shrink. Cap it; raise the cap on purpose.
+    disk_autoresize_limit = 25
```

This instance now also carries White Petal (database `whitepetal`). Its 25
connection slots are shared, so keep each service's pool small. postgres.js
defaults to 10 per instance, and api ×2 + worker + admin can already reach 40.
Set `max: 3–5` in `packages/db`.

### M. Log exclusions (a guardrail; ₹0 until 50 GiB)

```hcl
resource "google_logging_project_exclusion" "web_static" {
  name   = "perfstaq-web-static-2xx"
  filter = "resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"perfstaq-web\" AND logName=\"projects/${var.project_id}/logs/run.googleapis.com%2Frequests\" AND httpRequest.status<400 AND httpRequest.requestUrl:\"/_next/static/\""
}
```

### N. Budget kill switch (Pub/Sub → function)

A budget only notifies. To *act*, publish the budget to Pub/Sub and let a
small function park the worker when spend runs away. This adds ₹0: Pub/Sub
and Cloud Run functions free tiers cover a few messages an hour.

```hcl
resource "google_pubsub_topic" "budget" {
  name = "perfstaq-budget-alerts"
}

# in google_billing_budget.guard:
  all_updates_rule {
    pubsub_topic                   = google_pubsub_topic.budget.id
    schema_version                 = "1.0"
    disable_default_iam_recipients = false # keep the emails too
  }
```

```js
// functions/budget-guard/index.mjs (Cloud Run function, Pub/Sub trigger, Node 22)
// Budget messages arrive every ~20-30 min, so this must be idempotent.
// It parks the worker at 120% of budget, not at the first alert.
export async function budgetGuard(event) {
  const m = JSON.parse(Buffer.from(event.data.message.data, "base64").toString());
  if (m.costAmount < m.budgetAmount * 1.2) return;
  const tok = await (await fetch("http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token",
    { headers: { "Metadata-Flavor": "Google" } })).json();
  const url = "https://run.googleapis.com/v2/projects/global-bridge-508618-u6/locations/us-central1/workerPools/perfstaq-worker-pool?updateMask=scaling.manualInstanceCount";
  await fetch(url, { method: "PATCH", headers: { authorization: `Bearer ${tok.access_token}`, "content-type": "application/json" },
    body: JSON.stringify({ scaling: { manualInstanceCount: 0 } }) });
  console.log(`budget ${m.costAmount}/${m.budgetAmount} ${m.currencyCode}: worker parked`);
}
```

**Risk.** Parking the worker stops generation for every customer. That is the
point at 120% of budget, but agree on the threshold first. The function's
service account needs `roles/run.developer` on the pool only.

### F. Cloud Run committed use discount: not recommended

A 1-year Cloud Run CUD takes about 17% off the worker (≈ ₹830/month), and
Compute Flexible CUDs take 28–46%. But a commitment is a bet that the worker
stays shaped as it is for a year, and A, B and D each save more without one.
Commitment purchases also aren't the kind of spend the Free Trial is set up
for, so look again only after the account is on paid billing and the worker
has settled.

---

## 4. Not cost, but noticed

- **The deployer's grants are project-wide.** `roles/artifactregistry.writer`,
  `run.developer` and `cloudsql.client` are on the whole project. In a project
  that now also hosts White Petal, a leaked PerfStaq deploy token can delete
  White Petal's Cloud Run service or move its traffic, and can push over its
  images (`run.developer` includes delete). A new revision would still need
  `actAs` on White Petal's runtime account, which it lacks. White Petal's
  deployer is scoped to its own repository and service
  (`infra/terraform/github.tf` in the White Petal repo). The same scoping would
  suit PerfStaq.
- **`sql_authorized_networks = 0.0.0.0/0`** remains the single highest-value
  hardening, as `data.tf` itself says. White Petal reaches the instance only
  through the Cloud SQL Auth Proxy, so narrowing this changes nothing for it.

---

### Sources

- [Cloud Run pricing](https://cloud.google.com/run/pricing): instance-based, request-based and **worker pool** rates and free tiers; CUD prices
- [Cloud Run CPU limits](https://docs.cloud.google.com/run/docs/configuring/services/cpu): CPU below 1 needs request-based billing, concurrency 1, gen1
- [Worker pools: CPU](https://docs.cloud.google.com/run/docs/configuring/workerpools/cpu) · [manual scaling](https://docs.cloud.google.com/run/docs/configuring/workerpools/manual-scaling)
- [GKE pricing](https://cloud.google.com/kubernetes-engine/pricing): $0.10/h fee, $74.40 free-tier credit, Autopilot Spot pod rates
- [Spot VM pricing](https://cloud.google.com/spot-vms/pricing): E2 Spot rates in us-central1
- [Network pricing](https://cloud.google.com/vpc/network-pricing): external IPv4 $0.005/h (Spot $0.0025/h), Cloud NAT $0.0014/h per VM, egress
- [Cloud SQL pricing](https://cloud.google.com/sql/pricing)
- [Artifact Registry pricing](https://cloud.google.com/artifact-registry/pricing) · [cleanup policies](https://docs.cloud.google.com/artifact-registry/docs/repositories/cleanup-policy) · [Artifact Analysis pricing](https://cloud.google.com/artifact-analysis/pricing)
- [Secret Manager pricing](https://cloud.google.com/secret-manager/pricing)
- [Cloud Tasks pricing](https://cloud.google.com/tasks/pricing) · [HTTP target handler timeouts](https://docs.cloud.google.com/tasks/docs/creating-http-target-tasks)
- [Cloud Logging pricing](https://cloud.google.com/stackdriver/pricing)
- [Budget filter and credit types](https://docs.cloud.google.com/billing/docs/reference/budget/rest/v1/billingAccounts.budgets) · [credit type list (Free Trial = PROMOTION)](https://docs.cloud.google.com/billing/docs/how-to/export-data-bigquery-tables/detailed-usage)
