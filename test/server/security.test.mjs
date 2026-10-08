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
