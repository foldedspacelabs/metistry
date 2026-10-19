// Owner access tokens against a fake executor: the mint stores a hash and
// returns the plaintext once, the check touches last_used_at on a live row
// only, and registering an existing plaintext is keyed on its hash — present
// and revoked rows are reported, never rewritten. The console's integration
// suites exercise the same functions against a real Postgres through its
// store's re-export; packages/cli's recorder-tokens test drives register.
import { describe, expect, it } from "vitest";
import { checkOwnerToken, mintOwnerToken, registerOwnerToken, tokenHash, type OwnerTokenDb } from "../src/index.js";

function fakeDb(answers: unknown[][]): OwnerTokenDb & { sent: { text: string; values: unknown[] | undefined }[] } {
  const sent: { text: string; values: unknown[] | undefined }[] = [];
  return {
    sent,
    async query(text, values) {
      sent.push({ text, values });
      return { rows: answers.shift() ?? [] };
    },
  };
}

describe("mintOwnerToken", () => {
  it("inserts the hash and the label, returns the plaintext, and the plaintext never reaches the database", async () => {
    const db = fakeDb([[]]);
    const token = await mintOwnerToken(db, "iphone-shortcut");
    expect(token).toMatch(/^[A-Za-z0-9_-]{40,}$/); // 32 random bytes, base64url
    expect(db.sent).toHaveLength(1);
    expect(db.sent[0]!.text).toContain("INSERT INTO owner_tokens (token_hash, label)");
    expect(db.sent[0]!.values).toEqual([tokenHash(token), "iphone-shortcut"]);
  });
});

describe("checkOwnerToken", () => {
  it("is true for a live row (and touches last_used_at), false otherwise", async () => {
    const db = fakeDb([[{ id: 1 }], []]);
    expect(await checkOwnerToken(db, "t")).toBe(true);
    expect(await checkOwnerToken(db, "t")).toBe(false);
    for (const s of db.sent) {
      expect(s.text).toContain("SET last_used_at = now()");
      expect(s.text).toContain("revoked_at IS NULL");
      expect(s.values).toEqual([tokenHash("t")]);
    }
  });
});

describe("registerOwnerToken", () => {
  it("records a plaintext the database has no row for, keyed on its hash", async () => {
    const db = fakeDb([[], []]);
    expect(await registerOwnerToken(db, "inbox", "live-capture")).toBe("recorded");
    expect(db.sent.map((s) => s.text.split("\n")[0])).toEqual([
      "SELECT revoked_at FROM owner_tokens WHERE token_hash = $1",
      "INSERT INTO owner_tokens (token_hash, label) VALUES ($1, $2) ON CONFLICT (token_hash) DO NOTHING",
    ]);
    expect(db.sent[0]!.values).toEqual([tokenHash("inbox")]);
    expect(db.sent[1]!.values).toEqual([tokenHash("inbox"), "live-capture"]);
  });

  it("reports a present row and a revoked one without writing", async () => {
    const present = fakeDb([[{ revoked_at: null }]]);
    expect(await registerOwnerToken(present, "inbox", "live-capture")).toBe("present");
    expect(present.sent).toHaveLength(1);
    const revoked = fakeDb([[{ revoked_at: new Date() }]]);
    expect(await registerOwnerToken(revoked, "inbox", "live-capture")).toBe("revoked");
    expect(revoked.sent).toHaveLength(1);
  });
});
