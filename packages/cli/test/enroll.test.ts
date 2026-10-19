// `metistry enroll` without a database (plan §2.22, M19): the four refusals
// as code paths, each naming METISTRY_ORIGIN and the fix and each minting
// nothing; the reachability probe against a fake fetch; the one `--json`
// document; and the verb's usage errors through `main()`. The same verb
// against a real Postgres is enroll.integration.test.ts.
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { tokenHash } from "@foldedspacelabs/metistry-core";
import {
  ENROLL_FIX,
  ENROLL_HEALTH_TIMEOUT_MS,
  checkOriginReachable,
  checkOriginShape,
  enroll,
  firstOrigin,
  isLoopbackHost,
  parseCodeId,
  providerPhrase,
  readRemoteProvider,
  renderEnrollCancelled,
  renderEnrollMinted,
  renderEnrollRefusal,
  renderEnrollStatus,
  type EnrollRefusal,
} from "../src/enroll.js";
import type { Db } from "../src/doctor.js";
import { main } from "../src/main.js";
import { createUi } from "../src/ui.js";

const ORIGIN = "https://assistant.example";
const INSTANCE_ID = "11111111-2222-4333-8444-555555555555";

/** A console at `origin`: /health answers `health`, /api/identity answers `identity`; records every URL asked. */
function fakeOrigin(opts: { health?: number | "throw" | "timeout"; identity?: { status: number; body?: unknown } } = {}) {
  const asked: string[] = [];
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    asked.push(String(url));
    const path = new URL(String(url)).pathname;
    if (path === "/health") {
      if (opts.health === "throw") throw new TypeError("fetch failed");
      if (opts.health === "timeout") {
        const e = new Error("The operation was aborted due to timeout");
        e.name = "TimeoutError";
        init?.signal?.throwIfAborted();
        throw e;
      }
      return new Response(JSON.stringify({ ok: true, api_version: 1 }), { status: opts.health ?? 200, headers: { "content-type": "application/json" } });
    }
    if (path === "/api/identity") {
      const id = opts.identity ?? { status: 200, body: { instance_id: INSTANCE_ID, name: "x", icon: null } };
      return new Response(id.body === undefined ? "" : JSON.stringify(id.body), { status: id.status, headers: { "content-type": "application/json" } });
    }
    return new Response("", { status: 404 });
  }) as unknown as typeof fetch;
  return { fetchFn, asked };
}

/** A database that records every statement and answers a mint the way Postgres would. */
function recordingDb(): Db & { sent: { text: string; values: unknown[] | undefined }[] } {
  const sent: { text: string; values: unknown[] | undefined }[] = [];
  let nextRun = 100;
  return {
    sent,
    async query(text, values) {
      sent.push({ text, values });
      if (text.includes("INSERT INTO runs")) return { rows: [{ id: nextRun++ }] };
      if (text.includes("INSERT INTO auth_enrollment_codes")) return { rows: [{ id: 42, expires_at: new Date("2026-10-18T10:10:00Z") }] };
      return { rows: [] };
    },
  };
}

describe("firstOrigin", () => {
  it("is the first comma-separated entry, trimmed, without a trailing slash; undefined when unset or blank", () => {
    expect(firstOrigin({})).toBeUndefined();
    expect(firstOrigin({ METISTRY_ORIGIN: "" })).toBeUndefined();
    expect(firstOrigin({ METISTRY_ORIGIN: "  , https://b.example" })).toBeUndefined();
    expect(firstOrigin({ METISTRY_ORIGIN: "https://a.example/" })).toBe("https://a.example");
    expect(firstOrigin({ METISTRY_ORIGIN: " https://a.example , https://b.example" })).toBe("https://a.example");
  });
});

