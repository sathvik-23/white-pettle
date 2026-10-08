# ════════════════════════════════════════════════════════════════════════════
#  White Petal's budget — its OWN, not PerfStaq's.
#
#  PerfStaq's budget watches the whole project, so a White Petal spike would
#  show up there as "PerfStaq got expensive". This one watches only resources
#  labelled app=whitepetal (versions.tf puts that label on everything that
#  takes labels), so it answers "what does White Petal cost" directly.
#
#  A budget NOTIFIES. It does not cap. Google keeps serving — and charging —
#  past 100%. The caps in this stack are max_instance_count (run.tf) and the
#  API keys' own provider-side limits; this is the smoke alarm.
#
#  What it does NOT see: AI provider spend (OpenAI, Perplexity, Anthropic,
#  DataForSEO, SerpApi bill separately — set hard limits in THEIR consoles),
#  and Gemini API usage if that key belongs to a project on this billing
#  account (it bills as "Gemini API", which carries no label).
# ════════════════════════════════════════════════════════════════════════════

resource "google_billing_budget" "whitepetal" {
  billing_account = var.billing_account
  display_name    = "whitepetal — infra guard"

  budget_filter {
    projects = ["projects/${data.google_project.this.number}"]

    # Exactly ONE key/value pair is allowed — the API rejects more.
    labels = {
      app = "whitepetal"
    }

    # GROSS of the free-trial credit. The default, INCLUDE_ALL_CREDITS,
    # subtracts every credit — and the Free Trial credit is a credit (type
    # PROMOTION). While the ₹25,000 trial lasts, net spend is therefore ~₹0
    # and a default budget can NEVER fire: the alarm stays silent exactly
    # while the credit it is meant to protect is being burned. Subtract only
    # the credits that reflect real, permanent savings (free tier, discounts)
    # and leave PROMOTION in the measured spend.
    credit_types_treatment = "INCLUDE_SPECIFIED_CREDITS"
    credit_types = [
      "FREE_TIER",
      "SUSTAINED_USAGE_DISCOUNT",
      "COMMITTED_USAGE_DISCOUNT",
      "COMMITTED_USAGE_DISCOUNT_DOLLAR_BASE",
      "DISCOUNT",
      "FEE_UTILIZATION_OFFSET",
    ]
  }

  amount {
    specified_amount {
      # Must match the billing account's currency, which is INR.
      currency_code = "INR"
      units         = tostring(var.budget_amount_inr)
    }
  }

  threshold_rules {
    threshold_percent = 0.5
  }

  threshold_rules {
    threshold_percent = 0.8
  }

  threshold_rules {
    threshold_percent = 1.0
  }

  # A FORECAST alert at 100% fires mid-month when the trend says the month
  # will end over budget — days before the actual-spend rules can.
  threshold_rules {
    threshold_percent = 1.0
    spend_basis       = "FORECASTED_SPEND"
  }

  depends_on = [google_project_service.this]
}
