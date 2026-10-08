// Read a website like an AI crawler would, stream every finding, then build the brand profile.
import { sse, guard, body, fetchPage, parsePage, scorePage, robotsAccess, hostOf, llmJSON, AI_BOTS } from "./_lib.js";
export const config = { runtime: "edge" };

export default async function handler(req) {
  const denied = guard(req); if (denied) return denied;
  const { url } = await body(req);
  return sse(async (send) => {
    let base = String(url || "").trim(); if (!base) throw new Error("Paste a website address.");
    if (!/^https?:\/\//i.test(base)) base = "https://" + base;
    const host = hostOf(base);

    send("step", { id: "home", text: `Opening ${host} the way an AI crawler would`, why: "If AI crawlers can't read your site, ChatGPT and Perplexity can't cite it." });
    const home = await fetchPage(base);
    if (!home.ok) throw new Error(`Couldn't open ${base} (${home.error || "HTTP " + home.status}). Check the address.`);
    const origin = new URL(home.url).origin;
    const hp = parsePage(home.url, home.body);
    send("done", { id: "home", text: `Read “${hp.title || host}”: ${hp.words.toLocaleString()} words, ${hp.headings.length} headings${hp.schema.length ? `, schema: ${hp.schema.slice(0, 4).join(", ")}` : ", no schema"}` });

    send("step", { id: "robots", text: "Checking robots.txt for AI crawler access", why: "Many sites block GPTBot or PerplexityBot by accident, which makes them invisible to those assistants." });
    const [robots, llms, llmsFull] = await Promise.all([fetchPage(origin + "/robots.txt"), fetchPage(origin + "/llms.txt"), fetchPage(origin + "/llms-full.txt")]);
    const bots = robotsAccess(robots.ok ? robots.body : "");
    const blocked = AI_BOTS.filter((b) => !bots[b]);
    send("done", { id: "robots", ok: !blocked.length, text: blocked.length ? `Blocked: ${blocked.join(", ")}` : "All 9 major AI crawlers are allowed", data: { bots } });

    const isText = (r) => r.ok && !/<html/i.test(r.body.slice(0, 500));
    const hasLlms = isText(llms) || isText(llmsFull);
    send("step", { id: "llms", text: "Looking for llms.txt", why: "llms.txt is a plain-language briefing AI tools read to understand a company." });
    send("done", { id: "llms", ok: hasLlms, text: hasLlms ? `Found ${isText(llms) ? "llms.txt" : ""}${isText(llms) && isText(llmsFull) ? " and " : ""}${isText(llmsFull) ? "llms-full.txt" : ""}` : "No llms.txt. I'll write one for you." });

    send("step", { id: "sitemap", text: "Reading the sitemap to find your key pages", why: "I'll score the pages buyers and AI are most likely to land on." });
    const maps = [...(robots.body || "").matchAll(/^\s*sitemap:\s*(\S+)/gim)].map((m) => m[1]);
    if (!maps.length) maps.push(origin + "/sitemap.xml");
    let locs = [];
    for (const sm of maps.slice(0, 2)) {
      const x = await fetchPage(sm, { timeout: 8000 });
      if (!x.ok) continue;
      const sub = [...x.body.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => m[1]);
      if (/<sitemapindex/i.test(x.body)) {
        const kids = await Promise.all(sub.slice(0, 3).map((u) => fetchPage(u, { timeout: 8000 })));
        kids.forEach((k) => k.ok && locs.push(...[...k.body.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => m[1])));
      } else locs.push(...sub);
    }
    send("done", { id: "sitemap", ok: locs.length > 0, text: locs.length ? `${locs.length} URLs in the sitemap` : "No sitemap found. Using links from the homepage." });

    const links = [...home.body.matchAll(/href=["']([^"'#]+)/gi)].map((m) => { try { return new URL(m[1], home.url).href; } catch { return ""; } });
    const same = (u) => { try { return new URL(u).host === new URL(home.url).host && !/\.(pdf|jpg|png|gif|svg|zip|xml|css|js)$/i.test(u) && !/privacy|terms|cookie|legal|login|signin|cart|\/tag\/|\/author\/|wp-json|feed/i.test(u); } catch { return false; } };
    const important = /about|service|solution|product|pricing|platform|case|customer|blog|guide|compare|vs|alternative/i;
    const pool = [...new Set([...locs, ...links].filter(same).map((u) => u.split("#")[0].replace(/\/$/, "")))].filter((u) => u !== home.url.replace(/\/$/, ""));
    pool.sort((a, b) => (important.test(b) ? 1 : 0) - (important.test(a) ? 1 : 0) || a.split("/").length - b.split("/").length);
    const picks = pool.slice(0, 8);

    send("step", { id: "pages", text: `Scoring ${picks.length + 1} pages for AI-readiness`, why: "AI quotes pages that answer fast, show numbers and sources, and use question headings." });
    const pages = [];
    const hs = scorePage(hp, null);
    pages.push({ url: home.url, title: hp.title, score: hs.score, fails: hs.checks.filter((c) => !c.pass).map((c) => c.label), checks: hs.checks, words: hp.words, schema: hp.schema, jsOnly: hp.jsOnly, author: hp.author });
    send("page", pages[0]);
    const parsed = [hp];
    await Promise.all(picks.map(async (u) => {
      const r = await fetchPage(u, { timeout: 9000 });
      if (!r.ok || !/<html|<body/i.test(r.body.slice(0, 4000))) return;
      const p = parsePage(r.url, r.body); parsed.push(p);
      const s = scorePage(p, null);
      const row = { url: r.url, title: p.title, score: s.score, fails: s.checks.filter((c) => !c.pass).map((c) => c.label), checks: s.checks, words: p.words, schema: p.schema, jsOnly: p.jsOnly, author: p.author };
      pages.push(row); send("page", row);
    }));
    const avg = Math.round(pages.reduce((s, p) => s + p.score, 0) / pages.length);
    send("done", { id: "pages", ok: avg >= 60, text: `Average AI-readiness ${avg}/100 across ${pages.length} pages` });

    send("step", { id: "profile", text: "Working out what you sell, who buys it, and who you compete with", why: "I need this to ask AI the same questions your buyers ask." });
    const summary = parsed.slice(0, 9).map((p) => `## ${p.title} (${p.url})\n${p.description}\n${p.text.slice(0, 1200)}`).join("\n\n");
    const info = await llmJSON(`Read this company's website and describe it for an AI-visibility tracker.\n\n${summary.slice(0, 12000)}\n\nJSON: {"name":"brand name as customers say it","category":"ONE phrase buyers type to find this kind of company, 2-6 words, lowercase, no commas","offer":"one sentence: what they sell and the promise","audience":"who buys it, short","market":"main country or region","competitors":["6-8 real companies whose product does the SAME job for the SAME buyer, i.e. what a buyer would shortlist instead of this company. Prefer direct, category-specific rivals over big generic platforms or tools from adjacent categories (e.g. for an engineering-metrics tool list LinearB, Jellyfish, Swarmia, not Jira or Asana)"],"facts":["5 key facts the site states about the company"],"identity":["4-6 adjectives or short phrases that describe the brand"],"products":["4-8 products or services they sell, short names"],"personas":["4-6 job titles or customer types who buy, short"]}`);
    const profile = { name: String(info.name || hp.title.split(/[|–-]/)[0]).trim().slice(0, 80), site: origin, category: String(info.category || "").split(/[,;|/]/)[0].trim().slice(0, 80), offer: String(info.offer || "").slice(0, 240),
      audience: String(info.audience || "").slice(0, 120), market: String(info.market || "").slice(0, 60), competitors: (info.competitors || []).map(String).slice(0, 9), facts: (info.facts || []).map(String).slice(0, 6),
      identity: (info.identity || []).map(String).slice(0, 6), products: (info.products || []).map(String).slice(0, 8), personas: (info.personas || []).map(String).slice(0, 6) };
    send("done", { id: "profile", text: `${profile.name}: ${profile.category}. Rivals to watch: ${profile.competitors.slice(0, 4).join(", ")}` });

    const homeSchema = hp.schema;
    send("result", { profile, audit: { origin, bots, llms: hasLlms, sitemap: locs.length, pages: pages.sort((a, b) => a.score - b.score), avg, homeSchema,
      orgSchema: homeSchema.some((t) => /Organization|Corporation|ProfessionalService|LocalBusiness/.test(t)), faqSchema: pages.some((p) => p.schema.includes("FAQPage")),
      articleSchema: pages.some((p) => p.schema.some((t) => /Article|BlogPosting|NewsArticle/.test(t))), org: hp.org, jsOnly: pages.filter((p) => p.jsOnly).length, authors: pages.filter((p) => p.author).length },
      siteText: parsed.slice(0, 6).map((p) => `${p.title}: ${p.text.slice(0, 1500)}`).join("\n\n").slice(0, 9000) });
  });
}
