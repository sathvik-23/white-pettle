// Entity / knowledge-graph consistency (free). AI assistants lean on Wikidata, Google's Knowledge Graph and
// Organization schema to decide "who is this brand". This checks the three agree with each other and with your domain.
// Wikidata API: https://www.wikidata.org/w/api.php (User-Agent policy: https://meta.wikimedia.org/wiki/User-Agent_policy)
// Google KG Search API: https://developers.google.com/knowledge-graph
import { http, safeTest, hostOf, bareHost, clip } from "./_http.mjs";

const WD = "https://www.wikidata.org/w/api.php";
const KG = "https://kgsearch.googleapis.com/v1/entities:search";
const WD_UA = "WhitePetal/1.0 (https://whitepetal.ai; support@whitepetal.ai) entity-consistency-check";

export const meta = {
  id: "entity",
  name: "Entity & Knowledge Graph",
  category: "entity",
  auth: "none",
  free: true,
  fields: [
    { key: "googleApiKey", label: "Google API key (optional)", secret: true, placeholder: "AIza…", help: "Optional. Google Cloud console → APIs & Services → enable “Knowledge Graph Search API” → Credentials → Create API key." },
  ],
  blurb: "Checks that Wikidata, Google's Knowledge Graph and your site's Organization schema all describe the same brand, so AI assistants don't confuse you with someone else.",
  docs: "https://console.cloud.google.com/apis/library/kgsearch.googleapis.com",
};

// Wikidata properties → profile URLs.
const SOCIAL = {
  P4264: ["linkedin", (v) => `https://www.linkedin.com/company/${v}`],
  P2088: ["crunchbase", (v) => `https://www.crunchbase.com/organization/${v}`],
  P2002: ["x", (v) => `https://x.com/${v}`],
  P2013: ["facebook", (v) => `https://www.facebook.com/${v}`],
  P2003: ["instagram", (v) => `https://www.instagram.com/${v}`],
  P2397: ["youtube", (v) => `https://www.youtube.com/channel/${v}`],
  P2037: ["github", (v) => `https://github.com/${v}`],
  P1581: ["blog", (v) => v],
};
const claimValues = (e, p) => (e?.claims?.[p] || []).filter((c) => c.rank !== "deprecated").map((c) => c.mainsnak?.datavalue?.value).filter((v) => v != null);
const wdTime = (v) => (v?.time ? v.time.replace(/^\+/, "").slice(0, v.precision >= 11 ? 10 : v.precision === 10 ? 7 : 4) : null);

async function wd(ctx, params) {
  const r = await http(ctx, `${WD}?${new URLSearchParams({ format: "json", formatversion: "2", ...params })}`, { headers: { "user-agent": WD_UA, "api-user-agent": WD_UA, accept: "application/json" } });
  if (r.status === 0) throw new Error(`Couldn't reach Wikidata (${r.error}).`);
  if (r.status === 429) throw new Error("Wikidata is rate-limiting requests. Try again shortly.");
  if (!r.ok || r.data?.error) throw new Error(`Wikidata error ${r.status}${r.data?.error?.info ? `: ${clip(r.data.error.info)}` : ""}`);
  return r.data || {};
}

export async function wikidata(brand, host, ctx = {}) {
  if (!brand) return { found: false };
  const s = await wd(ctx, { action: "wbsearchentities", search: brand, language: "en", uselang: "en", type: "item", limit: "7" });
  const ids = (s.search || []).map((x) => x.id).filter(Boolean);
  if (!ids.length) return { found: false };
  const g = await wd(ctx, { action: "wbgetentities", ids: ids.join("|"), props: "labels|descriptions|claims|sitelinks/urls", languages: "en", sitefilter: "enwiki" });
  const ents = ids.map((id) => (Array.isArray(g.entities) ? g.entities.find((e) => e.id === id) : g.entities?.[id])).filter(Boolean);
  const want = bareHost(host);
  const sitesOf = (e) => claimValues(e, "P856").map(String);
  const match = want && ents.find((e) => sitesOf(e).some((u) => hostOf(u) === want || hostOf(u).endsWith(`.${want}`)));
  const e = match || ents[0];
  const socials = {};
  for (const [p, [name, url]] of Object.entries(SOCIAL)) { const v = claimValues(e, p)[0]; if (v) socials[name] = url(String(v)); }
  const wiki = e.sitelinks?.enwiki?.url || (e.sitelinks?.enwiki?.title ? `https://en.wikipedia.org/wiki/${encodeURIComponent(e.sitelinks.enwiki.title.replace(/ /g, "_"))}` : null);
  const website = sitesOf(e)[0] || null;
  const label = (x) => (typeof x === "string" ? x : x?.value) || null;
  return {
    found: true, id: e.id, url: `https://www.wikidata.org/wiki/${e.id}`,
    label: label(e.labels?.en), description: label(e.descriptions?.en),
    website, websiteMatches: !!(website && want && sitesOf(e).some((u) => hostOf(u) === want || hostOf(u).endsWith(`.${want}`))),
    instanceOf: claimValues(e, "P31").map((v) => v.id).filter(Boolean), inception: wdTime(claimValues(e, "P571")[0]),
    wikipedia: wiki, socials, candidates: ents.length,
  };
}

