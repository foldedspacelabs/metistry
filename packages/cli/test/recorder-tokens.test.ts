// The recorder's three tokens (X-80): made only when the recorder is
// configured, kept when they exist, never printed, and the inbox token is a
// real capture owner token in the console's database.
import { readFileSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { tokenHash } from "@foldedspacelabs/metistry-core";
import { loadTestEnv, testDb } from "@foldedspacelabs/metistry-core/test-env";
import {
  CAPTURE_BRIDGE_TOKEN,
  CAPTURE_CONTROL_TOKEN,
  CAPTURE_INBOX_TOKEN,
  CAPTURE_TOKEN_LABEL,
  describeRecorderTokens,
  ensureRecorderTokens,
  registerCaptureOwnerToken,
} from "../src/recorder-tokens.js";
import { GENERATED_SECRETS, GENERATED_WHEN, syncSecrets } from "../src/secrets.js";
import { fakeKeychain } from "./fake-security.js";

const { hasDb } = loadTestEnv(new URL("../../../.env", import.meta.url));

const INSTANCE_ID = "11111111-2222-4333-8444-555555555555";
const item = (account: string, name: string) => `${account}/metistry:${name}`;

async function envFile(text = ""): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "metistry-recorder-tokens-"));
  const file = join(dir, ".env");
  await writeFile(file, text, { mode: 0o600 });
  return file;
}

const URL_ON = { METISTRY_LIVE_CAPTURE_URL: "http://127.0.0.1:7815" };
const writes = (calls: Array<{ args: string[] }>) => calls.filter((c) => c.args[0] === "add-generic-password");

