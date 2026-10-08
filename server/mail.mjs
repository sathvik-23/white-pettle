// Transactional email through Resend (https://resend.com/docs/api-reference/emails/send-email).
// Without RESEND_API_KEY nothing is sent: the message is logged, and the caller still gets the link
// (the invite and reset routes return it to the person who asked), so local dev and a fresh deploy keep working.
import { esc } from "./util.mjs";

const FROM = () => process.env.EMAIL_FROM || "White Petal <no-reply@whitepetal.perfstaq.com>";
let sender = null; // tests swap in a fake (setSender)
export function setSender(fn) { sender = fn; }

export async function send({ to, subject, text, html }) {
  if (sender) return sender({ to, subject, text, html });
  const key = process.env.RESEND_API_KEY;
  if (!key) { console.log(`[mail] RESEND_API_KEY not set; not sending "${subject}" to ${to}\n${text}`); return { sent: false, reason: "not configured" }; }
  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ from: FROM(), to: [to], subject, text, html }),
    });
    if (!r.ok) { const d = await r.json().catch(() => ({})); console.warn(`[mail] Resend ${r.status}: ${d.message || d.name || ""}`); return { sent: false, reason: d.message || `Resend error ${r.status}` }; }
    return { sent: true };
  } catch (e) { console.warn("[mail] send failed:", e.message); return { sent: false, reason: e.message }; }
}

const shell = (title, body, cta, link) => `<!doctype html><html><body style="margin:0;background:#f6f6f4;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#151515">
<div style="max-width:520px;margin:32px auto;background:#fff;border:1px solid #e6e6e2;border-radius:12px;padding:28px">
<p style="margin:0 0 18px;font-weight:600;font-size:15px">White Petal</p>
<h1 style="margin:0 0 12px;font-size:20px;line-height:1.3">${esc(title)}</h1>
<div style="font-size:15px;line-height:1.55;color:#333">${body}</div>
<p style="margin:24px 0"><a href="${esc(link)}" style="background:#FF7A1A;color:#fff;text-decoration:none;padding:11px 18px;border-radius:8px;font-weight:600;display:inline-block">${esc(cta)}</a></p>
<p style="font-size:12px;color:#888;word-break:break-all">Or paste this link into your browser: ${esc(link)}</p>
</div></body></html>`;

const ROLE_WORDS = { owner: "the owner", admin: "an admin", editor: "an editor", viewer: "a viewer" };

export function inviteEmail({ to, orgName, role, inviter, link }) {
  const who = inviter ? `${inviter} invited you` : "You've been invited";
  const subject = `${inviter || "Someone"} invited you to ${orgName} on White Petal`;
  const text = `${who} to join ${orgName} on White Petal as ${ROLE_WORDS[role] || role}.\n\nWhite Petal tracks how ChatGPT, Perplexity and Gemini talk about the brand, and what to do about it.\n\nAccept the invite (the link works for 7 days, once):\n${link}\n`;
  const html = shell(`Join ${orgName} on White Petal`, `<p>${esc(who)} to join <b>${esc(orgName)}</b> as ${esc(ROLE_WORDS[role] || role)}.</p><p>White Petal tracks how ChatGPT, Perplexity and Gemini talk about the brand, and what to do about it. The link works for 7 days, once.</p>`, "Accept the invite", link);
  return send({ to, subject, text, html });
}

export function resetEmail({ to, link }) {
  const subject = "Reset your White Petal password";
  const text = `Someone asked to reset the password for this email on White Petal. If it was you, set a new one here (the link works for 1 hour, once):\n${link}\n\nIf it wasn't you, ignore this email; nothing changes.\n`;
  const html = shell("Reset your password", "<p>Someone asked to reset the password for this email on White Petal. If it was you, set a new one below. The link works for 1 hour, once.</p><p>If it wasn't you, ignore this email; nothing changes.</p>", "Set a new password", link);
  return send({ to, subject, text, html });
}

export function verifyEmail({ to, link }) {
  const subject = "Confirm your email for White Petal";
  const text = `Confirm that this is your email address for White Petal (the link works for 3 days, once):\n${link}\n\nIf you didn't sign up, ignore this email.\n`;
  const html = shell("Confirm your email", "<p>Confirm that this is your email address for White Petal. The link works for 3 days, once.</p><p>If you didn't sign up, ignore this email.</p>", "Confirm my email", link);
  return send({ to, subject, text, html });
}
