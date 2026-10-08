# White Petal by Perfstaq

**Will AI recommend you?** Paste a website. A short setup, modelled on Peec AI's onboarding, shows a live preview of your workspace filling in as you answer one question at a time:

1. **Brand profile.** The agent reads the site the way GPTBot and PerplexityBot do, then drafts your description, category, brand identity, products, personas and facts for you to review.
2. **Where you sell.** This is the market AI should answer for.
3. **Competitors.** Suggested from your profile. Remove or add.
4. **Topics.** The themes buyers research, generated from your products.
5. **Prompt focus.** Research, compare options, or take action. This sets the intent mix, prompts per topic, and AI engines.
6. **Prompt set.** The questions arrive grouped by topic, tagged with intent and persona. Review them with coverage by persona, intent and engine. Your name is left out on purpose.

**Run analysis** starts the live agent. It asks ChatGPT, Perplexity, Gemini, Groq and Google's AI Overviews / AI Mode every prompt (1–3 times each, to average out run-to-run noise) with web search on, opens every page they cite, fact-checks what AI says about you, explains why you win or lose, and drafts the fixes (robots.txt lines, llms.txt, company schema, personalised pitches, articles, page rewrites). It also draws a live map you can drag, zoom and click.

Then **"your workspace is ready"** reveals the first results. The **results dashboard** has these pages:

- **Overview**: visibility score (0–100), visibility, share of voice, position, sentiment, win rate, used-as-source, strongest engine, a trend across checks, AI referral traffic (GA4), top brands, chats and top domains
- **All prompts**, and **Mention gaps** (prompts where AI names rivals and never you, with a one-click draft page)
- **Chats**, each with a details panel, and **Fanouts** (the searches AI ran)
- **Domains**, plus **URLs & content types** (listicle, review site, forum, docs…, and where you stand on each)
- **Gap analysis**, with one-click pitches
- **Search rankings**: the searches AI ran, and where you rank for them on Google (Search Console, or a live top-10 check) and Bing
- **Actions**, worked through with ← and →; **Ranking**; **Insights**; **Perception**
- **My website**: crawler access, page scores (now with JS-only content, author and credentials, alt text, internal links, H1), the most common page problems, an entity check (Wikidata, Knowledge Graph, sameAs), AI crawler visits (Cloudflare) and Bing index status
- **Settings**: weekly or daily checks that run on the server, answers per prompt, and integrations

There's also an **Agent** drawer you can ask anything. `docs/peec-onboarding-analysis.md` explains what we copied from Peec and why, and **How we measure** on the dashboard defines every metric.

## Organisations, people and scheduled checks

With a database, White Petal has accounts (email + password, or Sign in with Google) and **organisations**. Brands belong to an organisation, not a person, and people join an organisation with a role:

| Role | Can do |
|---|---|
| Owner | Everything, including handing over ownership. One per organisation |
| Admin | Invite and remove people, change roles, set the organisation's AI keys and monthly budget, connect integrations, delete brands |
| Editor | Run and queue checks, edit prompts and competitors, write drafts. Can't connect tools or delete brands |
| Viewer | See every dashboard and report, and ask the agent about a run. Changes nothing |

- **Invites.** An admin invites by email from **Team & keys**. The link works for 7 days, once, and is emailed through Resend. Without `RESEND_API_KEY` the admin gets the link to copy instead. People who accept an invite never need `ACCESS_CODE`.
- **Platform operators** (`PLATFORM_OPERATORS`, comma-separated emails) create organisations for clients ("AI Xccelerate", owner `rahul@…`): the operator becomes an admin and the owner gets an invite. Operators can open any organisation; each visit is written to its activity log.
- **Each organisation's own AI keys.** Checks run on the keys an admin saves in Team & keys (encrypted at rest, shown only as `••••last4`). Client organisations never fall back to the platform's keys; the personal organisations made from accounts that existed before organisations did, and new self-serve sign-ups (unless `PLATFORM_KEYS_FOR_SIGNUPS=0`), may.
- **Budget and usage.** Every AI call is metered at estimated list prices, by engine, person and brand. With a monthly budget set, members see a warning at 80%, and at 100% new checks and scheduled runs stop until the budget is raised or the month ends.
- **Activity log.** Invites, joins, role changes, key and budget changes, connections, deletions, queued and skipped checks, operator visits.
- **Password resets** by email (1-hour, one-time links); a reset signs you out everywhere else.
- A brand can be moved between organisations by someone who is an admin in both (Settings → Move to another organisation).

Runs live in Postgres, so a run started in one browser is there in another, and **scheduled checks** keep running with the tab closed: Cloud Scheduler calls `POST /api/cron/tick` every 10 minutes and the server runs every brand that is due on its organisation's keys, using the same handlers as a live run. "Queue a check now" starts one within about 10 minutes, so nobody has to keep a tab open. Without a database it still works as before, with everything kept in the browser.

## Integrations (all free)

