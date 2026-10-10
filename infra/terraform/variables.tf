variable "project_id" {
  description = "PerfStaq's project. White Petal rides on it to share Cloud SQL, WIF and the trial credit."
  type        = string
  default     = "global-bridge-508618-u6"
}

# us-central1, the same as PerfStaq, and that is load-bearing three ways:
#   1. the Cloud SQL instance is there — a service in another region pays
#      cross-region latency on every query and inter-region transfer on every
#      byte;
#   2. it is a Tier 1 Cloud Run region, the tier the free allowance is priced in;
#   3. Cloud Run domain mapping is available there (it is not everywhere).
variable "region" {
  type    = string
  default = "us-central1"
}

variable "sql_instance" {
  description = "The EXISTING Cloud SQL instance (owned by PerfStaq's stack). Looked up, never managed here."
  type        = string
  default     = "perfstaq-pg"
}

variable "wif_pool_id" {
  description = "The EXISTING workload identity pool (owned by PerfStaq's stack). A new provider is added to it."
  type        = string
  default     = "github"
}

variable "github_repo" {
  description = "owner/name — the ONLY repository allowed to mint White Petal deploy tokens."
  type        = string
  default     = "sathvik-23/white-pettle"
}

variable "domain" {
  description = <<-EOT
    Optional custom hostname, e.g. "whitepetal.perfstaq.com". Empty = serve on
    the run.app URL only.

    Mapped with a Cloud Run DOMAIN MAPPING, which is free, rather than an
    HTTPS load balancer, which is a forwarding rule at $0.025/hour (~$18/month,
    ~₹1,750) before a single request — more than this whole service is meant
    to cost in a year. The trade: domain mapping is a Preview feature with
    no SLA and somewhat higher latency. Fine for this product today.

    The domain must be verified in Search Console by the account running
    terraform (perfstaq.com already is — admin.perfstaq.com is mapped the
    same way). DNS is NOT managed here: add the records from the
    `domain_dns_records` output at the registrar.
  EOT
  type        = string
  default     = ""
}

variable "image" {
  description = <<-EOT
    The image Terraform creates the service with. ONLY USED ON CREATE: after
    that, the image belongs to the deploy workflow (lifecycle.ignore_changes in
    run.tf). Left as the placeholder, the service is created running Google's
    hello container — which answers 200 on every path, /api/health included,
    so the startup probe passes — and bootstrap.sh then rolls the first real
    image out with `gcloud run services update`. Pass -var image=... only when
    RE-creating a deleted service, so it comes back on a real build.
  EOT
  type        = string
  default     = "us-docker.pkg.dev/cloudrun/container/hello"
}

variable "max_instances" {
  description = <<-EOT
    The hard ceiling on White Petal's Cloud Run spend AND on its share of the
    shared database's connection slots. 3 × 40 concurrent requests is far
    beyond today's traffic; raise it only after raising the DB pool budget.
  EOT
  type        = number
  default     = 3
}

variable "cron_schedule" {
  description = "When Cloud Scheduler POSTs /api/cron/tick (unix-cron, UTC). Every 10 minutes, so a check someone queues starts soon after; the app decides which brand checks are due. A tick with nothing due is a ~2 s cold start (about 4,300 a month, inside Cloud Run's free tier)."
  type        = string
  default     = "*/10 * * * *"
}

# Budget alarm, in the billing account's currency (INR). The design target is
# ₹0–100/month of incremental infrastructure, so ₹500 at 50/80/100% means the
# FIRST alert (₹250) already says "something is wrong", not "we are busy".
variable "budget_amount_inr" {
  type    = number
  default = 500
}

variable "billing_account" {
  type    = string
  default = "01100B-36A427-D6E204"
}

variable "exclude_static_request_logs" {
  description = <<-EOT
    Drop Cloud Run request logs for successful static-asset GETs before they
    are ingested. Logging is free to 50 GiB/project/month, but that allowance
    is SHARED with PerfStaq; this keeps White Petal's share to the requests
    that carry information. Errors and /api/* are always kept.
  EOT
  type        = bool
  default     = true
}

variable "platform_operators" {
  description = "Comma-separated emails of the people who run White Petal: they can create organisations for clients and open any organisation (logged in its audit log)."
  type        = string
  default     = ""
}

variable "email_from" {
  description = "Sender for invite and password-reset emails (Resend). The domain must be verified in Resend."
  type        = string
  default     = "White Petal <no-reply@whitepetal.perfstaq.com>"
}

variable "billing_enabled" {
  description = "Paid plans: \"0\" (checkout off, everyone keeps their access), \"operators\" (White Petal operators only) or \"1\" (owners/admins, and new sign-ups start a trial). Keep \"0\" until the Razorpay test-mode lifecycle has passed; see docs/razorpay-runbook.md."
  type        = string
  default     = "0"
  validation {
    condition     = contains(["0", "operators", "1"], var.billing_enabled)
    error_message = "billing_enabled must be \"0\", \"operators\" or \"1\"."
  }
}

variable "razorpay_plan_ids" {
  description = "Razorpay monthly plan ids (not secret), keyed STARTER_USD, STARTER_INR, GROWTH_USD, GROWTH_INR, AGENCY_USD, AGENCY_INR. Passed to the app as RAZORPAY_PLAN_<KEY>; an empty or missing id keeps that plan unavailable."
  type        = map(string)
  default     = {}
  validation {
    condition     = alltrue([for k in keys(var.razorpay_plan_ids) : contains(["STARTER_USD", "STARTER_INR", "GROWTH_USD", "GROWTH_INR", "AGENCY_USD", "AGENCY_INR"], k)])
    error_message = "razorpay_plan_ids keys must be STARTER_USD, STARTER_INR, GROWTH_USD, GROWTH_INR, AGENCY_USD or AGENCY_INR."
  }
}