describe("ensureRecorderTokens", () => {
  it("**with the recorder configured and no token: mints all three, distinct, into the Keychain (instance account) and .env, and prints no value**", async () => {
    const file = await envFile("METISTRY_DB_HOST=127.0.0.1\n");
    const kc = fakeKeychain();
    const lines: string[] = [];
    const env: NodeJS.ProcessEnv = { ...URL_ON };
    const got = await ensureRecorderTokens({ env, envFile: file, instanceId: INSTANCE_ID, exec: kc.exec, platform: "darwin", out: (l) => lines.push(l) });

    expect(got.minted).toEqual([CAPTURE_CONTROL_TOKEN, CAPTURE_BRIDGE_TOKEN, CAPTURE_INBOX_TOKEN]);
    expect(got.failed).toEqual([]);
    const values = [CAPTURE_CONTROL_TOKEN, CAPTURE_BRIDGE_TOKEN, CAPTURE_INBOX_TOKEN].map((n) => kc.store.get(item(INSTANCE_ID, n))!);
    for (const v of values) expect(v).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    expect(new Set(values).size).toBe(3); // the bridge refuses to start when any two are the same
    // the bar reads exactly this item: service metistry:<VAR>, account = instance_id
    expect(kc.store.has(item("metistry", CAPTURE_CONTROL_TOKEN))).toBe(false);
    const text = readFileSync(file, "utf8");
    expect(text.startsWith("METISTRY_DB_HOST=127.0.0.1\n")).toBe(true);
    for (const [i, n] of [CAPTURE_CONTROL_TOKEN, CAPTURE_BRIDGE_TOKEN, CAPTURE_INBOX_TOKEN].entries()) expect(text).toContain(`${n}=${values[i]}`);
    // the run's own environment and the copy `up` renders its jobs from carry them too
    expect(env[CAPTURE_CONTROL_TOKEN]).toBe(values[0]);
    expect(got.inbox).toBe(values[2]);
    // never printed, never on a command line
    const all = [...lines, ...describeRecorderTokens(got)].join("\n");
    for (const v of values) {
      expect(all).not.toContain(v);
      for (const c of kc.calls) for (const a of c.argv) expect(a).not.toContain(v);
    }
  });

  it("**a second run keeps what exists: no Keychain write, no .env change, the same values**", async () => {
    const file = await envFile();
    const kc = fakeKeychain();
    const first = await ensureRecorderTokens({ env: { ...URL_ON }, envFile: file, instanceId: INSTANCE_ID, exec: kc.exec, platform: "darwin", out: () => {} });
    const before = readFileSync(file, "utf8");
    const stored = new Map(kc.store);
    kc.calls.length = 0;

    const again = await ensureRecorderTokens({ env: { ...URL_ON }, envFile: file, instanceId: INSTANCE_ID, exec: kc.exec, platform: "darwin", out: () => {}, mint: () => "MUST-NOT-BE-USED" });
    expect(again.minted).toEqual([]);
    expect(again.kept).toEqual([CAPTURE_CONTROL_TOKEN, CAPTURE_BRIDGE_TOKEN, CAPTURE_INBOX_TOKEN]);
    expect(writes(kc.calls)).toEqual([]);
    expect(readFileSync(file, "utf8")).toBe(before);
    expect(kc.store).toEqual(stored);
    expect(again.inbox).toBe(first.inbox);
  });

  it("**without the recorder configured it mints nothing and never calls the Keychain**", async () => {
    const file = await envFile("METISTRY_DB_HOST=127.0.0.1\n");
    const kc = fakeKeychain();
    for (const env of [{}, { METISTRY_LIVE_CAPTURE_URL: "" }]) {
      const got = await ensureRecorderTokens({ env, envFile: file, instanceId: INSTANCE_ID, exec: kc.exec, platform: "darwin", out: () => {} });
      expect(got).toEqual({ minted: [], adopted: [], kept: [], failed: [] });
    }
    expect(kc.calls).toEqual([]);
    expect(readFileSync(file, "utf8")).toBe("METISTRY_DB_HOST=127.0.0.1\n");
  });

  it("adopts an owner-pasted bridge token into the Keychain and never replaces it", async () => {
    const file = await envFile("METISTRY_BRIDGE_TOKEN_LIVE_CAPTURE=owner-pasted-value\n");
    const kc = fakeKeychain();
    const got = await ensureRecorderTokens({ env: { ...URL_ON }, envFile: file, instanceId: INSTANCE_ID, exec: kc.exec, platform: "darwin", out: () => {} });
    expect(got.adopted).toEqual([CAPTURE_BRIDGE_TOKEN]);
    expect(got.minted).toEqual([CAPTURE_CONTROL_TOKEN, CAPTURE_INBOX_TOKEN]);
    expect(kc.store.get(item(INSTANCE_ID, CAPTURE_BRIDGE_TOKEN))).toBe("owner-pasted-value");
    expect(readFileSync(file, "utf8")).toContain("METISTRY_BRIDGE_TOKEN_LIVE_CAPTURE=owner-pasted-value\n");
  });

  it("fills .env from a Keychain item that is already there (the bar's key and the bridge's cannot drift)", async () => {
    const file = await envFile();
    const kc = fakeKeychain({ [item(INSTANCE_ID, CAPTURE_CONTROL_TOKEN)]: "keychain-held" });
    const got = await ensureRecorderTokens({ env: { ...URL_ON }, envFile: file, instanceId: INSTANCE_ID, exec: kc.exec, platform: "darwin", out: () => {} });
    expect(got.kept).toEqual([CAPTURE_CONTROL_TOKEN]);
    expect(kc.store.get(item(INSTANCE_ID, CAPTURE_CONTROL_TOKEN))).toBe("keychain-held");
    expect(readFileSync(file, "utf8")).toContain("METISTRY_LIVE_CAPTURE_CONTROL_TOKEN=keychain-held\n");
  });

  it("a Keychain that refuses one token is reported by name and does not stop the others", async () => {
    const file = await envFile();
    const kc = fakeKeychain({}, (service) => service === `metistry:${CAPTURE_BRIDGE_TOKEN}`);
    const lines: string[] = [];
    const got = await ensureRecorderTokens({ env: { ...URL_ON }, envFile: file, instanceId: INSTANCE_ID, exec: kc.exec, platform: "darwin", out: () => {} });
    expect(got.minted).toEqual([CAPTURE_CONTROL_TOKEN, CAPTURE_INBOX_TOKEN]);
    expect(got.failed.map((f) => f.name)).toEqual([CAPTURE_BRIDGE_TOKEN]);
    lines.push(...describeRecorderTokens(got));
    expect(lines.join("\n")).toContain("could not make METISTRY_BRIDGE_TOKEN_LIVE_CAPTURE");
    expect(lines.join("\n")).toContain("metistry secrets mint");
  });

  it("off macOS .env is the store: minted once, kept after", async () => {
    const file = await envFile();
    const first = await ensureRecorderTokens({ env: { ...URL_ON }, envFile: file, platform: "linux", out: () => {} });
    expect(first.minted).toHaveLength(3);
    const text = readFileSync(file, "utf8");
    const again = await ensureRecorderTokens({ env: { ...URL_ON }, envFile: file, platform: "linux", out: () => {} });
    expect(again.minted).toEqual([]);
    expect(readFileSync(file, "utf8")).toBe(text);
  });
});