describe("isLoopbackHost", () => {
  it("is 127.0.0.0/8, ::1, the IPv4-mapped form and localhost — nothing else", () => {
    for (const h of ["127.0.0.1", "127.255.0.9", "::1", "::ffff:127.0.0.1", "localhost", "LOCALHOST"]) expect(isLoopbackHost(h), h).toBe(true);
    for (const h of ["128.0.0.1", "10.0.0.1", "192.168.1.4", "::2", "assistant.example", "localhost.example", "2001:db8::1"]) expect(isLoopbackHost(h), h).toBe(false);
  });
});

describe("checkOriginShape — the refusals that need no network", () => {
  const refusal = (origin: string | undefined): EnrollRefusal => {
    const r = checkOriginShape(origin);
    if (r.ok) throw new Error(`${origin} was not refused`);
    return r.refusal;
  };

  it("refuses a loopback host in §2.22's words — every install's default, and before the http: rule", () => {
    for (const origin of ["http://127.0.0.1:8080", "https://127.0.0.1", "http://localhost:8080", "https://[::1]:8443", "http://127.9.9.9"]) {
      const r = refusal(origin);
      expect(r.case, origin).toBe("loopback");
      expect(r.message).toBe("Your phone can't reach this Mac yet: Metistry only answers on this Mac. Choose how your phone reaches it in Settings ▸ Remote Access (`metistry remote set`).");
      expect(r.origin).toBe(origin);
      expect(r.fix).toBe(ENROLL_FIX);
    }
  });

  it("refuses http: in §2.22's words, naming METISTRY_ORIGIN", () => {
    const r = refusal("http://assistant.example");
    expect(r.case).toBe("http");
    expect(r.message).toBe("A passkey needs HTTPS. METISTRY_ORIGIN is http://assistant.example; set it to the https:// address your phone will open.");
  });

  it("refuses an IP literal — v4 or v6 — in §2.22's words, naming METISTRY_ORIGIN", () => {
    const v4 = refusal("https://192.168.1.4");
    expect(v4.case).toBe("ip_literal");
    expect(v4.message).toBe("A passkey needs a name, not an IP address. METISTRY_ORIGIN is https://192.168.1.4; set it to a hostname your phone can open.");
    expect(refusal("https://[2001:db8::1]:8443").case).toBe("ip_literal");
    expect(refusal("https://10.0.0.7:8443").case).toBe("ip_literal");
  });

  it("refuses an unset or unparsable METISTRY_ORIGIN by name, with the fix", () => {
    expect(refusal(undefined)).toMatchObject({ case: "origin_unset", origin: null, fix: ENROLL_FIX });
    expect(refusal(undefined).message).toContain("METISTRY_ORIGIN is not set");
    expect(refusal("not a url")).toMatchObject({ case: "origin_invalid", origin: "not a url" });
    expect(refusal("ftp://assistant.example")).toMatchObject({ case: "origin_invalid" });
  });

  it("passes an https: hostname", () => {
    const r = checkOriginShape("https://assistant.example");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.url.origin).toBe("https://assistant.example");
  });

  it("every refusal ends with the same pointer: Settings ▸ Remote Access and `metistry remote`", () => {
    for (const origin of [undefined, "http://127.0.0.1:8080", "http://assistant.example", "https://10.0.0.7"]) {
      expect(refusal(origin).fix).toContain("Settings ▸ Remote Access");
      expect(refusal(origin).fix).toContain("`metistry remote`");
      expect(renderEnrollRefusal(refusal(origin))).toContain("METISTRY_ORIGIN");
    }
  });
});

