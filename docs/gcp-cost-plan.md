# White Petal on Google Cloud — cost plan

*Prices looked up on 8 October 2026 from Google's and the AI providers' public
pricing pages (sources at the end). ₹ at **₹97 / US$** (market rate 96.77 on
7 Oct 2026, rounded up so the plan errs high). Google bills an INR account
from its own INR price list, so the invoice can come in a little lower.*

## The answer in one paragraph

White Petal's **infrastructure** costs **about ₹55 a month expected, ₹180 in
the worst case**, because it rides on PerfStaq's project: one Cloud Run
service that scales to zero, a database on the Cloud SQL instance PerfStaq
already pays for, and free tiers for everything else. The **AI APIs** are
what cost money: **₹31–49 per analysis run** (15 prompts × 3 engines) with the
levers below, so 100 runs a month is ₹3,100–4,900, which is 50–100× the
infrastructure. The founder asked for Kubernetes. GKE would cost **₹2,000–4,300
a month** for the same app, mostly for a load balancer and a pod that can't
scale to zero, so this plan uses Cloud Run. Kubernetes makes sense for
**PerfStaq's always-on worker** instead (see `docs/perfstaq-cost-review.md`).

---

## 1. What runs, and why it is cheap

| Piece | Choice | Cost reason |
|---|---|---|
| Compute | Cloud Run `whitepetal`, **min 0**, max 3, 1 vCPU / 512 MiB, **request-based billing** (`cpu_idle = true`), concurrency 40 | Billed only while a request is in flight; 40 I/O-bound requests share one instance-second |
| Database | Database `whitepetal` on **perfstaq-pg** (db-f1-micro) via the `/cloudsql` socket | A second instance would be ~₹750/month; a database on the existing one is free |
| DB network | Cloud SQL Auth Proxy built into Cloud Run, using the instance's public IP | No VPC egress, no Serverless VPC connector (~$8/mo), no Cloud NAT |
| Cron | Cloud Scheduler, 1 job, hourly | 3 jobs free per billing account; PerfStaq uses none |
| Secrets | Secret Manager, read by the app at boot | Containers are free; only *versions* bill |
| Images | Artifact Registry `whitepetal`, 5 newest kept, scanning off | ~0.1 GB; scanning would be $0.26 per push |
| Domain | Cloud Run domain mapping (optional) | Free; an HTTPS LB is ~$18/mo for the forwarding rule alone |
| CI/CD | GitHub Actions + WIF, buildx cache in `type=gha` | Free runner minutes and cache; no registry-side cache storage |

## 2. Itemised monthly cost

**Usage assumed for the beta:** 3 interactive analysis runs a day (each holds
an SSE stream open for about 6 minutes), 20 scheduled brand checks a month, and
720 hourly cron ticks. Each tick is a cold start, about 2 s, when nothing is due.
That comes to about 46,000 instance-seconds a month.

| Line item | Usage | List price | Gross | Expected¹ | Worst case² |
|---|---|---|---|---|---|
| Cloud Run CPU | ~46,000 vCPU-s | $0.000024 / vCPU-s | $1.10 | ₹0 | ₹107 |
| Cloud Run memory | ~23,000 GiB-s | $0.0000025 / GiB-s | $0.06 | ₹0 | ₹6 |
| Cloud Run startup boost | ~900 cold starts × ~2 s extra vCPU | same CPU rate | $0.04 | ₹0 | ₹4 |
| Cloud Run requests | ~40,000 | $0.40 / million | $0.02 | ₹0 | ₹2 |
| Secret Manager versions | 3 generated + ~5 keys = 8 | $0.06 / version / month | $0.48 | **₹47** | ₹47 |
| Secret Manager access | 900 boots × 15 reads = 13,500 | $0.03 / 10,000 | $0.04 | ₹4 | ₹4 |
| Cloud SQL | +~0.2 GB SSD on the shared instance | $0.17 / GB-month | $0.03 | ₹3 | ₹3 |
| Artifact Registry | ~0.1 GB (shared base layers) | $0.10 / GB-month over 0.5 GB | $0.01 | ₹1 | ₹1 |
| Cloud Scheduler | 1 job | $0.10 / job, 3 free | $0.10 | ₹0 | ₹0 |
| Cloud Build | ~2 min, once (bootstrap) | 2,500 min/month free | — | ₹0 | ₹1 |
| Cloud Logging | ~0.2 GiB | 50 GiB / project free, then $0.50/GiB | — | ₹0 | ₹0 |
| Internet egress | ~0.5 GiB (static files to browsers) | 1 GiB/month free (N. America), then $0.12/GiB | $0.06 | ₹0 | ₹6 |
| Domain mapping, IAM, WIF, budget | — | free | — | ₹0 | ₹0 |
| **Total** | | | **~$1.9** | **≈ ₹55** | **≈ ₹180** |