describe("the recorder's tokens in GENERATED_SECRETS", () => {
  it("names all three, each with the reason it qualifies, and gates them on the opt-in", () => {
    for (const n of [CAPTURE_CONTROL_TOKEN, CAPTURE_BRIDGE_TOKEN, CAPTURE_INBOX_TOKEN]) {
      expect(GENERATED_SECRETS[n]!.length, n).toBeGreaterThan(40);
      expect(GENERATED_WHEN[n], n).toBe("METISTRY_LIVE_CAPTURE_URL");
    }
  });

  it("`sync --to env` mints them while the recorder is configured, and leaves an install that never asked alone", async () => {
    const decl = [CAPTURE_CONTROL_TOKEN, CAPTURE_BRIDGE_TOKEN, CAPTURE_INBOX_TOKEN].map((n) => `${n}=`).join("\n") + "\n";
    // not configured: declared, empty, and still not invented
    const off = await envFile(decl);
    const kcOff = fakeKeychain();
    const rOff = await syncSecrets("env", { envFile: off, instanceId: INSTANCE_ID, exec: kcOff.exec, out: () => {}, platform: "darwin", env: {} });
    expect(rOff.minted).toEqual([]);
    expect(writes(kcOff.calls)).toEqual([]);
    // configured (the URL is in .env): minted into both
    const on = await envFile(`METISTRY_LIVE_CAPTURE_URL=http://127.0.0.1:7815\n${decl}`);
    const kcOn = fakeKeychain();
    const rOn = await syncSecrets("env", { envFile: on, instanceId: INSTANCE_ID, exec: kcOn.exec, out: () => {}, platform: "darwin", env: {} });
    expect([...(rOn.minted ?? [])].sort()).toEqual([CAPTURE_BRIDGE_TOKEN, CAPTURE_CONTROL_TOKEN, CAPTURE_INBOX_TOKEN].sort());
    expect(kcOn.store.has(item(INSTANCE_ID, CAPTURE_CONTROL_TOKEN))).toBe(true);
    // …and a value .env already held is adopted, never minted over
    const held = await envFile(`METISTRY_LIVE_CAPTURE_URL=http://127.0.0.1:7815\n${CAPTURE_BRIDGE_TOKEN}=running-bridge-value\n`);
    const kcHeld = fakeKeychain();
    const rHeld = await syncSecrets("env", { envFile: held, instanceId: INSTANCE_ID, exec: kcHeld.exec, out: () => {}, platform: "darwin", env: {} });
    expect(rHeld.adopted).toEqual([CAPTURE_BRIDGE_TOKEN]);
    expect(readFileSync(held, "utf8")).toContain(`${CAPTURE_BRIDGE_TOKEN}=running-bridge-value\n`);
  });
});

/** An owner_tokens table in memory: the two statements registerCaptureOwnerToken runs, and nothing else. */
function fakeOwnerTokens(rows: Array<{ token_hash: string; label: string; revoked_at: Date | null }> = []) {
  const queries: string[] = [];
  const open = async () => ({
    query: async (text: string, values: unknown[] = []) => {
      queries.push(text);
      if (/^SELECT revoked_at FROM owner_tokens/.test(text)) return { rows: rows.filter((r) => r.token_hash === values[0]).map((r) => ({ revoked_at: r.revoked_at })) };
      if (/^INSERT INTO owner_tokens/.test(text)) {
        if (!rows.some((r) => r.token_hash === values[0])) rows.push({ token_hash: values[0] as string, label: values[1] as string, revoked_at: null });
        return { rows: [] };
      }
      throw new Error(`unexpected query: ${text}`);
    },
    end: async () => {},
  });
  return { rows, queries, open };
}

