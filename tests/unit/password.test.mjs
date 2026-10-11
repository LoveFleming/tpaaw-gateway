/**
 * Unit tests — Password module (src/server/password.mjs)
 * TASK-018 / ISS-002 / framework: node:test
 *
 * Covers: bcrypt hashing, verification, legacy-plaintext (constant-time)
 * support, needsRehash classification, weak-default detection, and the
 * env-based credential override used to avoid a shipped default password.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  BCRYPT_ROUNDS,
  isHashed,
  needsRehash,
  isWeakDefaultPassword,
  hashPassword,
  hashPasswordSync,
  verifyPassword,
  consumeDummyVerify,
  applyPasswordOverride,
} from "../../src/server/password.mjs";

test("hashPassword produces a bcrypt hash that is not the plaintext", async () => {
  const hash = await hashPassword("correct horse battery staple");
  assert.match(hash, /^\$2[aby]?\$\d{2}\$/);
  assert.notEqual(hash, "correct horse battery staple");
  assert.equal(isHashed(hash), true);
  assert.equal(needsRehash(hash), false, "freshly hashed at BCRYPT_ROUNDS needs no rehash");
  assert.equal(parseInt(hash.split("$")[2], 10), BCRYPT_ROUNDS);
});

test("hashPasswordSync matches the async contract", () => {
  const hash = hashPasswordSync("sync-secret");
  assert.equal(isHashed(hash), true);
});

test("hashPassword rejects empty / non-string input", async () => {
  await assert.rejects(() => hashPassword(""), TypeError);
  await assert.rejects(() => hashPassword(undefined), TypeError);
  assert.throws(() => hashPasswordSync(123), TypeError);
});

test("verifyPassword: correct → true, wrong → false (bcrypt path)", async () => {
  const hash = await hashPassword("s3cret!");
  assert.equal(await verifyPassword("s3cret!", hash), true);
  assert.equal(await verifyPassword("s3cret?", hash), false);
  assert.equal(await verifyPassword("", hash), false);
});

test("verifyPassword supports legacy plaintext with constant-time compare", async () => {
  assert.equal(await verifyPassword("legacy-pw", "legacy-pw"), true);
  assert.equal(await verifyPassword("legacy-pw", "legacy-pX"), false);
  // legacy value is not a hash → must be flagged for rehash on next login
  assert.equal(needsRehash("legacy-pw"), true);
});

test("verifyPassword fails closed on malformed stored values", async () => {
  assert.equal(await verifyPassword("x", ""), false);
  assert.equal(await verifyPassword("x", null), false);
  assert.equal(await verifyPassword(null, "$2b$12$abc"), false);
});

test("isWeakDefaultPassword flags obvious shipped defaults (plaintext only)", () => {
  for (const w of ["change_me", "CHANGEME", "change-me", "password", "admin", "paaw"]) {
    assert.equal(isWeakDefaultPassword(w), true, `${w} must be flagged`);
  }
  assert.equal(isWeakDefaultPassword("a-real-strong-one"), false);
  // a bcrypt hash is never "weak" — the plaintext is not visible
  assert.equal(isWeakDefaultPassword("$2b$12$abcdefghijklmnopqrstuv"), false);
});

test("consumeDummyVerify always resolves false and never throws", async () => {
  assert.equal(await consumeDummyVerify("anything"), false);
  assert.equal(await consumeDummyVerify(undefined), false);
  assert.equal(await consumeDummyVerify(""), false);
});

test("applyPasswordOverride: PAAW_GATEWAY_PASSWORD hashes and sets the admin user", () => {
  const config = { users: [{ id: "admin", name: "Admin", role: "admin" }] };
  applyPasswordOverride(config, { PAAW_GATEWAY_PASSWORD: "brand-new-pw" });
  assert.equal(isHashed(config.users[0].passwordHash), true);
  assert.equal(isWeakDefaultPassword(config.users[0].passwordHash), false);
});

test("applyPasswordOverride: PAAW_GATEWAY_PASSWORD_HASH is used verbatim", async () => {
  const ready = await hashPassword("env-hash-pw");
  const config = { users: [{ id: "admin", name: "Admin", role: "admin" }] };
  applyPasswordOverride(config, { PAAW_GATEWAY_PASSWORD_HASH: ready });
  assert.equal(config.users[0].passwordHash, ready);
});

test("applyPasswordOverride: rejects a non-hash value for the HASH knob", () => {
  const config = { users: [] };
  assert.throws(
    () => applyPasswordOverride(config, { PAAW_GATEWAY_PASSWORD_HASH: "not-a-hash" }),
    /bcrypt hash/,
  );
});

test("applyPasswordOverride: no-op when neither env var is set", () => {
  const config = { users: [{ id: "admin", passwordHash: "unchanged" }] };
  applyPasswordOverride(config, {});
  assert.equal(config.users[0].passwordHash, "unchanged");
});

test("applyPasswordOverride: creates the target user if it does not exist", () => {
  const config = { users: [] };
  applyPasswordOverride(config, { PAAW_GATEWAY_PASSWORD: "pw", PAAW_GATEWAY_ADMIN_ID: "root" });
  assert.equal(config.users.length, 1);
  assert.equal(config.users[0].id, "root");
  assert.equal(isHashed(config.users[0].passwordHash), true);
});