describe("checkOriginReachable — the fourth refusal", () => {
  const url = new URL(ORIGIN);

  it("is five seconds, §2.22's number", () => {
    expect(ENROLL_HEALTH_TIMEOUT_MS).toBe(5000);
  });

  it("refuses when /health does not answer, naming the origin and the provider, with the probe in the detail", async () => {
    const down = fakeOrigin({ health: "throw" });
    const r = await checkOriginReachable(url, { fetchFn: down.fetchFn, provider: "tailscale" });
    expect(r).toMatchObject({ case: "unreachable", origin: ORIGIN, fix: ENROLL_FIX });
    expect(r!.message).toBe("https://assistant.example doesn't answer from this Mac, so your phone won't reach it either. Settings ▸ Remote Access shows what tailscale reports.");
    expect(r!.detail).toBe("GET https://assistant.example/health: fetch failed");
    expect(down.asked).toEqual(["https://assistant.example/health"]);
  });

  it("says 'no answer within 5 s' on a timeout, and names a generic provider when none is recorded", async () => {
    const slow = fakeOrigin({ health: "timeout" });
    const r = await checkOriginReachable(url, { fetchFn: slow.fetchFn });
    expect(r!.detail).toBe("GET https://assistant.example/health: no answer within 5 s");
    expect(r!.message).toContain("what your remote-access provider reports");
    expect(providerPhrase("none")).toBe("your remote-access provider");
    expect(providerPhrase(undefined)).toBe("your remote-access provider");
    expect(providerPhrase("cloudflare")).toBe("cloudflare");
  });

  it("an unwell console still answers: a 503 from /health is not 'does not answer'", async () => {
    const unwell = fakeOrigin({ health: 503 });
    expect(await checkOriginReachable(url, { fetchFn: unwell.fetchFn })).toBeUndefined();
  });

  it("refuses an origin whose /api/identity names another instance — and only then", async () => {
    const other = fakeOrigin({ identity: { status: 200, body: { instance_id: "99999999-9999-4999-8999-999999999999" } } });
    const r = await checkOriginReachable(url, { fetchFn: other.fetchFn, instanceId: INSTANCE_ID });
    expect(r).toMatchObject({ case: "other_instance", origin: ORIGIN });
    expect(r!.message).toContain("doesn't answer from this Mac");
    expect(r!.detail).toContain("names instance 99999999-9999-4999-8999-999999999999, not this one");
    expect(other.asked).toEqual(["https://assistant.example/health", "https://assistant.example/api/identity"]);

    const same = fakeOrigin();
    expect(await checkOriginReachable(url, { fetchFn: same.fetchFn, instanceId: INSTANCE_ID })).toBeUndefined();
  });

  it("skips the identity comparison when this instance has no id to compare, or the identity is not served", async () => {
    const noId = fakeOrigin({ identity: { status: 200, body: { instance_id: "someone-else" } } });
    expect(await checkOriginReachable(url, { fetchFn: noId.fetchFn })).toBeUndefined();
    expect(noId.asked).toEqual(["https://assistant.example/health"]);
    const unstamped = fakeOrigin({ identity: { status: 503, body: { error: { code: "not_available" } } } });
    expect(await checkOriginReachable(url, { fetchFn: unstamped.fetchFn, instanceId: INSTANCE_ID })).toBeUndefined();
  });
});

describe("readRemoteProvider", () => {
  it("reads deployment.yaml's remote.provider when there is one; undefined for no file, no key, or no instance", async () => {
    const dir = await mkdtemp(join(tmpdir(), "metistry-enroll-inst-"));
    await mkdir(join(dir, ".metistry"), { recursive: true });
    expect(await readRemoteProvider(undefined)).toBeUndefined();
    expect(await readRemoteProvider(dir)).toBeUndefined();
    await writeFile(join(dir, ".metistry", "deployment.yaml"), "shape: launchd\nservices: {}\n");
    expect(await readRemoteProvider(dir)).toBeUndefined();
    await writeFile(join(dir, ".metistry", "deployment.yaml"), "shape: launchd\nremote:\n  provider: tailscale\n  mode: funnel\n");
    expect(await readRemoteProvider(dir)).toBe("tailscale");
  });
});

