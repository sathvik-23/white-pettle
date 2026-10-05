# White Petal by Perfstaq

**Will AI recommend you?** Paste a website and watch an AI agent work it out live, step by step:

1. **Reads the site the way AI crawlers do.** It checks robots.txt access for GPTBot, PerplexityBot and ClaudeBot, looks for llms.txt, reads the sitemap, and scores your key pages for AI-readiness.
2. **Builds the company profile and waits for your approval.** Once you approve, it saves the profile.
3. **Writes the questions your buyers type into ChatGPT.** Your brand name is left out on purpose, to see whether AI brings you up on its own.
4. **Asks ChatGPT, Perplexity and Gemini live, with web search on.** You see each search query, the answer streaming in, the sources it cites, and every brand it names highlighted.
5. **Follows the sources.** It opens every page the engines cited and shows who's on it, with evidence and contacts.
6. **Fact-checks what AI says about you.**
7. **Explains why you win or lose**, then drafts the fixes: robots.txt lines, llms.txt, company schema, personalised pitches, full articles and page rewrites.

Everything appears on a **live map** (you, rivals, questions, cited pages) that you can drag, zoom and click. The **results** screen has a question-by-question grid, an action deck you work through with ← and →, and an agent you can ask anything, with answers streamed back.

## Deploy your own (2 minutes)

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fsathvik-23%2Fwhite-pettle&project-name=white-petal&repository-name=white-petal&env=GEMINI_API_KEY,ACCESS_CODE&envDescription=Free%20Gemini%20key%20powers%20the%20agent.%20ACCESS_CODE%20stops%20strangers%20using%20your%20credits.&envLink=https%3A%2F%2Faistudio.google.com%2Fapikey)

Or import the repo at [vercel.com/new](https://vercel.com/new) and add these **Environment Variables**:

| Name | Required | What it does |
|---|---|---|
| `GEMINI_API_KEY` | **free**, recommended | Gemini as a live engine with Google Search grounding, plus all AI writing. Get one at aistudio.google.com/apikey |
| `GROQ_API_KEY` | free, optional | A fast, free writing model (Llama 3.3 70B) |
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
