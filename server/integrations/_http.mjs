// Shared HTTP helper for White Petal integrations.
// - Always goes through (ctx.fetch || fetch) so tests can inject a mock.
// - 15s timeout via AbortController.
// - Never throws: returns { ok, status, data, text, error }. status 0 = network error / timeout.
// - Parses JSON defensively (data = null when the body isn't JSON).
// Never put secrets in error strings: callers build messages from status + provider message only.
export const TIMEOUT_MS = 15000;
export const UA = "WhitePetal/1.0 (AI visibility monitoring; +https://whitepetal.ai)";

export async function http(ctx, url, { method = "GET", headers = {}, json, body, timeout = TIMEOUT_MS } = {}) {
  const f = ctx?.fetch || fetch;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeout);
  const init = { method, headers: { ...headers }, signal: ac.signal };
  if (json !== undefined) { init.body = JSON.stringify(json); init.headers["content-type"] ??= "application/json"; }
  else if (body !== undefined) init.body = body;
  try {
    const r = await f(url, init);
    const text = await r.text().catch(() => "");
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
    return { ok: r.ok, status: r.status, data, text, headers: r.headers };
  } catch (e) {
    const error = e?.name === "AbortError" ? `timed out after ${timeout / 1000}s` : (e?.cause?.code || e?.message || "network error");
    return { ok: false, status: 0, data: null, text: "", error };
  } finally { clearTimeout(timer); }
}

// Wrap a test() body so it never throws.
export async function safeTest(fn) {
  try { return await fn(); } catch (e) { return { ok: false, detail: String(e?.message || e) }; }
}

export const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, "").toLowerCase(); } catch { return ""; } };
export const bareHost = (h) => String(h || "").toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/^www\./, "");
// Short, single-line excerpt of a provider's error text for messages.
export const clip = (s, n = 160) => String(s || "").replace(/\s+/g, " ").trim().slice(0, n);
export const isoDay = (d) => d.toISOString().slice(0, 10);
export const daysAgo = (n, from = new Date()) => new Date(from.getTime() - n * 864e5);
