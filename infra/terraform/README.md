# White Petal — Terraform

White Petal runs on Google Cloud **inside PerfStaq's existing project**
(`global-bridge-508618-u6`, `us-central1`), sharing its Cloud SQL instance,
its Workload Identity pool, its state bucket and its trial credit. This stack
adds only what White Petal needs. It never modifies a PerfStaq resource.

```
GitHub (push to main) ──WIF──▶ whitepetal-deployer ──▶ Artifact Registry `whitepetal`
                                                   └─▶ Cloud Run `whitepetal` (image only)

Browser ──HTTPS──▶ Cloud Run `whitepetal`  (min 0, max 3, 1 vCPU / 512 MiB, request-based billing)
                     ├─ /cloudsql socket ──Auth Proxy (TLS, IAM)──▶ perfstaq-pg · database `whitepetal`
                     ├─ boot: reads WHITEPETAL_* from Secret Manager (runtime SA, per-secret grants)
                     └─ outbound HTTPS to OpenAI / Perplexity / Gemini / …  (no VPC, no NAT)

Cloud Scheduler (hourly) ──POST /api/cron/tick + x-cron-secret──▶ Cloud Run
```

## First run

From the repo root, on a machine with `gcloud`, `terraform` (≥ 1.5) and
optionally `gh` logged in:

```bash
infra/bootstrap.sh
```

It runs `terraform init && apply`, stores the provider keys from `.env.local`
(or prompts for them, input hidden), builds the first image with Cloud Build,
rolls it out, waits for `/api/health`, and sets the GitHub Actions variables.
It is safe to re-run. After it, every push to `main` deploys.

By hand, the Terraform part is just:

```bash
cd infra/terraform
terraform init
terraform apply                      # read the plan: it is PerfStaq's project
```

## What this stack creates

| File | Creates | Notes |
|---|---|---|
| `apis.tf` | project services | `disable_on_destroy = false` — a destroy must never switch off APIs PerfStaq uses |
| `database.tf` | database `whitepetal`, user `whitepetal_app` on **perfstaq-pg** | `deletion_policy = ABANDON`: a destroy never drops data |
| `secrets.tf` | 15 `WHITEPETAL_*` secret containers, per-secret accessor grants, versions for `DATABASE_URL`, `APP_SECRET`, `CRON_SECRET` | provider keys are added by hand (`infra/secrets.sh`) |
| `registry.tf` | Artifact Registry `whitepetal` | keeps 5 newest; deletes untagged > 7 d and anything else > 30 d; scanning off |
| `run.tf` | runtime SA, Cloud Run `whitepetal`, optional domain mapping | scale-to-zero, request-based billing, gen2, Cloud SQL socket volume |
| `scheduler.tf` | job `whitepetal-cron-tick` | hourly, 30-min deadline, no retries |
| `github.tf` | WIF provider `github-whitepetal` in the existing pool, `whitepetal-deployer` | every grant scoped to a White Petal resource |
| `budget.tf` | budget "whitepetal — infra guard" | label `app=whitepetal`, gross of the trial credit |
| `logging.tf` | log exclusion | drops successful static-asset request logs |
| `data.tf` | — | **reads** the project, perfstaq-pg and the WIF pool |

## Inputs

| Variable | Default | Change it when |
|---|---|---|
| `domain` | `""` | you want `whitepetal.perfstaq.com` — free domain mapping, no load balancer |
| `max_instances` | `3` | traffic grows — but read *Shared database* first |
| `cron_schedule` | `0 * * * *` | the app wants a different tick |
| `budget_amount_inr` | `500` | the alert is too noisy or too quiet |
| `image` | hello placeholder | only when re-creating a deleted service |

Put overrides in `terraform.tfvars` and **commit it** (it holds no secrets). A
value that lives on one laptop is reverted by the next apply from another —
for `domain`, that deletes the mapping.

## Custom domain

```hcl
# terraform.tfvars
domain = "whitepetal.perfstaq.com"
```

`terraform apply`, then create the record from `terraform output
domain_dns_records` at the registrar — for a subdomain, one `CNAME whitepetal →
ghs.googlehosted.com.`. The certificate is issued automatically once DNS
resolves. The domain must be verified in Search Console by the account running
Terraform (perfstaq.com already is). Then add the new origin to the Google
OAuth client.

Why not a load balancer: a global HTTPS LB's forwarding rule alone is
$0.025/h ≈ $18/month (~₹1,750). Domain mapping is free; its trade is Preview
status and somewhat higher latency.