export async function knowledgeGraph(brand, key, ctx = {}) {
  const r = await http(ctx, `${KG}?${new URLSearchParams({ query: brand, key, limit: "5", types: "Organization", languages: "en" })}`, { headers: { accept: "application/json" } });
  if (r.status === 0) throw new Error(`Couldn't reach Google Knowledge Graph (${r.error}).`);
  const msg = clip(r.data?.error?.message);
  if (r.status === 400 && /api key/i.test(msg)) throw new Error("Google rejected the API key for the Knowledge Graph Search API.");
  if (r.status === 403) throw new Error(`Google refused the Knowledge Graph request${msg ? ` (${msg})` : ""}. Enable the Knowledge Graph Search API for this key's project.`);
  if (!r.ok) throw new Error(`Google Knowledge Graph error ${r.status}${msg ? `: ${msg}` : ""}`);
  const items = r.data?.itemListElement || [];
  const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const best = items.find((i) => norm(i.result?.name) === norm(brand)) || items[0];
  if (!best) return { found: false };
  const x = best.result || {};
  return { found: true, id: x["@id"] || null, name: x.name || null, description: x.description || x.detailedDescription?.articleBody?.slice(0, 300) || null, url: x.url || null, resultScore: best.resultScore ?? null, exactName: norm(x.name) === norm(brand) };
}

// ctx.orgSchema: Organization JSON-LD from the homepage (object), null = looked and found none, undefined = not checked.
function schemaInfo(org) {
  if (org === undefined) return undefined;
  if (!org || typeof org !== "object") return { present: false, sameAs: [] };
  const sameAs = [].concat(org.sameAs || []).filter((u) => typeof u === "string");
  return { present: true, name: org.name || org.legalName || null, url: org.url || null, sameAs };
}

const profileKey = (u) => {
  const h = hostOf(u), p = (() => { try { return new URL(u).pathname.replace(/\/+$/, "").toLowerCase(); } catch { return ""; } })();
  return `${h === "twitter.com" ? "x.com" : h}${p}`;
};