describe("enroll()", () => {
  it("a refused origin mints nothing: no statement is sent and, for the shape refusals, nothing is fetched", async () => {
    for (const origin of ["http://127.0.0.1:8080", "http://assistant.example", "https://10.0.0.7"]) {
      const db = recordingDb();
      const net = fakeOrigin();
      const r = await enroll({ env: { METISTRY_ORIGIN: origin }, db, fetchFn: net.fetchFn });
      expect(r.kind, origin).toBe("refused");
      expect(db.sent, origin).toEqual([]);
      expect(net.asked, origin).toEqual([]);
    }
    const db = recordingDb();
    const down = fakeOrigin({ health: "throw" });
    const r = await enroll({ env: { METISTRY_ORIGIN: ORIGIN }, db, fetchFn: down.fetchFn });
    expect(r).toMatchObject({ kind: "refused", refusal: { case: "unreachable" } });
    expect(db.sent).toEqual([]);
  });

  it("mints for the first METISTRY_ORIGIN entry: the URL carries the code, the database the hash, and the document the row's id — never the code", async () => {
    const db = recordingDb();
    const net = fakeOrigin();
    const r = await enroll({ env: { METISTRY_ORIGIN: `${ORIGIN}/, https://second.example` }, db, fetchFn: net.fetchFn });
    expect(r.kind).toBe("minted");
    if (r.kind !== "minted") return;
    const code = r.minted.url.slice(`${ORIGIN}/#enroll=`.length);
    expect(r.minted).toEqual({ url: `${ORIGIN}/#enroll=${code}`, code_id: 42, origin: ORIGIN, expires_at: "2026-10-18T10:10:00.000Z" });
    expect(code.length).toBeGreaterThanOrEqual(20);
    expect(Object.keys(r.minted)).toEqual(["url", "code_id", "origin", "expires_at"]);
    const insert = db.sent.find((s) => s.text.includes("INSERT INTO auth_enrollment_codes"))!;
    expect(insert.values).toEqual([tokenHash(code)]);
    expect(JSON.stringify(db.sent)).not.toContain(code);
    // audited: one runs row, started before the mint and finished after it with the id
    expect(db.sent.map((s) => s.text.split(/\s+/).slice(0, 3).join(" "))).toEqual(["INSERT INTO runs", "INSERT INTO auth_enrollment_codes", "UPDATE runs SET"]);
    expect(db.sent[0]!.values?.slice(0, 4)).toEqual(["cli", "auth", null, "enroll"]);
    expect(JSON.parse(String(db.sent[2]!.values?.[6]))).toEqual({ code_id: 42, expires_at: "2026-10-18T10:10:00.000Z" });
  });

  it("mints for the RECORDED provider's origin, not .env's first entry (plan §2.23): the record is what the console runs with", async () => {
    const dir = await mkdtemp(join(tmpdir(), "metistry-enroll-inst-"));
    await mkdir(join(dir, ".metistry"), { recursive: true });
    await writeFile(join(dir, ".metistry", "identity.yaml"), `name: T\ninstance_id: ${INSTANCE_ID}\n`);
    await writeFile(join(dir, ".metistry", "deployment.yaml"), `shape: launchd\nremote:\n  provider: zrok\n  origin: ${ORIGIN}\n  settings:\n    upstream: "http://127.0.0.1:8081"\n`);
    const db = recordingDb();
    const net = fakeOrigin();
    // .env still holds the loopback origin init wrote — the record puts the provider's first
    const r = await enroll({ env: { METISTRY_ORIGIN: "http://127.0.0.1:8080" }, instanceDir: dir, db, fetchFn: net.fetchFn });
    expect(r.kind).toBe("minted");
    if (r.kind !== "minted") return;
    expect(r.minted.origin).toBe(ORIGIN);
    expect(r.minted.url.startsWith(`${ORIGIN}/#enroll=`)).toBe(true);
    expect(net.asked).toEqual([`${ORIGIN}/health`, `${ORIGIN}/api/identity`]);

    // and the other way round: a remote origin hand-written into .env beside
    // remote: none is NOT minted for — the console does not answer for it
    await writeFile(join(dir, ".metistry", "deployment.yaml"), "shape: launchd\nservices: {}\n");
    const none = await enroll({ env: { METISTRY_ORIGIN: `${ORIGIN},http://127.0.0.1:8080` }, instanceDir: dir, db: recordingDb(), fetchFn: fakeOrigin().fetchFn });
    expect(none.kind).toBe("refused");
    if (none.kind !== "refused") return;
    expect(none.refusal.case).toBe("loopback");
    expect(none.refusal.origin).toBe("http://127.0.0.1:8080");
    // a provider's refusal names that provider
    await writeFile(join(dir, ".metistry", "deployment.yaml"), `shape: launchd\nremote:\n  provider: zrok\n  origin: ${ORIGIN}\n`);
    const down = await enroll({ env: {}, instanceDir: dir, db: recordingDb(), fetchFn: fakeOrigin({ health: "throw" }).fetchFn });
    expect(down.kind).toBe("refused");
    if (down.kind === "refused") expect(down.refusal.message).toContain("what zrok reports");
  });

  it("--json is exactly that one document", async () => {
    const db = recordingDb();
    const r = await enroll({ env: { METISTRY_ORIGIN: ORIGIN }, db, fetchFn: fakeOrigin().fetchFn });
    if (r.kind !== "minted") throw new Error("not minted");
    const doc = JSON.parse(JSON.stringify(r.minted));
    expect(Object.keys(doc).sort()).toEqual(["code_id", "expires_at", "origin", "url"]);
  });
});

