/**
 * Unit tests — src/server.mjs `sanitizeAuditField` (audit-field sanitizer)
 * TASK-033 (minor#1) / framework: node:test
 *
 * The sanitizer strips control characters (incl. CR/LF, the log-injection
 * vector) and caps the output on UTF-16 code units (`String#length`). These
 * cases pin the two contracts:
 *   ① control chars (C0 / DEL / C1) are dropped;
 *   ② the cap is measured in UTF-16 code units — an astral char (surrogate
 *      pair) counts as 2 — and a surrogate pair is NEVER split (a lone
 *      half-surrogate would be invalid UTF-16 in the JSONL audit trail).
 *
 * ADR-004 (2026-10-19) — in-process, no spawn / no listen: the `createApp()`
 * seam is imported and the exported `sanitizeAuditField` / `AUDIT_FIELD_MAX`
 * are exercised directly (no request driving needed).
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { createApp } from "../../src/server.mjs";
import { createConfig } from "../../src/server/config.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC_DIR = join(__dirname, "..", "..", "src");

let app;
let tmp;

before(() => {
  tmp = mkdtempSync(join(tmpdir(), "paaw-gw-sanitize-"));
  const paawRoot = join(tmp, "paaw-root");
  mkdirSync(join(paawRoot, "data"), { recursive: true });
  mkdirSync(join(paawRoot, ".paaw"), { recursive: true });
  writeFileSync(join(paawRoot, "data", "db.json"), '{"unit":"seed"}');

  const configPath = join(tmp, "config.json");
  writeFileSync(configPath, JSON.stringify({
    host: "127.0.0.1",
    port: 4199,
    paawRoot,
    paawServerCmd: "node unit-no-such-file.mjs",
    paawServerPort: 4991,
    backupDir: join(tmp, "backups"),
    autoStartPaaw: false,
    users: [{ id: "admin", name: "Admin", role: "admin", passwordHash: "pw" }],
    sessionSecret: "unit-secret",
    sessionMaxAge: 86_400_000,
  }));

  const saved = new Map();
  for (const [k, v] of Object.entries({
    PAAW_CONFIG: configPath,
    PAAW_ROOT: paawRoot,
    PAAW_BACKUP_DIR: join(tmp, "backups"),
    PAAW_EVENT_LOG: join(tmp, "events.jsonl"),
  })) {
    saved.set(k, Object.prototype.hasOwnProperty.call(process.env, k) ? process.env[k] : undefined);
    process.env[k] = v;
  }
  try {
    app = createApp({ cfg: createConfig(SRC_DIR) });
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

after(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("src/server.mjs — sanitizeAuditField", () => {
  it("exposes the sanitizer + cap for unit testing", () => {
    assert.equal(typeof app.sanitizeAuditField, "function");
    assert.equal(typeof app.AUDIT_FIELD_MAX, "number");
    assert.ok(app.AUDIT_FIELD_MAX > 0);
  });

  it("strips C0 controls incl. CR/LF (log-injection vector) and DEL/C1", () => {
    const raw = "a\r\nb\u0000c\u007fd\u0085e";
    const out = app.sanitizeAuditField(raw);
    assert.equal(out, "abcde", `expected controls removed, got ${JSON.stringify(out)}`);
    for (const ch of out) {
      const code = ch.codePointAt(0);
      assert.ok(code >= 0x20 && !(code >= 0x7f && code <= 0x9f), "no control chars may survive");
    }
  });

  it("keeps the printable subset (ASCII + CJK + astral emoji) intact", () => {
    const raw = "admin-王小明-😀";
    assert.equal(app.sanitizeAuditField(raw), raw);
  });

  it("caps on UTF-16 code units: an astral char counts as 2 units", () => {
    const MAX = app.AUDIT_FIELD_MAX;
    // Pure BMP fill exactly to the cap → unchanged.
    const bmp = "a".repeat(MAX);
    assert.equal(app.sanitizeAuditField(bmp), bmp, "exactly-cap BMP string must be kept whole");
    // One astral char + BMP fill: total code units = MAX, so it fits exactly.
    const astral = "😀"; // length 2
    const fit = astral + "a".repeat(MAX - astral.length);
    assert.equal(app.sanitizeAuditField(fit).length, MAX, "code-unit length must never exceed the cap");
  });

  it("never splits a surrogate pair at the boundary (no lone half-surrogate)", () => {
    const MAX = app.AUDIT_FIELD_MAX;
    // Fill with MAX-1 BMP units, then append an astral char (2 units) → the pair
    // would push us to MAX+1 units, so the whole pair must be dropped, never cut.
    const raw = "a".repeat(MAX - 1) + "😀";
    const out = app.sanitizeAuditField(raw);
    assert.equal(out.length, MAX - 1, "the astral char must be dropped entirely, not split");
    // No lone surrogate anywhere in the output.
    for (let i = 0; i < out.length; i++) {
      const cu = out.charCodeAt(i);
      const isHigh = cu >= 0xd800 && cu <= 0xdbff;
      const isLow = cu >= 0xdc00 && cu <= 0xdfff;
      if (isHigh) {
        const next = out.charCodeAt(i + 1);
        assert.ok(next >= 0xdc00 && next <= 0xdfff, "a high surrogate must be followed by a low surrogate");
        i++; // consume the low half
      } else {
        assert.ok(!isLow, "output must not contain a lone low surrogate");
      }
    }
  });

  it("counts astral chars as 2 units when trimming an over-long mixed string", () => {
    const MAX = app.AUDIT_FIELD_MAX;
    // 100 astral chars = 200 code units, over the cap → trim at a pair boundary.
    const raw = "😀".repeat(100);
    const out = app.sanitizeAuditField(raw);
    assert.ok(out.length <= MAX, `trimmed length ${out.length} must be <= cap ${MAX}`);
    assert.equal(out.length % 2, 0, "an astral-only string trims to whole pairs (even code-unit count)");
    assert.equal(out, "😀".repeat(out.length / 2), "output must be whole emoji, never a split pair");
  });
});