Connected per brand in **Settings**. Keys are encrypted at rest (AES-256-GCM with `APP_SECRET`).

| Integration | What it adds |
|---|---|
| Bing Webmaster Tools | Bing queries and positions (ChatGPT search leans on Bing), index and crawl status, URL submission |
| IndexNow | Pushes new or changed pages to Bing, Yandex and others in minutes |
| Google Search Console + GA4 | Your Google positions for the searches AI runs; sessions from ChatGPT, Perplexity, Gemini, Copilot and Claude |
| Cloudflare | Which AI crawlers hit your site, and how often |
| Entity & Knowledge Graph | Wikidata, Google Knowledge Graph and sameAs checks |
| Slack | A message after every scheduled check |

## Hosting: Google Cloud

Production runs on **Cloud Run** in PerfStaq's Google Cloud project, with a `whitepetal` database on PerfStaq's existing Cloud SQL instance. It scales to zero and adds roughly **₹55 a month** to the bill; `docs/gcp-cost-plan.md` has the numbers, and why Cloud Run rather than Kubernetes (GKE would cost ₹2,900–4,300 a month before any traffic). `docs/perfstaq-cost-review.md` lists savings for PerfStaq itself.

**First deploy** (once, from a machine with `gcloud` and `terraform` logged in):

```bash
infra/bootstrap.sh       # terraform apply, stores keys, builds, deploys, sets GitHub variables
```

After that, every push to `main` runs the tests and deploys (`.github/workflows/ci.yml`, keyless via Workload Identity Federation). Infra changes go through `.github/workflows/terraform.yml`. Add or rotate a key with `infra/secrets.sh OPENAI_API_KEY`. Details: `infra/terraform/README.md`.

| Key (Secret Manager `WHITEPETAL_<NAME>`) | Required | What it does |
|---|---|---|
| `DATABASE_URL`, `APP_SECRET`, `CRON_SECRET` | set by Terraform | Database, sessions and encryption, the cron call |
| `GEMINI_API_KEY` | **free**, recommended | Gemini as a live engine with Google Search grounding, plus all AI writing (aistudio.google.com/apikey) |
| `GROQ_API_KEY` | **free** | Groq Compound as a live engine with web search, plus a fast writer |
| `OPENAI_API_KEY`, `PERPLEXITY_API_KEY` | paid, optional | ChatGPT and Perplexity as live engines |
| `DATAFORSEO_LOGIN` + `DATAFORSEO_PASSWORD`, or `SERPAPI_KEY` | optional | Google AI Overviews and AI Mode as engines, and live Google rankings |
| `GOOGLE_OAUTH_CLIENT_ID` + `_SECRET` | free, optional | Search Console + GA4, and Sign in with Google. Redirect URIs `https://<your host>/api/oauth/google/callback` and `https://<your host>/api/auth/google/callback` |
| `GOOGLE_API_KEY` | free, optional | Knowledge Graph lookups for the entity check |
| `ACCESS_CODE` | optional | Code required for sign-ups without an invite link |
| `PLATFORM_OPERATORS` | optional (Terraform `platform_operators`) | Emails of the people who run White Petal for clients |
| `RESEND_API_KEY`, `EMAIL_FROM` | optional | Invite and password-reset emails (Terraform `email_from`) |

The writing model is picked in this order: Gemini → Groq → OpenAI → Anthropic. Force one with `PETTLE_LLM_PROVIDER`.

## Run locally

With Docker (Postgres 17, like production):

```bash
cp .env.example .env.local   # add GEMINI_API_KEY at least
docker compose up --build    # → http://localhost:8080
```

Or with Node 22 and any Postgres:

```bash
npm ci
cp .env.example .env.local   # add GEMINI_API_KEY, DATABASE_URL, APP_SECRET
npm run dev                  # → http://localhost:3000, restarts on change
npm test                     # set TEST_DATABASE_URL to also run the API tests
```

Leave `DATABASE_URL` empty to run without accounts, with everything in the browser.

## How it's built

- `public/` is the whole interface: vanilla JS, d3 for the live map, and the Perfstaq brand system (Geist, the orange middle bar). No build step.
- `api/` holds the handlers that stream Server-Sent Events:
  - `site` reads the website like a crawler
  - `ask` talks to the live engines, streaming their searches, sources and answer
  - `inspect` opens a cited page and checks who's on it
  - `write` streams all of the agent's writing
- `server/` is a small Node HTTP server around those handlers: accounts, brands, runs, integrations, the scheduled-check runner (`runner.mjs`, the same pipeline as the browser), Postgres migrations, and static files with brotli and caching.
- `infra/` is Terraform plus the bootstrap and secrets scripts; `Dockerfile` builds the image Cloud Run runs.

Rough cost per run (12 prompts × 1 engine × 1 answer): $0.50–$2 on OpenAI; close to nothing on Gemini's free tier. Each extra engine or answer-per-prompt multiplies that.
