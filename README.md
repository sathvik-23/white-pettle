# White Petal by Perfstaq

**Will AI recommend you?** Paste a website. A short setup, modelled on Peec AI's onboarding, shows a live preview of your workspace filling in as you answer one question at a time:

1. **Brand profile.** The agent reads the site the way GPTBot and PerplexityBot do, then drafts your description, category, brand identity, products, personas and facts for you to review.
2. **Where you sell.** This is the market AI should answer for.
3. **Competitors.** Suggested from your profile. Remove or add.
4. **Topics.** The themes buyers research, generated from your products.
5. **Prompt focus.** Research, compare options, or take action. This sets the intent mix, prompts per topic, and AI engines.
6. **Prompt set.** The questions arrive grouped by topic, tagged with intent and persona. Review them with coverage by persona, intent and engine. Your name is left out on purpose.

**Run analysis** starts the live agent. It asks ChatGPT, Perplexity and Gemini every prompt with web search on, opens every page they cite, fact-checks what AI says about you, explains why you win or lose, and drafts the fixes (robots.txt lines, llms.txt, company schema, personalised pitches, articles, page rewrites). It also draws a live map you can drag, zoom and click.

Then **"your workspace is ready"** reveals the first results. The **results dashboard** has these pages:

- Overview: visibility, share of voice, position, strongest and weakest engine, a visibility chart, top brands, chats and top domains
- All prompts
- Chats, each with a details panel
- Domains, with domain types
- Gap analysis, with one-click pitches
- Actions, worked through with ← and →
- Ranking
- Insights
- Perception
- My website

There's also an **Agent** drawer you can ask anything. `docs/peec-onboarding-analysis.md` explains what we copied from Peec and why.

## Deploy your own (2 minutes)

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fsathvik-23%2Fwhite-pettle&project-name=white-petal&repository-name=white-petal&env=GEMINI_API_KEY,ACCESS_CODE&envDescription=Free%20Gemini%20key%20powers%20the%20agent.%20ACCESS_CODE%20stops%20strangers%20using%20your%20credits.&envLink=https%3A%2F%2Faistudio.google.com%2Fapikey)

Or import the repo at [vercel.com/new](https://vercel.com/new) and add these **Environment Variables**:

| Name | Required | What it does |
|---|---|---|
| `GEMINI_API_KEY` | **free**, recommended | Gemini as a live engine with Google Search grounding, plus all AI writing. Get one at aistudio.google.com/apikey |
| `GROQ_API_KEY` | **free**, no card | Groq Compound as a live engine with web search, plus a fast free writer (Llama 3.3 70B) |
| `ACCESS_CODE` | recommended | Anyone using your link has to type this code before the agent runs |
| `OPENAI_API_KEY` | paid, optional | Adds ChatGPT as a live engine |
| `PERPLEXITY_API_KEY` | paid, optional | Adds Perplexity as a live engine |

The writing model is picked in this order: Gemini → Groq → OpenAI → Anthropic. Force one with `PETTLE_LLM_PROVIDER`.

There's no build step and no database. Company profiles and runs are saved in each visitor's browser.

## Run locally

```bash
cp .env.example .env    # add your OPENAI_API_KEY
node dev.mjs            # → http://localhost:3000   (Node 18+)
```

## How it's built

- `public/` is the whole interface: vanilla JS, d3 for the live map, and the Perfstaq brand system (Geist, the orange middle bar).
- `api/` holds edge functions that stream Server-Sent Events:
  - `site` reads the website like a crawler
  - `ask` talks to the live engines, streaming their searches, sources and answer
  - `inspect` opens a cited page and checks who's on it
  - `write` streams all of the agent's writing
- `dev.mjs` runs the exact same handlers locally.

Rough cost per run (12 questions × 1 engine): $0.50–$2 in OpenAI usage. Each extra engine adds a similar amount.
