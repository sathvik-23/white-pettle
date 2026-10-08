// Slack incoming webhook (free): White Petal posts visibility alerts to a channel.
// https://api.slack.com/messaging/webhooks  Block Kit: https://api.slack.com/reference/block-kit/blocks
import { http, safeTest, clip } from "./_http.mjs";

export const meta = {
  id: "slack",
  name: "Slack",
  category: "alerts",
  auth: "key",
  free: true,
  fields: [
    { key: "webhookUrl", label: "Incoming webhook URL", secret: true, placeholder: "https://hooks.slack.com/services/T…/B…/…", help: "api.slack.com/apps → Create app → Incoming Webhooks → Activate → Add New Webhook to Workspace → pick a channel → copy the URL." },
  ],
  blurb: "Posts a Slack message when your AI visibility changes, a competitor overtakes you, or a weekly report is ready.",
  docs: "https://api.slack.com/messaging/webhooks",
};

// Slack answers webhooks with plain-text codes.
const ERRORS = {
  invalid_payload: "Slack rejected the message format.", no_text: "Slack rejected the message (no text).",
  invalid_token: "Slack rejected the webhook URL (invalid token). Create a new webhook.", no_service: "This Slack webhook was removed or disabled. Create a new one.",
  no_team: "The Slack workspace for this webhook no longer exists.", team_disabled: "The Slack workspace for this webhook is disabled.",
  channel_not_found: "The webhook's Slack channel no longer exists.", channel_is_archived: "The webhook's Slack channel is archived.",
  action_prohibited: "A Slack admin has blocked posting to this channel.", posting_to_general_channel_denied: "Only admins can post to that channel.",
  too_many_attachments: "Slack rejected the message (too many attachments).",
};

async function post(cfg, ctx, payload) {
  const url = String(cfg?.webhookUrl || "").trim();
  if (!/^https:\/\/hooks\.slack(-gov)?\.com\//.test(url)) throw new Error("That doesn't look like a Slack incoming webhook URL (https://hooks.slack.com/…).");
  const r = await http(ctx, url, { method: "POST", json: payload });
  if (r.status === 0) throw new Error(`Couldn't reach Slack (${r.error}).`);
  const code = clip(r.text, 60);
  if (r.ok) return true;
  if (r.status === 429) throw new Error("Slack is rate-limiting this webhook. Try again in a minute.");
  throw new Error(ERRORS[code] || `Slack error ${r.status}${code ? `: ${code}` : ""}`);
}

const cut = (s, n) => { s = String(s ?? ""); return s.length > n ? `${s.slice(0, n - 1)}…` : s; };

// Build Block Kit: header (plain_text ≤150) + section mrkdwn (≤3000) + optional link button. `text` is the notification fallback.
export function buildMessage({ title = "White Petal", lines = [], url } = {}) {
  const body = cut([].concat(lines).filter((l) => l != null && l !== "").join("\n"), 3000);
  const blocks = [{ type: "header", text: { type: "plain_text", text: cut(title, 150), emoji: true } }];
  if (body) blocks.push({ type: "section", text: { type: "mrkdwn", text: body } });
  if (url) blocks.push({ type: "actions", elements: [{ type: "button", text: { type: "plain_text", text: "Open in White Petal" }, url }] });
  return { text: cut(`${title}${body ? `: ${body.split("\n")[0]}` : ""}`, 300), blocks };
}

export async function notify(cfg, msg, ctx = {}) {
  try { await post(cfg, ctx, buildMessage(msg)); return { ok: true, detail: "Posted to Slack." }; }
  catch (e) { return { ok: false, detail: e.message }; }
}

export async function test(cfg, ctx = {}) {
  return safeTest(async () => {
    await post(cfg, ctx, buildMessage({ title: "White Petal connected", lines: [`Alerts${ctx.brand ? ` for *${ctx.brand}*` : ""} will be posted to this channel.`] }));
    return { ok: true, detail: "Sent a test message to Slack." };
  });
}

// Nothing to collect: Slack is an output-only integration.
export async function collect() { return { connected: true }; }