describe("registerCaptureOwnerToken", () => {
  it("records the hash (never the token) labelled live-capture, once", async () => {
    const t = fakeOwnerTokens();
    const lines: string[] = [];
    expect(await registerCaptureOwnerToken({ env: {}, token: "secret-inbox-token", out: (l) => lines.push(l), openSession: t.open })).toBe("recorded");
    expect(t.rows).toEqual([{ token_hash: tokenHash("secret-inbox-token"), label: CAPTURE_TOKEN_LABEL, revoked_at: null }]);
    expect(lines.join("\n")).not.toContain("secret-inbox-token");
    expect(await registerCaptureOwnerToken({ env: {}, token: "secret-inbox-token", out: () => {}, openSession: t.open })).toBe("present");
    expect(t.rows).toHaveLength(1);
  });

  it("repairs a rebuilt database without rotating the token, and reports (never revives) a revoked one", async () => {
    const t = fakeOwnerTokens([{ token_hash: tokenHash("old"), label: CAPTURE_TOKEN_LABEL, revoked_at: new Date() }]);
    const lines: string[] = [];
    expect(await registerCaptureOwnerToken({ env: {}, token: "old", out: (l) => lines.push(l), openSession: t.open })).toBe("revoked");
    expect(t.rows[0]!.revoked_at).not.toBeNull();
    expect(lines.join("\n")).toContain("revoked");
    expect(lines.join("\n")).toContain("metistry secrets mint METISTRY_LIVE_CAPTURE_INBOX_TOKEN");
  });

  it("a database that is down, unconfigured or not migrated is a note, never a throw", async () => {
    const lines: string[] = [];
    const out = (l: string) => lines.push(l);
    expect(await registerCaptureOwnerToken({ env: {}, token: "t", out, openSession: async () => null })).toBe("unreachable");
    expect(await registerCaptureOwnerToken({ env: {}, token: "t", out, openSession: async () => { throw new Error("ECONNREFUSED"); } })).toBe("unreachable");
    const noTable = async () => ({ query: async () => { throw new Error('relation "owner_tokens" does not exist'); }, end: async () => {} });
    expect(await registerCaptureOwnerToken({ env: {}, token: "t", out, openSession: noTable })).toBe("unreachable");
    expect(lines.filter((l) => l.includes("metistry up"))).toHaveLength(3);
  });
});

describe.skipIf(!hasDb)("registerCaptureOwnerToken against the scratch database", () => {
  let pool: pg.Pool;
  const token = `x80-${Math.random().toString(36).slice(2)}-${Date.now()}`;
  beforeAll(async () => {
    pool = await testDb(pg.Pool, { max: 1 });
  });
  afterAll(async () => {
    await pool.query("DELETE FROM owner_tokens WHERE token_hash = $1", [tokenHash(token)]);
    await pool.end();
  });

  it("writes the row the console's checkOwnerToken accepts, and a second call adds nothing", async () => {
    const open = async () => ({ query: (t: string, v?: unknown[]) => pool.query(t, v as any[]), end: async () => {} });
    expect(await registerCaptureOwnerToken({ env: {}, token, out: () => {}, openSession: open })).toBe("recorded");
    expect(await registerCaptureOwnerToken({ env: {}, token, out: () => {}, openSession: open })).toBe("present");
    const { rows } = await pool.query("SELECT label, revoked_at FROM owner_tokens WHERE token_hash = $1", [tokenHash(token)]);
    expect(rows).toEqual([{ label: CAPTURE_TOKEN_LABEL, revoked_at: null }]);
    // the console's own check (apps/console/src/auth-store.ts checkOwnerToken), verbatim
    const check = await pool.query("UPDATE owner_tokens SET last_used_at = now() WHERE token_hash = $1 AND revoked_at IS NULL RETURNING id", [tokenHash(token)]);
    expect(check.rows).toHaveLength(1);
  });
});