¹ *Expected*: Cloud Run's free tier (180,000 vCPU-s, 360,000 GiB-s and 2 M
requests per month for request-based billing) is **per billing account**, so
PerfStaq's api, web, ai and admin services draw on the same allowance. In a
normal beta month it still has room for White Petal's ~46,000 vCPU-s.
Secret Manager's 6 free versions and 10,000 free accesses are already used by
PerfStaq's ~20 secrets, so those lines are charged in full.
² *Worst case*: PerfStaq has used up every shared free tier.

**Growth scenario** (30 interactive runs a day plus 50 brands checked weekly):
about 260,000 instance-seconds, so Cloud Run is about $6.6 (₹640) gross before
free tier, and the other lines stay the same. That's roughly ₹700 at most. The
AI spend for that volume is ₹34,000–54,000.

**The cheapest remaining lever on infra:** Secret Manager is the largest
*certain* line, at ₹47. If the app read a single JSON secret
(`WHITEPETAL_KEYS`) instead of one secret per key, it would need 4 billed
versions instead of 8, about ₹23. This
needs a change in the app's secret loader. It's worth doing only if every rupee
counts.

## 3. AI API spend — the real bill

One analysis run is **15 prompts × 3 engines = 45 engine calls**. On top of
that come scoring each answer, inspecting cited pages, and writing the
profile, fixes, pitches and articles.

| Step | Model and price used | Per call | Per run | ₹ / run |
|---|---|---|---|---|
| ChatGPT engine × 15 | gpt-4.1-mini + `web_search`: **$10 / 1k calls**, search content billed as a fixed 8,000 input tokens; tokens $0.40 / $1.60 per M³ | $0.0145 | $0.218 | ₹21.1 |
| Perplexity engine × 15 | `sonar`, low context: **$5 / 1k requests** + $1 / $1 per M tokens | $0.0065 | $0.098 | ₹9.5 |
| Gemini engine × 15 | gemini-2.5-flash + Google Search grounding: **free tier ≤ 500 grounded RPD**; paid tier 1,500 RPD free then **$35 / 1k**; tokens $0.30 / $2.50 per M | $0 (free) · $0.004 (paid, in quota) | $0 · $0.06 | ₹0 · ₹5.8 |
| Scoring 45 answers | gpt-4.1-mini, ~2.5k in / 300 out each | $0.0015 | $0.067 | ₹6.5 |
| Inspecting ~30 cited pages | gemini-2.5-flash-lite, ~3k tokens each ($0.10 / $0.40 per M) | $0.0004 | $0.012 | ₹1.2 |
| Writing (profile, topics, fixes, pitches, articles) | gemini-2.5-flash, ~40k in / 15k out | — | $0.05 | ₹4.8 |

³ *gpt-4.1-mini is no longer on OpenAI's headline pricing page. The figures
are its last published rates, and the fixed 8,000-token search block is still
listed for it. The current small model, "GPT-5.6 Luna", lists at $0.20 / $1.20
per M with search content billed at model rates. That works out to about
$0.013 per search call, the same range. In both cases the **$10 / 1k search
fee is about 70% of the cost**.*

| Configuration | Per run | ₹ / run | 100 runs / month |
|---|---|---|---|
| **Lean** (recommended): ChatGPT + Perplexity paid; Gemini engine, scoring, inspection and writing on the Gemini **free** tier | $0.32 | **₹31** | ₹3,100 |
| **All paid**, Gemini within its grounding quota | $0.51 | **₹49** | ₹4,900 |
| **Careless**: gpt-4.1 engine, sonar-pro medium context, Gemini grounding past quota, gpt-4.1 scoring | $1.6–2.0 | ₹155–195 | ₹15,500–19,500 |

### Levers, biggest first

1. **Use fewer search calls, because tokens are not the main cost.** Search
   fees are $10 / 1k for OpenAI and $5–14 / 1k for Perplexity, and they make up
   most of each engine call. Run only the engines the customer selected. For
   scheduled re-checks, run a **rotating sample**, for example 5 of the 15
   prompts per day, which covers everything every 3 days at a third of the cost.
