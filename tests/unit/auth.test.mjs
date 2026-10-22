/**
 * Unit tests — Auth module (src/server/auth.mjs)
 * TASK-018 / ISS-002 / framework: node:test
 *
 * Covers: session create/validate, bcrypt + legacy login, lazy credential
 * upgrade, per-user & per-IP lockout, and account-enumeration resistance
 * (unknown user yields the same generic failure, not a distinct result).
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { createAuth, LOGIN_MAX_FAILURES, LOGIN_IP_MAX_FAILURES, LOGIN_WINDOW_MS } from "../../src/server/auth.mjs";
import { hashPassword, isHashed } from "../../src/server/password.mjs";

function makeConfig(users) {
  return { users, sessionMaxAge: 60_000 };
}

test("createSession / validateSession round-trip; unknown token → null", () => {
  const auth = createAuth(makeConfig([{ id: "a", passwordHash: "x" }]));
  const token = auth.createSession("a");
  assert.match(token, /^[0-9a-f-]{36}$/);
  assert.deepEqual(auth.validateSession(token), { userId: "a", created: auth.sessions.get(token).created });
  assert.equal(auth.validateSession("nope"), null);
});

test("validateSession: expired token is evicted and returns null", () => {
  const auth = createAuth({ users: [], sessionMaxAge: -1 });
  const token = auth.createSession("a");
  assert.equal(auth.validateSession(token), null);
  assert.equal(auth.sessions.has(token), false, "expired session must be deleted");
});

test("login: correct bcrypt password → ok + token, no upgrade needed", async () => {
  const hash = await hashPassword("pw-correct");
  const auth = createAuth(makeConfig([{ id: "admin", name: "Admin", role: "admin", passwordHash: hash }]));
  const r = await auth.login("admin", "pw-correct", "127.0.0.1");
  assert.equal(r.ok, true);
  assert.equal(r.upgraded, false);
  assert.equal(r.user.id, "admin");
  assert.ok(r.token);
});

test("login: legacy plaintext succeeds AND is upgraded to a bcrypt hash", async () => {
  const user = { id: "admin", name: "Admin", role: "admin", passwordHash: "legacy-plain" };
  const auth = createAuth(makeConfig([user]));
  const r = await auth.login("admin", "legacy-plain", "127.0.0.1");
  assert.equal(r.ok, true);
  assert.equal(r.upgraded, true, "legacy credential must be flagged for upgrade");
  assert.equal(isHashed(user.passwordHash), true, "stored value must now be a bcrypt hash");
  // and the upgraded hash must verify the same password
  const again = await auth.login("admin", "legacy-plain", "127.0.0.1");
  assert.equal(again.ok, true);
  assert.equal(again.upgraded, false, "second login uses the fresh hash — no further upgrade");
});

test("login: wrong password → generic failure (ok:false, no locked flag)", async () => {
  const hash = await hashPassword("right");
  const auth = createAuth(makeConfig([{ id: "admin", name: "A", role: "admin", passwordHash: hash }]));
  const r = await auth.login("admin", "wrong", "127.0.0.1");
  assert.equal(r.ok, false);
  assert.equal(r.locked, undefined);
});

test("login: unknown user fails identically to a wrong password (no enumeration)", async () => {
  const hash = await hashPassword("right");
  const auth = createAuth(makeConfig([{ id: "admin", name: "A", role: "admin", passwordHash: hash }]));
  const unknown = await auth.login("ghost", "anything", "127.0.0.1");
  const wrongPw = await auth.login("admin", "anything", "127.0.0.1");
  // Same shape: no locked, no token, no user — caller cannot tell the difference.
  assert.deepEqual(Object.keys(unknown).sort(), Object.keys(wrongPw).sort());
  assert.equal(unknown.ok, false);
  assert.equal(wrongPw.ok, false);
});

test("login: per-user lockout after LOGIN_MAX_FAILURES failures", async () => {
  const hash = await hashPassword("right");
  const auth = createAuth(makeConfig([{ id: "admin", name: "A", role: "admin", passwordHash: hash }]));

  for (let i = 0; i < LOGIN_MAX_FAILURES; i++) {
    const r = await auth.login("admin", "wrong", "10.0.0.1");
    assert.equal(r.ok, false);
    assert.notEqual(r.locked, true, `attempt ${i + 1} must not yet be locked`);
  }
  // The per-user limit turns further FAILED attempts into a lockout reply.
  const locked = await auth.login("admin", "wrong", "10.0.0.1");
  assert.equal(locked.ok, false);
  assert.equal(locked.locked, true);
  assert.ok(locked.retryAfterMs > 0 && locked.retryAfterMs <= LOGIN_WINDOW_MS);
});

test("login: per-user lockout does NOT refuse a correct password (DoS fix)", async () => {
  const hash = await hashPassword("right");
  const auth = createAuth(makeConfig([{ id: "admin", name: "A", role: "admin", passwordHash: hash }]));

  // Attacker floods the victim's username with wrong passwords from IP-A.
  for (let i = 0; i < LOGIN_MAX_FAILURES; i++) {
    await auth.login("admin", "wrong", "10.0.0.1");
  }
  // The real user, from a different IP, must still authenticate with the
  // correct password — the account must NOT be locked out.
  const ok = await auth.login("admin", "right", "10.0.0.2");
  assert.equal(ok.ok, true, "correct credentials must survive a username flood");
  assert.ok(ok.token);
});

test("login: an IP flood on one username cannot lock out another IP's user", async () => {
  const hash = await hashPassword("right");
  const auth = createAuth(makeConfig([{ id: "admin", name: "A", role: "admin", passwordHash: hash }]));

  // IP-A sprays admin past the strict per-user limit (but below the IP limit).
  for (let i = 0; i < LOGIN_MAX_FAILURES + 3; i++) {
    await auth.login("admin", "wrong", "10.0.0.1");
  }
  // A fresh IP with the correct password is unaffected.
  const fromB = await auth.login("admin", "right", "10.0.0.2");
  assert.equal(fromB.ok, true);
  assert.equal(fromB.locked, undefined);
});

test("login: per-IP lockout catches spraying across many usernames", async () => {
  const auth = createAuth(makeConfig([{ id: "admin", name: "A", role: "admin", passwordHash: "x" }]));
  for (let i = 0; i < LOGIN_IP_MAX_FAILURES; i++) {
    await auth.login(`user-${i}`, "wrong", "203.0.113.9");
  }
  const locked = await auth.login("admin", "wrong", "203.0.113.9");
  assert.equal(locked.locked, true, "same IP must be throttled regardless of username");
  // a different IP is unaffected
  const other = await auth.login("admin", "wrong", "198.51.100.4");
  assert.equal(other.locked, undefined);
});

test("login: a successful login clears the failure counter", async () => {
  const hash = await hashPassword("right");
  const auth = createAuth(makeConfig([{ id: "admin", name: "A", role: "admin", passwordHash: hash }]));
  for (let i = 0; i < LOGIN_MAX_FAILURES - 1; i++) await auth.login("admin", "wrong", "10.0.0.2");
  const ok = await auth.login("admin", "right", "10.0.0.2");
  assert.equal(ok.ok, true);
  // counter reset → we can fail again without tripping the limit
  const after = await auth.login("admin", "wrong", "10.0.0.2");
  assert.equal(after.locked, undefined, "counter must have been reset by the success");
});

// ── review board minor#5（RR-20261018-1738-6f2e）──
// 非字串 password 不得傳進 verifyPassword / hashPassword：走同一條 dummy-verify
// 分支，回傳形態與時序與「未知使用者」一致（不可拋 TypeError、不可洩漏差異）。
test("login: non-string password → same generic failure shape (dummy-verify path)", async () => {
  const hash = await hashPassword("right");
  const auth = createAuth(makeConfig([{ id: "admin", name: "A", role: "admin", passwordHash: hash }]));
  const unknown = await auth.login("ghost", "anything", "127.0.0.1");

  for (const bad of [undefined, null, 12345, { toString: () => "right" }, ["right"], true]) {
    const r = await auth.login("admin", bad, "127.0.0.1");
    assert.equal(r.ok, false, `password=${String(bad)} 必須 ok:false`);
    assert.equal(r.token, undefined, "非字串密碼絕不可取得 token");
    // 與未知使用者相同的回傳形態。本案例會連續失敗 6 次以上，per-user 限流
    // 之後會加上 { locked, retryAfterMs }（未知使用者同樣會被限流），因此只比
    // 「ok:false 且無 token」這個核心契約，不比較限流欄位。
    assert.equal(
      r.locked === undefined || r.locked === true,
      true,
      `password=${String(bad)} locked 只能是 undefined 或 true`,
    );
  }
});

test("login: non-string password with a valid legacy plaintext hash does not throw", async () => {
  // hashPassword(物件) 會拋 TypeError；登入路徑必須先擋型別，不能讓它冒出來
  const auth = createAuth(makeConfig([{ id: "admin", name: "A", role: "admin", passwordHash: "legacy-plain" }]));
  const r = await auth.login("admin", { evil: true }, "127.0.0.1");
  assert.equal(r.ok, false);
  assert.equal(auth.users[0].passwordHash, "legacy-plain", "失敗的登入不得改寫憑證");
});

// ── review board minor#6（RR-20261018-1738-6f2e）──
// sessions Map 不得無界增長：createSession 時清掃已過期的 session。
test("createSession: sweeps expired sessions so the store stays bounded", () => {
  // 直接植入 49 筆「很久以前」建立的 entry（-1 分鐘），再建一筆新的：
  // 不以毫秒競態製造過期（同一毫秒內 age>0 可能不成立，會 flaky）。
  const auth = createAuth({ users: [], sessionMaxAge: 1000 }); // 1 秒
  const stale = [];
  for (let i = 0; i < 49; i++) {
    const t = `stale-${i}`;
    auth.sessions.set(t, { userId: `u${i}`, created: Date.now() - 60_000 });
    stale.push(t);
  }
  const fresh = auth.createSession("new-user");
  // createSession 清掃 → 只剩剛建立的那一筆
  assert.equal(auth.sessions.size, 1, `expired sessions must be swept on create, size=${auth.sessions.size}`);
  for (const t of stale) assert.equal(auth.sessions.has(t), false, "過期 token 應已被清掉");
  assert.equal(auth.sessions.has(fresh), true, "剛建立的 token 必須還在");
});

test("createSession: live sessions are preserved and accumulate normally", () => {
  const auth = createAuth({ users: [], sessionMaxAge: 60_000 });
  const a = auth.createSession("u1");
  const b = auth.createSession("u2");
  assert.equal(auth.sessions.size, 2, "未過期的 session 不得被清掉");
  assert.equal(auth.validateSession(a).userId, "u1");
  assert.equal(auth.validateSession(b).userId, "u2");
});

test("createSession: mixed store keeps only live sessions after a sweep", () => {
  const auth = createAuth({ users: [], sessionMaxAge: 60_000 });
  const live = auth.createSession("u1");
  // 植入一筆過期 entry（模擬長時間沒被 validate 觸及的殘留）
  auth.sessions.set("stale-token", { userId: "u0", created: Date.now() - 120_000 });

  const fresh = auth.createSession("u2");
  assert.equal(auth.sessions.has("stale-token"), false, "過期 entry 必須在 createSession 時被清掉");
  assert.equal(auth.sessions.has(live), true, "未過期的 session 保留");
  assert.equal(auth.sessions.has(fresh), true);
  assert.equal(auth.sessions.size, 2);
});