## Keys

```bash
infra/secrets.sh                    # which keys are set (values never printed)
infra/secrets.sh OPENAI_API_KEY     # set or rotate (prompts, input hidden)
infra/secrets.sh SERPAPI_KEY --unset
```

The app reads `WHITEPETAL_<NAME>` at boot. A key with no version is skipped,
so a missing key turns one engine off and never stops the service booting
(unlike PerfStaq, where a mounted secret with no version blocks the revision).
`secrets.sh` rolls a new revision so the change takes effect immediately, and
destroys superseded versions because each active version is billed.

`DATABASE_URL`, `APP_SECRET` and `CRON_SECRET` are generated here. Rotate with:

```bash
terraform apply -replace=random_password.cron_secret   # also updates the Scheduler header
terraform apply -replace=random_password.app_secret    # NB: invalidates whatever APP_SECRET signs
terraform apply -replace=random_password.db_app        # new DB password + new DATABASE_URL
```

then roll a revision (`infra/secrets.sh` does this for its own keys; for these:
`gcloud run services update whitepetal --region us-central1 --image "$(gcloud run services describe whitepetal --region us-central1 --format='value(spec.template.spec.containers[0].image)')"`).

## Shared database — read before raising `max_instances`

perfstaq-pg is a **db-f1-micro**: shared-core, no SLA, and
`max_connections = 25` for **both** products. PerfStaq's own services already
hold pools. Keep `max_instances × (app pg pool max)` at or below ~6–9: with the
default of 3 instances the app's pool should be `max: 2–3`. If White Petal
ever needs more, move it to its own database tier rather than squeezing
PerfStaq.

### Optional isolation hardening (run once, verify first)

Users created through the Cloud SQL API are members of `cloudsqlsuperuser`, and
new databases grant `CONNECT` to `PUBLIC`. So by default `whitepetal_app` can
*connect* to PerfStaq's database and PerfStaq's roles can connect to
White Petal's (table access still needs grants). To fence the White Petal
database off, as the `postgres` user (`gcloud sql connect perfstaq-pg
--user=postgres --database=whitepetal`):

```sql
ALTER DATABASE whitepetal OWNER TO whitepetal_app;  -- app keeps CREATE for its migrations
REVOKE ALL ON DATABASE whitepetal FROM PUBLIC;
GRANT  CONNECT ON DATABASE whitepetal TO whitepetal_app;
```

This is **not automated** because Cloud SQL's managed roles differ from stock
Postgres; run it once, then restart White Petal and check `/api/health` shows
`db:true`. The mirror image (`REVOKE CONNECT ON DATABASE perfstaq FROM PUBLIC`)
is PerfStaq's decision, not this stack's.

## Secrets in state

The DB password, `APP_SECRET` and `CRON_SECRET` are generated by
`random_password`, so they are in the Terraform state — exactly as PerfStaq's
DB passwords are. The state is in a private GCS bucket; never commit a
`*.tfstate` or a saved plan (`.gitignore` blocks both). `CRON_SECRET` is also
visible in the Scheduler job's definition to project viewers; the stronger
alternative is an OIDC token from a scheduler service account verified by the
app, which needs app code.

(Terraform ≥ 1.11 could keep these out of state entirely with an `ephemeral
"random_password"` feeding `password_wo` / `secret_data_wo`; not used here so
the stack keeps working on the Terraform version PerfStaq uses.)

## Teardown

```bash
cd infra/terraform && terraform destroy
```

Removes the service, scheduler, registry (and its images), secrets (and their
values), WIF provider, service accounts, budget and log exclusion. It does
**not** drop the database or the DB user (`ABANDON`), and it does not disable
any API. To remove the data too, deliberately:

```bash
gcloud sql databases delete whitepetal --instance=perfstaq-pg
gcloud sql users delete whitepetal_app --instance=perfstaq-pg   # after the database is gone
```

A destroyed WIF provider is soft-deleted for 30 days; re-applying within that
window fails until you undelete it:
`gcloud iam workload-identity-pools providers undelete github-whitepetal --workload-identity-pool=github --location=global`.

## Validating changes

CI (`.github/workflows/terraform.yml`) runs `terraform fmt -check` and
`terraform validate` on every PR that touches this directory. Locally:

```bash
terraform fmt -recursive && terraform init -backend=false && terraform validate
```