2. **Use the Gemini free tier for all writing and grounding.** The app's writer
   order is already Gemini → Groq → OpenAI → Anthropic. Keep it that way, and
   keep the Gemini engine on a free-tier key until it hits 500 grounded
   requests a day. Caveat: free-tier prompts may be used to improve Google's
   products. Public web and brand data is fine; don't send customer-private
   material there.
3. **Use gpt-4.1-mini or a successor for scoring, and avoid the LLM where
   possible.** Brand-mention detection and list position are string matching.
   Use the model only for sentiment and fact-checking.
4. **Cache.** Cache engine answers by (prompt, engine, market, day), because
   brands in the same category share prompts. Cache inspected pages by URL for
   7 days. OpenAI's cached input costs 10–25% of the normal rate when the
   system prompt is at least 1,024 tokens and stable, so keep the stable part
   first.
5. **Use the batch APIs for scheduled work.** OpenAI's and Gemini's batch APIs
   are 50% off, and scheduled scoring doesn't need an answer within seconds.
6. **Set hard caps outside Google.** A GCP budget can't see this spend. Set a
   monthly budget on the OpenAI project, prepay Perplexity, DataForSEO and
   SerpApi credits, keep `ACCESS_CODE` set on public links, and add a per-account
   daily run limit in the app.

## 4. Why not Kubernetes (yet)

The same app on GKE, with each option sized as small as it can go:

| | Cloud Run (this plan) | GKE Autopilot | GKE Standard (zonal) |
|---|---|---|---|
| Cluster fee | — | $0.10/h = $73 → **$0** with the $74.40/month GKE free-tier credit (one cluster per billing account) | same, $0 with the credit |
| App compute | per busy second only; **scales to zero** | pod always on: 0.25 vCPU / 0.5 GiB minimum on non-burstable clusters at $0.0445 / vCPU-h + $0.0049 / GiB-h = **$9.9** | an e2-medium node, about $24.5 on-demand (Spot about $10); kube-system takes much of it |
| Cloud SQL connection | built-in socket | Auth Proxy sidecar, about $3.7 | sidecar, shares the node |
| Public HTTPS | free run.app URL / domain mapping | Ingress = external Application LB: forwarding rule **$18.25** + $0.008/GiB | same **$18.25** |
| Disk | — | — | 30 GB pd-standard $1.2 (the default 100 GB pd-balanced is ~$10) |
| Cron | Cloud Scheduler, free | CronJob, ~$0.15 | CronJob |
| **Monthly** | **≈ ₹55** | **≈ $32 → ₹3,100** | **≈ $30–44 → ₹2,900–4,300** |
| Ops | none | manifests, upgrades, HPA (no HTTP scale-to-zero without KEDA/Knative) | all of Autopilot + node pools, OS upgrades |

Two things decide it:

- **There's no scale-to-zero.** A Deployment keeps at least one pod running
  all month, but White Petal is idle most hours.
- **The load balancer costs money even with no traffic.** At $18.25 a month,
  it alone costs about 30 times White Petal's entire infrastructure bill on
  Cloud Run.

**GKE becomes worth it when any of these is true:**

- **The work is always-on.** A pod that would run all month anyway costs less
  on Autopilot, and much less on **Spot** pods ($0.0133 / vCPU-h, $0.0015 / GiB-h).
  PerfStaq's BullMQ worker is exactly this case: about ₹1,000 a month on an
  Autopilot Spot pod, against about ₹4,400 on Cloud Run. It needs no load
  balancer, and the cluster fee is covered by the free-tier credit. See the
  PerfStaq review.
- **The service stays busy.** One Cloud Run instance busy for an hour costs
  about $0.091. An Autopilot pod with 1 vCPU / 1 GiB plus the load balancer
  costs about $54 a month flat. They break even at about **600 busy
  instance-hours a month**, which means a vCPU busy more than 80% of the time,
  or a Cloud Run bill above about ₹5,000. With Spot pods the break-even is
  around 330 hours.
- **The workload doesn't fit Cloud Run.** Examples: jobs longer than Cloud Run's
  60-minute request cap, GPUs that run all the time, sidecars, stateful sets,
  or many small always-on services across products that can share one
  load balancer and one set of nodes.

White Petal today meets none of these, so it stays on Cloud Run. If one becomes
true, the move is cheap: the same image runs unchanged on GKE.

## 5. Ten cost guardrails