describe("rendering", () => {
  const ui = createUi({ noColor: true });

  it("the minted answer prints the URL, the host the phone must open, and how to cancel — and nothing that is not in the URL", () => {
    const text = renderEnrollMinted({ url: `${ORIGIN}/#enroll=abc`, code_id: 42, origin: ORIGIN, expires_at: "2026-10-18T10:10:00.000Z" }, ui);
    expect(text).toContain(`${ORIGIN}/#enroll=abc`);
    expect(text).toContain("Your phone must be able to open assistant.example.");
    expect(text).toContain("`metistry enroll --cancel 42`");
    expect(text).toContain("works once, for 10 minutes");
  });

  it("a refusal prints its own words, METISTRY_ORIGIN, the detail and the fix", () => {
    const r = checkOriginShape("http://127.0.0.1:8080");
    if (r.ok) throw new Error("not refused");
    const text = renderEnrollRefusal(r.refusal);
    expect(text).toContain("metistry enroll: refused — Your phone can't reach this Mac yet");
    expect(text).toContain("METISTRY_ORIGIN is http://127.0.0.1:8080");
    expect(text).toContain(ENROLL_FIX);
    const http = checkOriginShape("http://assistant.example");
    if (http.ok) throw new Error("not refused");
    expect(renderEnrollRefusal(http.refusal).match(/METISTRY_ORIGIN/g)).toHaveLength(2); // the message's own, and the fix's — not a third line repeating it
  });

  it("each cancel outcome has its own sentence", () => {
    expect(renderEnrollCancelled({ code_id: 4, outcome: "cancelled", cancelled: true })).toBe("code 4 cancelled — its URL is dead.");
    expect(renderEnrollCancelled({ code_id: 4, outcome: "already_used", cancelled: false })).toContain("already used");
    expect(renderEnrollCancelled({ code_id: 4, outcome: "already_expired", cancelled: false })).toContain("already expired");
    expect(renderEnrollCancelled({ code_id: 4, outcome: "not_found", cancelled: false })).toBe("no enrolment code has id 4.");
  });
});

describe("renderEnrollStatus", () => {
  const base = { code_id: 4, state: "live" as const, expires_at: "2026-10-19T14:52:10.000Z", provider: null };
  it("says what the stamp proves: only a proxy-listener open is a phone that reached this Mac", () => {
    expect(renderEnrollStatus({ ...base, opened_at: null, opened_via: null })).toBe("code 4: live; not opened yet.");
    expect(renderEnrollStatus({ ...base, opened_at: "2026-10-19T14:45:00.000Z", opened_via: "proxy" })).toContain("opened on the phone through the proxy listener");
    const main = renderEnrollStatus({ ...base, opened_at: "2026-10-19T14:45:00.000Z", opened_via: "main" });
    expect(main).toContain("that is not proof a phone reached it");
    expect(main).not.toContain("on the phone");
  });
});

