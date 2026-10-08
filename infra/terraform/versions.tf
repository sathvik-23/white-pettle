terraform {
  required_version = ">= 1.5.0"

  # Same constraints AND the same lock file as PerfStaq (.terraform.lock.hcl is
  # a copy of perfstaq's: google 6.50.0, random 3.9.1). Two stacks in one
  # project on two provider versions is how one apply "fixes" a field the
  # other stack's provider writes differently.
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 6.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }

  # SAME BUCKET as PerfStaq, DIFFERENT PREFIX. Prefix `infra` is PerfStaq's
  # state; pointing this stack at it would make the first `terraform apply`
  # plan to DESTROY every PerfStaq resource, because none of them are in this
  # configuration. `whitepetal` keeps the two states — and their locks —
  # completely separate while reusing a bucket that already exists, is
  # already versioned and already access-controlled.
  backend "gcs" {
    bucket = "perfstaq-tfstate-global-bridge-508618-u6"
    prefix = "whitepetal"
  }
}

provider "google" {
  project = var.project_id
  region  = var.region

  # The Billing Budgets API refuses a request from user credentials unless a
  # quota project is named. Without these two lines `google_billing_budget`
  # fails with a 403 that reads like a permissions problem and is not one.
  # (Copied from PerfStaq, where it was learned the hard way.)
  user_project_override = true
  billing_project       = var.project_id

  # Every resource that supports labels gets app=whitepetal. This is how the
  # billing report — and the budget in budget.tf — tells White Petal's spend
  # apart from PerfStaq's in the SAME project. Cloud Run — the only line item
  # here that can grow on its own — carries its labels into the billing
  # export. Resources that take no labels (service accounts, IAM bindings,
  # the Scheduler job, the WIF provider, the shared Cloud SQL instance) cost
  # nothing or almost nothing incrementally, so the split stays honest.
  default_labels = {
    app = "whitepetal"
  }
}
