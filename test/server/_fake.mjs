// Fake AI handlers with the same SSE contract as api/ask.js, api/write.js and api/inspect.js.
import { sse, json } from "../../api/_lib.js";
const RIVALS = ["Deloitte", "Accenture", "IBM"];
export const fakes = {
  calls: { ask: 0, write: [], inspect: 0 },
  ask: async (req) => {
    const b = await req.json(); fakes.calls.ask++;
    return sse(async (send) => {
      const named = /bank/.test(b.question) && b.engine === "chatgpt";
      const brands = named ? ["Deloitte", b.brand.name, "IBM"] : RIVALS;
      const sources = [{ url: "https://clutch.co/ai", title: "Top AI partners", cited: true }, { url: `https://${b.engine}.example/${encodeURIComponent(b.question)}`, title: "x", cited: false }];
      send("search", { query: b.question + " 2026" }); sources.forEach((s) => send("source", s));
      send("delta", { text: `Options: ${brands.join(", ")}.` });
      send("final", { answer: `Options: ${brands.join(", ")}.`, sources, brands, model: "fake-1" });
    });
  },
  write: async (req) => {
    const { kind, data } = await req.json(); fakes.calls.write.push(kind);
    return sse(async (send) => {
      let t = "";
      if (kind === "sentiment") t = JSON.stringify(Object.fromEntries(data.items.map((it) => [it.id, Object.fromEntries(it.brands.map((x) => [x, 70]))])));
      else if (kind === "perception") t = JSON.stringify({ summary: "Known as a consultancy.", claims: [{ claim: "Based in London", verdict: "wrong", fix: "Say Austin" }] });
      else t = "- **Insight** one.";
      send("delta", { text: t }); send("final", { text: t });
    });
  },
  inspect: async (req) => { const b = await req.json(); fakes.calls.inspect++; return json({ ok: true, url: b.url, final: b.url, domain: new URL(b.url).hostname, title: "Top AI partners", you: false, rivals: ["Deloitte"], evidence: [], contacts: { emails: ["ed@clutch.co"] } }); },
};
export const WS = {
  slug: "acme", name: "Acme AI", site: "https://acme.ai", samples: 2,
  setup: { profile: { name: "Acme AI", site: "https://acme.ai", category: "ai consulting", competitors: RIVALS }, audit: { avg: 50, bots: { GPTBot: true } },
    questions: [{ text: "best ai partner for a bank", intent: "commercial", on: true }, { text: "top ai consultancies", intent: "informational", on: true }, { text: "skip me", on: false }], engines: ["chatgpt", "gemini"] },
};