describe("parseCodeId", () => {
  it("takes a positive integer and nothing else — a code is never an id", () => {
    expect(parseCodeId("42")).toBe(42);
    expect(parseCodeId(" 7 ")).toBe(7);
    for (const bad of [undefined, true, "", "0", "-1", "1.5", "abc", "42abc", "9007199254740993"]) expect(parseCodeId(bad as string | true | undefined), String(bad)).toBeUndefined();
  });
});

describe("metistry enroll (CLI)", () => {
  afterEach(() => {
    delete process.env.METISTRY_ORIGIN;
  });

  it("usage errors — a positional, --cancel without an id, --cancel with something that is not an id — exit 2 before anything is read", async () => {
    const err: string[] = [];
    const run = (args: string[]) => main(["enroll", ...args], { out: () => {}, err: (s) => err.push(s) });
    expect(await run(["extra"])).toBe(2);
    expect(await run(["--cancel"])).toBe(2);
    expect(await run(["--cancel", "abc"])).toBe(2);
    expect(await run(["--cancel", "0"])).toBe(2);
    expect(await run(["--status"])).toBe(2);
    expect(await run(["--status", "abc"])).toBe(2);
    expect(await run(["--status", "0"])).toBe(2);
    expect(await run(["--status", "4", "--cancel", "4"])).toBe(2);
    expect(err.join("\n")).toContain("metistry enroll --status <code_id>");
    expect(err.join("\n")).toContain("metistry enroll --cancel <code_id>");
    expect(err.join("\n")).toContain("a positive integer");
  });

  it("an unset METISTRY_ORIGIN is refused by name, exit 1", async () => {
    const err: string[] = [];
    expect(await main(["enroll"], { out: () => {}, err: (s) => err.push(s) })).toBe(1);
    expect(err.join("\n")).toContain("METISTRY_ORIGIN is not set");
    expect(err.join("\n")).toContain("Settings ▸ Remote Access");
  });

  it("the loopback default is refused in its own words; --json writes exactly one document, the refusal, on stdout", async () => {
    process.env.METISTRY_ORIGIN = "http://127.0.0.1:8080";
    const out: string[] = [];
    const err: string[] = [];
    expect(await main(["enroll", "--json"], { out: (s) => out.push(s), err: (s) => err.push(s) })).toBe(1);
    expect(out).toHaveLength(1);
    const doc = JSON.parse(out[0]!);
    expect(doc).toEqual({ refused: { case: "loopback", message: expect.stringContaining("Metistry only answers on this Mac"), origin: "http://127.0.0.1:8080", fix: ENROLL_FIX } });
    expect(err.join("\n")).toContain("METISTRY_ORIGIN is http://127.0.0.1:8080");
    expect(err.join("\n")).toContain("Metistry only answers on this Mac");
  });

  it("an origin this Mac cannot reach is refused, exit 1, with the probe's own failure", async () => {
    process.env.METISTRY_ORIGIN = ORIGIN;
    const err: string[] = [];
    const down = fakeOrigin({ health: "throw" });
    expect(await main(["enroll"], { out: () => {}, err: (s) => err.push(s), fetchFn: down.fetchFn })).toBe(1);
    expect(err.join("\n")).toContain("https://assistant.example doesn't answer from this Mac");
    expect(err.join("\n")).toContain("GET https://assistant.example/health: fetch failed");
  });

  it("is in the help", async () => {
    const out: string[] = [];
    expect(await main(["help"], { out: (s) => out.push(s), err: () => {} })).toBe(0);
    expect(out.join("\n")).toContain("metistry enroll --cancel <code_id>");
    expect(out.join("\n")).toContain("metistry enroll --status <code_id>");
    expect(out.join("\n")).toContain("add a phone");
  });
});
