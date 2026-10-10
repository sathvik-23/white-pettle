// Where configuration comes from, in order: the real environment, then (locally) .env.local / .env,
// then (on Cloud Run) Secret Manager. Loaded once, before anything reads process.env.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Must match infra/terraform/secrets.tf `secret_names` exactly. Each lives in Secret Manager as WHITEPETAL_<NAME>.
export const SECRET_NAMES = ["DATABASE_URL", "APP_SECRET", "CRON_SECRET", "OPENAI_API_KEY", "GEMINI_API_KEY", "PERPLEXITY_API_KEY", "GROQ_API_KEY", "ANTHROPIC_API_KEY",
  "GOOGLE_OAUTH_CLIENT_ID", "GOOGLE_OAUTH_CLIENT_SECRET", "GOOGLE_API_KEY", "DATAFORSEO_LOGIN", "DATAFORSEO_PASSWORD", "SERPAPI_KEY", "ACCESS_CODE", "RESEND_API_KEY",
  "RAZORPAY_KEY_ID", "RAZORPAY_KEY_SECRET", "RAZORPAY_WEBHOOK_SECRET"];

// `vercel env pull` writes "[SENSITIVE]" for values it may not reveal. Treat that as unset, never as a key.
const usable = (v) => v && v.trim() && !/^\[?SENSITIVE\]?$/i.test(v.trim());

export function loadDotenv() {
  for (const f of [".env.local", ".env"]) {
    const p = path.join(ROOT, f); if (!fs.existsSync(p)) continue;
    for (const line of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/); if (!m) continue;
      const v = m[2].replace(/^["']|["']$/g, "");
      if (usable(v) && !usable(process.env[m[1]])) process.env[m[1]] = v;
    }
  }
  for (const k of Object.keys(process.env)) if (!usable(process.env[k]) && /\[SENSITIVE\]/i.test(process.env[k] || "")) delete process.env[k];
}

// Secret Manager without the client library: the metadata server hands out a token for the runtime service
// account, and the REST API returns the latest version. A secret with no version yet is skipped, so a missing
// optional key never stops the service from booting (unlike a Cloud Run secret mount, which refuses to start).
export async function loadGsmSecrets() {
  if (process.env.SECRETS_FROM_GSM !== "1") return [];
  const project = process.env.GCP_PROJECT || process.env.GOOGLE_CLOUD_PROJECT;
  if (!project) { console.warn("[secrets] SECRETS_FROM_GSM=1 but GCP_PROJECT is not set"); return []; }
  let token;
  try {
    const r = await fetch("http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token", { headers: { "Metadata-Flavor": "Google" } });
    token = (await r.json()).access_token;
  } catch (e) { console.warn("[secrets] metadata server unreachable:", e.message); return []; }
  const loaded = [];
  await Promise.all(SECRET_NAMES.map(async (name) => {
    if (usable(process.env[name])) return; // an explicit env var wins
    try {
      const r = await fetch(`https://secretmanager.googleapis.com/v1/projects/${project}/secrets/WHITEPETAL_${name}/versions/latest:access`, { headers: { authorization: `Bearer ${token}` } });
      if (!r.ok) return; // 404: no version yet; 403: not granted. Either way the feature it powers stays off.
      const d = await r.json(); const v = Buffer.from(d.payload?.data || "", "base64").toString("utf8").trim();
      if (usable(v)) { process.env[name] = v; loaded.push(name); }
    } catch {}
  }));
  console.log(`[secrets] loaded ${loaded.length} from Secret Manager: ${loaded.sort().join(", ") || "none"}`);
  return loaded;
}