export async function collect(cfg = {}, ctx = {}) {
  const brand = ctx.brand || "", host = bareHost(ctx.host || hostOf(ctx.site));
  const errors = {};
  const [wdRes, kgRes] = await Promise.all([
    wikidata(brand, host, ctx).catch((e) => { errors.wikidata = e.message; return { found: false, error: e.message }; }),
    cfg.googleApiKey ? knowledgeGraph(brand, cfg.googleApiKey, ctx).catch((e) => { errors.knowledgeGraph = e.message; return { found: false, error: e.message }; }) : Promise.resolve(null),
  ]);
  const schema = schemaInfo(ctx.orgSchema);
  const wdProfiles = Object.entries(wdRes.socials || {}).filter(([k]) => k !== "blog");
  const sameKeys = new Set((schema?.sameAs || []).map(profileKey));
  const missingFromSchema = wdProfiles.filter(([, u]) => !sameKeys.has(profileKey(u))).map(([k]) => k);
  const nrm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");

  // [label, weight, pass (true/false/null = not applicable), why]
  const C = [];
  const add = (label, weight, pass, why) => C.push({ label, weight, pass, why });
  add("Has a Wikidata entry", 20, !!wdRes.found, wdRes.error ? `Couldn't check: ${wdRes.error}` : wdRes.found ? `${wdRes.id}: ${wdRes.label || ""}${wdRes.description ? ` (${wdRes.description})` : ""}` : `No Wikidata item found for "${brand}". Creating one (with official website, inception, socials) helps AI models identify you.`);
  add("Wikidata website matches your domain", 15, wdRes.found ? wdRes.websiteMatches : false, !wdRes.found ? "No Wikidata entry to check." : wdRes.websiteMatches ? `Official website (P856) is ${wdRes.website}` : wdRes.website ? `Wikidata lists ${wdRes.website}, not ${host}. This may be a different entity, or the website claim is outdated.` : "The Wikidata item has no official website (P856).");
  add("Wikidata links social profiles", 10, wdRes.found ? wdProfiles.length >= 2 : false, wdRes.found ? (wdProfiles.length ? `Linked: ${wdProfiles.map(([k]) => k).join(", ")}` : "No LinkedIn/X/Facebook/Crunchbase IDs on the Wikidata item.") : "No Wikidata entry to check.");
  add("Has an English Wikipedia article", 10, wdRes.found ? !!wdRes.wikipedia : false, wdRes.wikipedia ? wdRes.wikipedia : "No English Wikipedia sitelink on the Wikidata item.");
  add("Google Knowledge Graph recognises the brand", 20, kgRes ? !!(kgRes.found && (kgRes.exactName || (kgRes.url && hostOf(kgRes.url) === host))) : null,
    !kgRes ? "Add a Google API key to check the Knowledge Graph." : kgRes.error ? `Couldn't check: ${kgRes.error}` : kgRes.found ? `${kgRes.name}${kgRes.description ? ` (${kgRes.description})` : ""}, score ${kgRes.resultScore}` : "No Organization entity found in Google's Knowledge Graph.");
  add("Homepage has Organization schema", 10, schema ? schema.present : null, !schema ? "Homepage schema not checked." : schema.present ? `Organization JSON-LD found${schema.name ? ` (name: ${schema.name})` : ""}.` : "No Organization JSON-LD on the homepage. Add one with name, url, logo and sameAs.");
  add("Organization schema name and URL match", 5, schema?.present ? (nrm(schema.name) === nrm(brand) || nrm(schema.name).includes(nrm(brand))) && (!schema.url || hostOf(schema.url) === host) : schema ? false : null,
    !schema?.present ? "No Organization schema to check." : `Schema says "${schema.name || "?"}" at ${schema.url || "(no url)"}.`);
  add("Organization schema lists sameAs profiles", 10, schema ? schema.sameAs.length >= 2 : null, !schema ? "Homepage schema not checked." : schema.sameAs.length ? `${schema.sameAs.length} sameAs link${schema.sameAs.length === 1 ? "" : "s"}.` : "Add sameAs links to your LinkedIn, X, Crunchbase, Wikipedia/Wikidata profiles.");
  add("sameAs includes LinkedIn", 5, schema ? schema.sameAs.some((u) => /linkedin\.com\/company\//i.test(u)) : null, !schema ? "Homepage schema not checked." : "LinkedIn company pages are a strong identity signal for B2B brands.");
  add("sameAs links to Wikidata or Wikipedia", 5, schema ? schema.sameAs.some((u) => /wikidata\.org|wikipedia\.org/i.test(u)) : null, !schema ? "Homepage schema not checked." : wdRes.found ? `Add ${wdRes.url} to sameAs.` : "Link your Wikidata/Wikipedia page once it exists.");
  add("Schema sameAs agrees with Wikidata", 5, schema && wdRes.found && wdProfiles.length ? missingFromSchema.length === 0 : null,
    !(schema && wdRes.found && wdProfiles.length) ? "Needs both Wikidata socials and homepage schema." : missingFromSchema.length ? `Wikidata lists ${missingFromSchema.join(", ")} but your sameAs doesn't (or uses a different URL).` : "Every Wikidata profile is also in your sameAs.");

  const applicable = C.filter((c) => c.pass !== null);
  const total = applicable.reduce((s, c) => s + c.weight, 0), got = applicable.reduce((s, c) => s + (c.pass ? c.weight : 0), 0);
  return {
    brand, host, score: total ? Math.round((got / total) * 100) : 0,
    checks: C.map(({ label, pass, why }) => ({ label, pass, why })),
    wikidata: wdRes, knowledgeGraph: kgRes, schema: schema ?? null,
    ...(Object.keys(errors).length ? { errors } : {}),
  };
}

export async function test(cfg = {}, ctx = {}) {
  return safeTest(async () => {
    const r = await collect(cfg, ctx);
    const bits = [r.wikidata.found ? `Wikidata ${r.wikidata.id}${r.wikidata.websiteMatches ? " (website matches)" : ""}` : r.errors?.wikidata ? "Wikidata unreachable" : "no Wikidata entry"];
    if (r.knowledgeGraph) bits.push(r.knowledgeGraph.error ? `Knowledge Graph: ${r.knowledgeGraph.error}` : r.knowledgeGraph.found ? `Knowledge Graph: ${r.knowledgeGraph.name}` : "not in Knowledge Graph");
    return { ok: true, detail: `${bits.join("; ")}. Entity score ${r.score}/100.` };
  }).then((r) => (r.ok ? r : { ok: true, detail: `Entity check ran with errors: ${r.detail}` }));
}
