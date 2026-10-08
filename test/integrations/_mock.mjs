// Tiny fetch mock for integration tests: routes are [match, respond] pairs.
// match: string (URL prefix), RegExp, or (url, init) => bool. respond: Response | data | (url, init, call) => Response | data.
// Non-Response data is sent as JSON with status 200. Unmatched requests fail loudly (status 599).
export const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", ...headers } });
export const text = (body, status = 200) => new Response(body, { status, headers: { "content-type": "text/plain" } });

export function mockFetch(routes) {
  const calls = [];
  const f = async (url, init = {}) => {
    url = String(url);
    const headers = Object.fromEntries(Object.entries(init.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
    let body = init.body; try { body = JSON.parse(init.body); } catch { /* keep raw */ }
    const call = { url, method: init.method || "GET", headers, body, rawBody: init.body, signal: init.signal };
    calls.push(call);
    for (const [m, res] of routes) {
      const hit = typeof m === "string" ? url.startsWith(m) : m instanceof RegExp ? m.test(url) : m(url, init);
      if (!hit) continue;
      const out = typeof res === "function" ? await res(url, init, call) : res;
      return out instanceof Response ? out.clone() : json(out); // clone so a static Response can serve repeated calls
    }
    return text(`unmocked ${url}`, 599);
  };
  f.calls = calls;
  return f;
}
