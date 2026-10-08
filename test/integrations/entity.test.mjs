import { test } from "node:test";
import assert from "node:assert/strict";
import * as entity from "../../server/integrations/entity.mjs";
import { mockFetch, json } from "./_mock.mjs";

const WD = "https://www.wikidata.org/w/api.php";
const snak = (value, type = "string") => ({ mainsnak: { snaktype: "value", datavalue: { value, type } }, rank: "normal" });
const search = { searchinfo: { search: "Brand" }, search: [
  { id: "Q111", label: "Brand", description: "band from Ohio", concepturi: "http://www.wikidata.org/entity/Q111", match: { type: "label", language: "en", text: "Brand" } },
  { id: "Q222", label: "Brand", description: "American software company", concepturi: "http://www.wikidata.org/entity/Q222", match: { type: "label", language: "en", text: "Brand" } },
], success: 1 };
const entities = { entities: {
  Q111: { type: "item", id: "Q111", labels: { en: { language: "en", value: "Brand" } }, descriptions: { en: { language: "en", value: "band from Ohio" } }, claims: { P856: [snak("https://brandtheband.com")] }, sitelinks: {} },
  Q222: { type: "item", id: "Q222", labels: { en: { language: "en", value: "Brand" } }, descriptions: { en: { language: "en", value: "American software company" } },
    claims: {
      P856: [snak("https://www.brand.com/")], P31: [snak({ "entity-type": "item", "numeric-id": 4830453, id: "Q4830453" }, "wikibase-entityid")],
      P571: [snak({ time: "+2015-03-01T00:00:00Z", timezone: 0, before: 0, after: 0, precision: 10, calendarmodel: "http://www.wikidata.org/entity/Q1985727" }, "time")],
      P4264: [snak("brand-inc")], P2002: [snak("brandhq")], P2088: [snak("brand-inc")],
    },
    sitelinks: { enwiki: { site: "enwiki", title: "Brand (company)", badges: [], url: "https://en.wikipedia.org/wiki/Brand_(company)" } } },
}, success: 1 };
const kg = { "@context": { "@vocab": "http://schema.org/" }, "@type": "ItemList", itemListElement: [
  { "@type": "EntitySearchResult", result: { "@id": "kg:/g/11abc", name: "Brand", "@type": ["Organization", "Thing"], description: "Software company", url: "https://www.brand.com/" }, resultScore: 812.4 },
] };
const wdRoutes = [[(u) => u.startsWith(WD) && u.includes("wbsearchentities"), json(search)], [(u) => u.startsWith(WD) && u.includes("wbgetentities"), json(entities)]];
const ctx = (fetch, extra = {}) => ({ fetch, brand: "Brand", host: "brand.com", site: "https://brand.com", ...extra });

test("collect(): picks the Wikidata item whose website matches, reads claims, KG, schema", async () => {
  const fetch = mockFetch([...wdRoutes, ["https://kgsearch.googleapis.com/v1/entities:search", json(kg)]]);
  const orgSchema = { "@type": "Organization", name: "Brand", url: "https://brand.com", sameAs: ["https://www.linkedin.com/company/brand-inc", "https://twitter.com/brandhq"] };
  const r = await entity.collect({ googleApiKey: "GKEY" }, ctx(fetch, { orgSchema }));
  assert.equal(r.wikidata.id, "Q222");
  assert.equal(r.wikidata.websiteMatches, true);
  assert.equal(r.wikidata.inception, "2015-03");
  assert.deepEqual(r.wikidata.instanceOf, ["Q4830453"]);
  assert.deepEqual(r.wikidata.socials, { linkedin: "https://www.linkedin.com/company/brand-inc", crunchbase: "https://www.crunchbase.com/organization/brand-inc", x: "https://x.com/brandhq" });
  assert.equal(r.wikidata.wikipedia, "https://en.wikipedia.org/wiki/Brand_(company)");
  assert.deepEqual([r.knowledgeGraph.found, r.knowledgeGraph.name, r.knowledgeGraph.resultScore], [true, "Brand", 812.4]);
  const check = (l) => r.checks.find((c) => c.label === l);
  assert.equal(check("Has a Wikidata entry").pass, true);
  assert.equal(check("Google Knowledge Graph recognises the brand").pass, true);
  assert.equal(check("sameAs includes LinkedIn").pass, true);
  assert.equal(check("sameAs links to Wikidata or Wikipedia").pass, false);
  assert.equal(check("Schema sameAs agrees with Wikidata").pass, false); // crunchbase missing; twitter.com == x.com
  assert.match(check("Schema sameAs agrees with Wikidata").why, /crunchbase/);
  assert.ok(r.score > 70 && r.score < 100, String(r.score));

  // Wikidata etiquette + request shape
  const wd = fetch.calls.filter((c) => c.url.startsWith(WD));
  for (const c of wd) assert.match(c.headers["user-agent"], /WhitePetal\/1\.0 \(.+\)/);
  assert.equal(new URL(wd[0].url).searchParams.get("search"), "Brand");
  assert.equal(new URL(wd[1].url).searchParams.get("ids"), "Q111|Q222");
  const k = new URL(fetch.calls.find((c) => c.url.startsWith("https://kgsearch")).url).searchParams;
  assert.deepEqual([k.get("query"), k.get("key"), k.get("limit"), k.get("types")], ["Brand", "GKEY", "5", "Organization"]);
});

test("collect(): no Wikidata hit, no KG key, no schema → low score, N/A checks excluded", async () => {
  const fetch = mockFetch([[WD, json({ searchinfo: { search: "Nobody" }, search: [], success: 1 })]]);
  const r = await entity.collect({}, ctx(fetch, { brand: "Nobody" }));
  assert.equal(r.wikidata.found, false);
  assert.equal(r.knowledgeGraph, null);
  assert.equal(r.checks.find((c) => c.label === "Google Knowledge Graph recognises the brand").pass, null);
  assert.equal(r.score, 0);
  assert.equal(fetch.calls.length, 1);
});

test("test(): always ok:true, summarises what was found; bad KG key surfaces as detail", async () => {
  const fetch = mockFetch([...wdRoutes, ["https://kgsearch.googleapis.com/", json({ error: { code: 400, message: "API key not valid. Please pass a valid API key.", status: "INVALID_ARGUMENT" } }, 400)]]);
  const r = await entity.test({ googleApiKey: "BAD" }, ctx(fetch));
  assert.equal(r.ok, true);
  assert.match(r.detail, /Wikidata Q222 \(website matches\)/);
  assert.match(r.detail, /Google rejected the API key/);
  const down = await entity.test({}, ctx(mockFetch([[WD, json({}, 503)]])));
  assert.equal(down.ok, true);
  assert.match(down.detail, /Wikidata unreachable/);
});
