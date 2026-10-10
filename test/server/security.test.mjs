import { test } from "node:test";
import assert from "node:assert/strict";
import { hashPassword, verifyPassword, seal, unseal, tokenId, limited, safeEqual } from "../../server/security.mjs";

test("passwords hash with scrypt and verify only the right one", async () => {
  const h = await hashPassword("correct horse");
  assert.match(h, /^scrypt\$16384\$/);
  assert.equal(await verifyPassword("correct horse", h), true);
  assert.equal(await verifyPassword("wrong horse", h), false);
  assert.equal(await verifyPassword("x", "garbage"), false);
});
test("sealed secrets round-trip and tampering is rejected", () => {
  process.env.APP_SECRET = "test-secret";
  const s = seal({ apiKey: "sk-123" });
  assert.deepEqual(unseal(s), { apiKey: "sk-123" });
  assert.ok(!s.includes("sk-123"));
  const parts = s.split("."); parts[3] = parts[3].slice(0, -2) + (parts[3].endsWith("A") ? "BB" : "AA");
  assert.deepEqual(unseal(parts.join(".")), {});
  process.env.APP_SECRET = "rotated"; assert.deepEqual(unseal(s), {}); // a rotated key reads as "not connected", never a crash
});
test("session ids are hashes, limiter trips, safeEqual is strict", () => {
  assert.equal(tokenId("abc").length, 64);
  for (let i = 0; i < 3; i++) assert.equal(limited("k", 3), false);
  assert.equal(limited("k", 3), true);
  assert.equal(safeEqual("a", "a"), true); assert.equal(safeEqual("a", "b"), false); assert.equal(safeEqual("", ""), false);
});

test("billing secrets are loaded, provisioned and settable, each exactly once", async () => {
  const fs = await import("node:fs");
  const { SECRET_NAMES } = await import("../../server/env.mjs");
  const tf = fs.readFileSync(new URL("../../infra/terraform/secrets.tf", import.meta.url), "utf8");
  const tfNames = [...tf.match(/secret_names = toset\(\[([\s\S]*?)\]\)/)[1].matchAll(/"([A-Z0-9_]+)"/g)].map((m) => m[1]);
  const sh = fs.readFileSync(new URL("../../infra/secrets.sh", import.meta.url), "utf8");
  const manual = sh.match(/MANUAL_KEYS="([^"]*)"/)[1].split(/\s+/), tfKeys = sh.match(/TF_KEYS="([^"]*)"/)[1].split(/\s+/);
  for (const key of ["RAZORPAY_KEY_ID", "RAZORPAY_KEY_SECRET", "RAZORPAY_WEBHOOK_SECRET"]) {
    assert.equal(SECRET_NAMES.filter((x) => x === key).length, 1, key);
    assert.equal(tfNames.filter((x) => x === key).length, 1, key);
    assert.equal(manual.filter((x) => x === key).length, 1, key);
  }
  assert.deepEqual([...tfNames].sort(), [...SECRET_NAMES].sort(), "secrets.tf and env.mjs must list the same names");
  assert.deepEqual([...manual, ...tfKeys].sort(), [...SECRET_NAMES].sort(), "secrets.sh must cover every name");
});

test("the example environment documents billing off by default, with no values", async () => {
  const fs = await import("node:fs");
  const ex = fs.readFileSync(new URL("../../.env.example", import.meta.url), "utf8");
  assert.match(ex, /^BILLING_ENABLED=0$/m);
  for (const k of ["RAZORPAY_KEY_ID", "RAZORPAY_KEY_SECRET", "RAZORPAY_WEBHOOK_SECRET", "RAZORPAY_PLAN_STARTER_USD", "RAZORPAY_PLAN_GROWTH_INR", "RAZORPAY_PLAN_AGENCY_INR"]) assert.match(ex, new RegExp(`^${k}=$`, "m"), k);
});