- [x] **1. A budget of its own.** `budget.tf`: ₹500 with alerts at 50%, 80% and
  100%, plus a forecast alert at 100%. It's filtered to label `app=whitepetal`
  and counts spend **before** the Free Trial credit is subtracted. The default
  "include all credits" setting would show ₹0 for the whole trial and never
  fire.
- [x] **2. Max instances = 3.** This caps Cloud Run spend and White Petal's
  share of perfstaq-pg's 25 connections.
- [x] **3. A log exclusion.** Successful static-asset GET request logs are never
  ingested. Errors, `/api/*` requests and app logs are kept. The 50 GiB free
  logging tier is shared with PerfStaq.
- [x] **4. Artifact Registry cleanup that actually deletes.** It keeps the 5
  newest images, deletes untagged ones after 7 days and everything else after
  30 days. A KEEP policy on its own deletes nothing. Vulnerability scanning is
  **off**, because it costs $0.26 per pushed digest.
- [x] **5. Request-based billing.** `cpu_idle = true`, `min_instance_count = 0`,
  and `startup_cpu_boost` to soften cold starts. Concurrency is 40, because
  billing is per instance-second, not per request. CPU is not set below 1:
  fractional CPU would force concurrency to 1.
- [x] **6. No Cloud NAT.** Outbound calls go straight to the internet from
  Cloud Run.
- [x] **7. No VPC connector, and no Direct VPC egress either.** The database is
  reached through the `/cloudsql` socket.
- [x] **8. No load balancer.** The service uses the run.app URL or a free
  domain mapping.
- [x] **9. Scheduler: 1 job, and at most 3 across the billing account.** It has
  `retry_count = 0`, so a timed-out tick doesn't repeat its LLM spend.
- [x] **10. `app=whitepetal` labels on every resource that accepts them**
  (provider `default_labels`). The billing report and the budget split White
  Petal from PerfStaq by this label.

Also in place:
- `secrets.sh` deletes superseded secret versions, because disabled versions
  are still billed.
- Nothing is pushed to the registry until the image passes a smoke test, so
  failed builds don't add storage.
- Cloud Build is used only for the one-off bootstrap build.

---

### Sources

- [Cloud Run pricing](https://cloud.google.com/run/pricing) — request-based and instance-based billing, free tiers, worker pools, networking
- [Cloud Run CPU limits](https://docs.cloud.google.com/run/docs/configuring/services/cpu) — CPU below 1 requires concurrency 1 and request-based billing
- [Cloud SQL pricing](https://cloud.google.com/sql/pricing) — db-f1-micro $0.0105/h, storage, backups
- [Connect from Cloud Run to Cloud SQL](https://docs.cloud.google.com/sql/docs/postgres/connect-run) — socket, Cloud SQL Client role, the gen1 CA-mode restriction
- [Secret Manager pricing](https://cloud.google.com/secret-manager/pricing)
- [Cloud Scheduler pricing](https://cloud.google.com/scheduler/pricing)
- [Artifact Registry pricing](https://cloud.google.com/artifact-registry/pricing) · [cleanup policies](https://docs.cloud.google.com/artifact-registry/docs/repositories/cleanup-policy) · [Artifact Analysis pricing](https://cloud.google.com/artifact-analysis/pricing)
- [Cloud Build pricing](https://cloud.google.com/build/pricing) — 2,500 free build-minutes per billing account
- [Cloud Logging pricing](https://cloud.google.com/stackdriver/pricing)
- [Network pricing](https://cloud.google.com/vpc/network-pricing) · [Load balancing pricing](https://cloud.google.com/load-balancing/pricing)
- [GKE pricing](https://cloud.google.com/kubernetes-engine/pricing) · [Autopilot resource requests](https://docs.cloud.google.com/kubernetes-engine/docs/concepts/autopilot-resource-requests)
- [Budget API filter](https://docs.cloud.google.com/billing/docs/reference/budget/rest/v1/billingAccounts.budgets) · [credit types](https://docs.cloud.google.com/billing/docs/how-to/export-data-bigquery-tables/detailed-usage) — Free Trial credit is type PROMOTION
- [OpenAI API pricing](https://openai.com/api/pricing/) · [OpenAI web search tool pricing](https://developers.openai.com/api/docs/pricing)
- [Gemini API pricing](https://ai.google.dev/gemini-api/docs/pricing)
- [Perplexity API pricing](https://docs.perplexity.ai/getting-started/pricing)
- [USD/INR, 7 Oct 2026](https://dollarrupee.in/)
