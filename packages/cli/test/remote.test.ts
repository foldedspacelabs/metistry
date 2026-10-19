// `metistry remote` (plan §2.23, X-105): the record, the None adapter, the
// adapter interface exercised by a fake, and the one rule for switching —
// configure the new provider, wait for its origin to answer, write the
// record, revoke the old. A fake provider stands in for every adapter a later
// ticket ships, so the ordering and the write-nothing-on-failure rule are
// tested here once and inherited.
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse as parseYamlish } from "yaml";
import { parseDeployment, REMOTE_NONE, type Deployment, type RemoteRecord } from "@foldedspacelabs/metistry-core";
import { consoleEnv } from "../src/deployment.js";
import { doctor } from "../src/doctor.js";
import { main } from "../src/main.js";
import { renderOrigins } from "../src/origins.js";
import {
  applyRemoteToYaml,
  classifyUpstream,
  droppedOriginsNote,
  mainPortRemediation,
  none,
  NONE_ROW_INFO,
  remoteChoices,
  remoteRows,
  remoteSet,
  remoteStatus,
  renderRemoteBlock,
  renderRemoteStatus,
  type RemoteContext,
  type RemoteProvider,
  type RemoteRegistry,
} from "../src/remote/index.js";
import { createUi } from "../src/ui.js";
import { checkout, fakeExec } from "./fixtures.js";

const INSTANCE_ID = "11111111-1111-4111-8111-111111111111";

/** A flat-layout instance directory with an identity, so `readInstanceId` and `instanceFile` resolve as they do on a real install. */
async function instance(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "metistry-remote-inst-"));
  await mkdir(join(dir, ".metistry", "state"), { recursive: true });
  await writeFile(join(dir, ".metistry", "identity.yaml"), `name: Test\ninstance_id: ${INSTANCE_ID}\n`);
  return dir;
}

const deploymentPath = (I: string) => join(I, ".metistry", "deployment.yaml");

/** `GET <origin>/health` and `/api/identity` answer for every origin in `up`; everything else refuses the connection. Every probe is logged. */
function fakeNet(up: Set<string>, log: string[] = []) {
  const fetchFn = (async (input: string | URL | Request) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    log.push(`${url.pathname === "/health" ? "health" : "identity"}:${url.origin}`);
    if (!up.has(url.origin)) throw new Error("fetch failed");
    return new Response(JSON.stringify({ instance_id: INSTANCE_ID }), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { fetchFn, log };
}

interface FakeOptions {
  id: RemoteProvider["id"];
  origin: string;
  upstream?: string;
  configureThrows?: string;
  log: string[];
}

/** An adapter that records every call and honours `dryRun`, standing in for the providers later tickets ship. */
function fakeProvider(o: FakeOptions): RemoteProvider {
  return {
    id: o.id,
    label: `Fake ${o.id}`,
    async detect(ctx) {
      o.log.push(`detect:${o.id}`);
      return { tool: { present: true, version: "9.9", from: "pack" }, signed_in: true, origin: o.origin, would_change: [`point ${o.id} at ${ctx.proxySocket}`] };
    },
    async configure(ctx) {
      o.log.push(`configure:${o.id}${ctx.dryRun ? ":dry" : ""}`);
      if (o.configureThrows) throw new Error(o.configureThrows);
      return { origin: o.origin, mode: "funnel", settings: { upstream: o.upstream ?? `http://127.0.0.1:${ctx.proxyPort}`, node: `metistry-${o.id}` } };
    },
    async status(ctx: RemoteContext) {
      o.log.push(`status:${o.id}`);
      return [{ kind: "remote", name: `remote:${o.id}:own`, status: "ok", latency_ms: 0, probe: `${o.id}'s own row`, meta: { origin: ctx.record.origin ?? null } }];
    },
    async revoke(ctx) {
      // what the RECORD says at the moment revoke runs — the proof that the
      // new provider was written before the old one is undone
      let recorded = "absent";
      try {
        recorded = String((parseYamlish(readFileSync(join(ctx.instanceDir, ".metistry", "deployment.yaml"), "utf8")) as { remote?: { provider?: string } }).remote?.provider ?? "none");
      } catch {
        /* no file yet */
      }
      o.log.push(`revoke:${o.id}${ctx.dryRun ? ":dry" : ""}:record=${recorded}`);
      return { undone: [`the ${o.id} handler`], left_for_owner: [`the node in ${o.id}'s admin console`] };
    },
  };
}

const io = (extra: Record<string, unknown> = {}) => {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l), exec: fakeExec(), platform: "darwin" as const, uid: 501, ...extra } };
};

describe("the record: deployment.yaml's remote: block", () => {
  it("None is one line; a provider carries mode, origin and sorted settings", () => {
    expect(renderRemoteBlock(REMOTE_NONE)).toEqual(["remote:", "  provider: none"]);
    expect(renderRemoteBlock({ provider: "zrok", origin: "https://a.share.zrok.io", settings: { upstream: "http://127.0.0.1:8081", name: "a" } })).toEqual([
      "remote:",
      "  provider: zrok",
      "  origin: https://a.share.zrok.io",
      "  settings:",
      '    name: "a"',
      '    upstream: "http://127.0.0.1:8081"',
    ]);
  });

  it("writes a fresh file with the shape already in effect, replaces an existing block in place, appends to a file without one — and every result reads back", () => {
    const rec: RemoteRecord = { provider: "zrok", origin: "https://a.share.zrok.io", settings: { upstream: "http://127.0.0.1:8081" } };
    const fresh = applyRemoteToYaml(undefined, rec, "launchd");
    expect(fresh).toMatch(/^shape: launchd$/m);
    expect(fresh).toMatch(/^remote:\n  provider: zrok/m);
    expect(parseDeployment(parseYamlish(fresh)).remote).toEqual(rec);

    const existing = "# mine\nshape: compose\nremote:\n  provider: ngrok\n  origin: https://x.ngrok-free.dev\n  settings:\n    domain: x\n\nservices:\n  db:\n    enabled: false\n";
    const replaced = applyRemoteToYaml(existing, REMOTE_NONE, "compose");
    expect(replaced).toBe("# mine\nshape: compose\nremote:\n  provider: none\n\nservices:\n  db:\n    enabled: false\n");

    const appended = applyRemoteToYaml("shape: compose\nservices: {}\n", rec, "compose");
    expect(appended.startsWith("shape: compose\nservices: {}\n\n# remote — how your phone reaches this Mac")).toBe(true);
    expect(parseDeployment(parseYamlish(appended)).remote).toEqual(rec);
  });
});

describe("how the origin flows: METISTRY_ORIGIN is derived from the record (plan §2.23)", () => {
  const ctx = (env: NodeJS.ProcessEnv, remote?: RemoteRecord) => ({ productDir: "/p", instanceDir: "/i", env, shape: "launchd" as const, stateDir: "/i/state", remote });

  it("with None, METISTRY_ORIGIN is loopback only — a hand-written remote origin is dropped and reported, never carried", () => {
    const env = { METISTRY_ORIGIN: "https://studio.ts.net,http://127.0.0.1:8080" };
    expect(renderOrigins(REMOTE_NONE, env, 8080)).toEqual({ value: "http://127.0.0.1:8080", dropped: ["https://studio.ts.net"] });
    expect(renderOrigins(undefined, env, 8080).value).toBe("http://127.0.0.1:8080");
    expect(consoleEnv(ctx(env)).METISTRY_ORIGIN).toBe("http://127.0.0.1:8080");
    expect(consoleEnv(ctx(env, REMOTE_NONE)).METISTRY_ORIGIN).toBe("http://127.0.0.1:8080");
    // a remote-only .env keeps the Mac's own PWA working: the loopback default stands in
    expect(renderOrigins(REMOTE_NONE, { METISTRY_ORIGIN: "https://studio.ts.net" }, 8460)).toEqual({ value: "http://127.0.0.1:8460", dropped: ["https://studio.ts.net"] });
    // nothing anywhere: nothing to say — the console's own startup refusal names the variable
    expect(renderOrigins(REMOTE_NONE, {}, 8080)).toEqual({ value: undefined, dropped: [] });
    expect(consoleEnv(ctx({})).METISTRY_ORIGIN).toBeUndefined();
  });

  it("with a provider, its origin comes FIRST and the loopback origin init wrote second — so enroll mints for the remote one", () => {
    const rec: RemoteRecord = { provider: "zrok", origin: "https://a.share.zrok.io", settings: {} };
    expect(renderOrigins(rec, { METISTRY_ORIGIN: "http://127.0.0.1:8080" }, 8080).value).toBe("https://a.share.zrok.io,http://127.0.0.1:8080");
    // an .env that already lists it (a previous `up`): no duplicate; another remote name is dropped
    expect(renderOrigins(rec, { METISTRY_ORIGIN: "https://a.share.zrok.io/,http://127.0.0.1:8080,https://old.example" }, 8080)).toEqual({ value: "https://a.share.zrok.io,http://127.0.0.1:8080", dropped: ["https://old.example"] });
    // no loopback entry in .env: the default is appended rather than leaving this Mac with no local origin
    expect(renderOrigins(rec, {}, 8080).value).toBe("https://a.share.zrok.io,http://127.0.0.1:8080");
    expect(consoleEnv(ctx({ METISTRY_ORIGIN: "http://localhost:8080" }, rec)).METISTRY_ORIGIN).toBe("https://a.share.zrok.io,http://localhost:8080");
  });
});

describe("None — a fresh install (the ticket's acceptance)", () => {
  it("`metistry remote --json` says none, nothing exposed, and lists the choices in the plan's order with only none available", async () => {
    const P = await checkout();
    const I = await instance();
    const { out, io: o } = io();
    const code = await main(["remote", "--json", "--product-dir", P, "--instance", I], o);
    expect(code).toBe(0);
    const s = JSON.parse(out.join("\n"));
    expect(s).toMatchObject({ provider: "none", mode: null, origin: null, settings: {}, origins: [], available: ["none", "tailscale"], ok: true });
    expect(s.choices.map((c: { id: string }) => c.id)).toEqual(["none", "tailscale", "relay", "cloudflare", "zrok", "ngrok", "port-forward"]);
    expect(s.choices[0]).toMatchObject({ id: "none", tag: "default", available: true });
    expect(s.choices[1]).toMatchObject({ id: "tailscale", tag: "recommended", available: true });
    expect(s.choices[2]).toMatchObject({ id: "relay", available: false });
    expect(s.rows).toHaveLength(1);
    expect(s.rows[0]).toMatchObject({ kind: "remote", name: "remote", status: "ok", meta: { provider: "none", origin: null, info: NONE_ROW_INFO } });
    expect(NONE_ROW_INFO).toBe("Remote access: none. Your phone can't reach this Mac. Choose a way in Settings ▸ Remote Access.");
    // `remote status` is the same verb, and the human rendering carries the sentence
    const plain = io();
    expect(await main(["remote", "status", "--product-dir", P, "--instance", I], plain.io)).toBe(0);
    expect(plain.out.join("\n")).toContain("Your phone can't reach this Mac");
    expect(plain.out.join("\n")).toContain("not in this version yet");
  });

  it("doctor's `remote` row is ok, and `remote test` has nothing to fail", async () => {
    const P = await checkout();
    const I = await instance();
    const report = await doctor({ productDir: P, env: { METISTRY_INSTANCE_DIR: I }, deployment: { shape: "compose", services: {} }, fetchFn: fakeNet(new Set()).fetchFn, db: null, exec: fakeExec({ docker: () => ({ code: 127, stdout: "", stderr: "not found" }) }), platform: "linux", uid: 501, appPath: null });
    const rows = report.rows.filter((r) => r.kind === "remote");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: "remote", status: "ok", meta: { provider: "none" } });
    const { out, io: o } = io();
    expect(await main(["remote", "test", "--json", "--product-dir", P, "--instance", I], o)).toBe(0);
    expect(JSON.parse(out.join("\n"))).toMatchObject({ provider: "none", origin: null, ok: true });
  });

  it("`set none` and `off` on a fresh install change nothing; `authorize none` is refused — none needs no account", async () => {
    const P = await checkout();
    const I = await instance();
    const a = io();
    expect(await main(["remote", "off", "--yes", "--json", "--product-dir", P, "--instance", I], a.io)).toBe(0);
    expect(JSON.parse(a.out.join("\n"))).toMatchObject({ from: "none", provider: "none", applied: false, detail: expect.stringContaining("already none") });
    expect(existsSync(deploymentPath(I))).toBe(false);
    const b = io();
    expect(await main(["remote", "authorize", "none", "--product-dir", P, "--instance", I], b.io)).toBe(2);
    expect(b.err.join("\n")).toContain("needs no account");
  });

  it("a provider this version has no adapter for is refused by name, with the choices that exist", async () => {
    const P = await checkout();
    const I = await instance();
    const { err, io: o } = io();
    expect(await main(["remote", "set", "relay", "--yes", "--product-dir", P, "--instance", I], o)).toBe(2);
    expect(err.join("\n")).toContain("relay isn't available in this version of Metistry");
    expect(err.join("\n")).toContain("the choices here today: none, tailscale");
    expect(existsSync(deploymentPath(I))).toBe(false);
    // the slot is not echoed — a token pasted where the provider goes must not print back
    const typo = io();
    expect(await main(["remote", "set", "zrk_pasted_in_the_wrong_slot", "--product-dir", P, "--instance", I], typo.io)).toBe(2);
    expect(typo.err.join("\n")).toContain("not a known provider; the names are none, tailscale");
    expect([...typo.out, ...typo.err].join("\n")).not.toContain("zrk_pasted");
  });
});

describe("a token never arrives in argv (the `secrets set` rule)", () => {
  const SECRET = "zrk_s3cr3t_t0k3n_VALUE";

  it("`--token <value>` is refused, exit 2, and the value is not echoed anywhere", async () => {
    const P = await checkout();
    const I = await instance();
    const log: string[] = [];
    const providers: RemoteRegistry = { none, cloudflare: fakeProvider({ id: "cloudflare", origin: "https://m.example.com", log }) };
    const { out, err, io: o } = io({ remoteProviders: providers });
    expect(await main(["remote", "set", "cloudflare", "--token", SECRET, "--yes", "--product-dir", P, "--instance", I], o)).toBe(2);
    const everything = [...out, ...err].join("\n");
    expect(everything).not.toContain(SECRET);
    expect(everything).toContain("never taken as an argument");
    expect(everything).toContain("--token < token.txt");
    expect(log).toEqual([]); // nothing was detected, configured or written
    expect(existsSync(deploymentPath(I))).toBe(false);
  });

  it("`--token=<value>` and a stray positional after the provider are refused the same way", async () => {
    const P = await checkout();
    const I = await instance();
    const providers: RemoteRegistry = { none, zrok: fakeProvider({ id: "zrok", origin: "https://a.share.zrok.io", log: [] }) };
    for (const argv of [["remote", "set", "zrok", `--token=${SECRET}`], ["remote", "set", "zrok", SECRET], ["remote", "off", SECRET]]) {
      const { out, err, io: o } = io({ remoteProviders: providers });
      expect(await main([...argv, "--yes", "--product-dir", P, "--instance", I], o)).toBe(2);
      expect([...out, ...err].join("\n")).not.toContain(SECRET);
      expect(err.join("\n")).toContain("never taken as an argument");
    }
    expect(existsSync(deploymentPath(I))).toBe(false);
  });

  it("`--dry-run` wins over `--yes`: nothing configured, written or revoked, and the preview line is printed", async () => {
    const P = await checkout();
    const I = await instance();
    const log: string[] = [];
    const providers: RemoteRegistry = { none, zrok: fakeProvider({ id: "zrok", origin: "https://a.share.zrok.io", log }) };
    const { out, io: o } = io({ remoteProviders: providers, fetchFn: fakeNet(new Set(["https://a.share.zrok.io"])).fetchFn });
    expect(await main(["remote", "set", "zrok", "--yes", "--dry-run", "--json", "--product-dir", P, "--instance", I], o)).toBe(0);
    expect(log).toEqual(["detect:zrok"]);
    expect(existsSync(deploymentPath(I))).toBe(false);
    expect(out.join("\n")).toContain("preview only — pass --yes to do this.");
    expect(JSON.parse(out.filter((l) => l.startsWith("{") || l.startsWith(" ") || l.startsWith("}")).join("\n"))).toMatchObject({ applied: false, provider: "zrok" });
  });

  it("a bare `--token` means read it from stdin: the switch itself carries no value", async () => {
    const P = await checkout();
    const I = await instance();
    const log: string[] = [];
    const up = new Set(["https://m.example.com"]);
    const providers: RemoteRegistry = { none, cloudflare: fakeProvider({ id: "cloudflare", origin: "https://m.example.com", log }) };
    const { err, io: o } = io({ remoteProviders: providers, fetchFn: fakeNet(up).fetchFn, readToken: async () => SECRET });
    expect(await main(["remote", "set", "cloudflare", "--token", "--yes", "--product-dir", P, "--instance", I], o)).toBe(0);
    expect(err).toEqual([]);
    expect(log).toContain("configure:cloudflare");
    expect(await readFile(deploymentPath(I), "utf8")).not.toContain(SECRET);
  });
});

describe("switching providers — a fake adapter exercises the ordering", () => {
  const base = async (providers: RemoteRegistry, up: Set<string>, probes: string[] = []) => {
    const P = await checkout();
    const I = await instance();
    const lines: string[] = [];
    const net = fakeNet(up, probes);
    const opts = {
      productDir: P,
      instanceDir: I,
      env: { METISTRY_INSTANCE_DIR: I } as NodeJS.ProcessEnv,
      platform: "darwin" as const,
      uid: 501,
      fetchFn: net.fetchFn,
      exec: fakeExec(),
      out: (l: string) => lines.push(l),
      providers,
      pollMs: 1,
      sleep: async () => {},
      waitMs: 50,
    };
    return { P, I, lines, opts };
  };

  it("a failed configure writes nothing: the file is absent and the message says so", async () => {
    const log: string[] = [];
    const zrok = fakeProvider({ id: "zrok", origin: "https://a.share.zrok.io", configureThrows: "zrok didn't accept the account token", log });
    const { I, opts } = await base({ none, zrok }, new Set());
    await expect(remoteSet({ ...opts, provider: "zrok", options: { flags: {} }, yes: true })).rejects.toThrow(/could not be set up \(zrok didn't accept the account token\) — nothing was written and remote access is still none/);
    expect(existsSync(deploymentPath(I))).toBe(false);
    expect(log).toEqual(["detect:zrok", "configure:zrok"]);
  });

  it("without --yes nothing is configured, written or revoked — only read-only detect and a dry revoke for the preview", async () => {
    const log: string[] = [];
    const zrok = fakeProvider({ id: "zrok", origin: "https://a.share.zrok.io", log });
    const { I, lines, opts } = await base({ none, zrok }, new Set());
    const r = await remoteSet({ ...opts, provider: "zrok", options: { flags: {} } });
    expect(r).toMatchObject({ from: "none", provider: "zrok", origin: "https://a.share.zrok.io", applied: false });
    expect(log).toEqual(["detect:zrok"]);
    expect(existsSync(deploymentPath(I))).toBe(false);
    expect(lines.join("\n")).toContain("would: configure zrok; wait for its origin to answer from this Mac; write remote: zrok");
  });

  it("set: configure → the origin answers from this Mac → the record is written — then `set none` runs that provider's revoke", async () => {
    const log: string[] = [];
    const zrok = fakeProvider({ id: "zrok", origin: "https://a.share.zrok.io", log });
    const up = new Set(["https://a.share.zrok.io"]);
    const probes: string[] = [];
    const { I, lines, opts } = await base({ none, zrok }, up, probes);
    const r = await remoteSet({ ...opts, provider: "zrok", options: { flags: {} }, yes: true });
    expect(r).toMatchObject({ from: "none", provider: "zrok", origin: "https://a.share.zrok.io", applied: true });
    expect(log).toEqual(["detect:zrok", "configure:zrok"]);
    expect(probes).toEqual(["health:https://a.share.zrok.io", "identity:https://a.share.zrok.io"]);
    const written = parseDeployment(parseYamlish(await readFile(deploymentPath(I), "utf8")));
    expect(written.remote).toEqual({ provider: "zrok", mode: "funnel", origin: "https://a.share.zrok.io", settings: { upstream: "http://127.0.0.1:8081", node: "metistry-zrok" } });
    expect(written.shape).toBe("compose"); // the shape in effect, never a new decision
    expect(lines.join("\n")).toContain("answers from this Mac");

    // back to None: the preview names what revoke undoes and leaves; --yes runs it, and the record says none
    log.length = 0;
    const preview = await remoteSet({ ...opts, provider: "none", options: { flags: {} } });
    expect(preview.applied).toBe(false);
    expect(log).toEqual(["revoke:zrok:dry:record=zrok"]); // the real None adapter is asked, and it logs nothing
    expect(lines.join("\n")).toContain("phones added under https://a.share.zrok.io stop working");
    expect(lines.join("\n")).toContain("then undo at zrok: the zrok handler");
    expect(lines.join("\n")).toContain("left for you at zrok: the node in zrok's admin console");
    log.length = 0;
    const off = await remoteSet({ ...opts, provider: "none", options: { flags: {} }, yes: true });
    expect(off).toMatchObject({ from: "zrok", provider: "none", origin: null, applied: true, revoked: { undone: ["the zrok handler"], left_for_owner: ["the node in zrok's admin console"] } });
    expect(log).toEqual(["revoke:zrok:dry:record=zrok", "revoke:zrok:record=none"]); // the record already says none when zrok is undone
    expect(parseDeployment(parseYamlish(await readFile(deploymentPath(I), "utf8"))).remote).toEqual({ provider: "none", settings: {} });
  });

  it("switching: the new provider is configured first and the old one revoked only after the new origin answers", async () => {
    const log: string[] = [];
    const zrok = fakeProvider({ id: "zrok", origin: "https://a.share.zrok.io", log });
    const ngrok = fakeProvider({ id: "ngrok", origin: "https://b.ngrok-free.dev", log });
    const up = new Set(["https://a.share.zrok.io"]);
    const probes: string[] = [];
    const { I, opts } = await base({ none, zrok, ngrok }, up, probes);
    await remoteSet({ ...opts, provider: "zrok", options: { flags: {} }, yes: true });
    log.length = 0;
    probes.length = 0;

    // ngrok never comes up: nothing written, zrok not revoked, zrok still the record
    await expect(remoteSet({ ...opts, provider: "ngrok", options: { flags: {} }, yes: true })).rejects.toThrow(/https:\/\/b\.ngrok-free\.dev hasn't answered from this Mac within 0 s .*nothing was written and zrok is still in place/);
    expect(log).toEqual(["detect:ngrok", "revoke:zrok:dry:record=zrok", "configure:ngrok"]);
    expect(log.some((l) => l.startsWith("revoke:zrok:record="))).toBe(false);
    expect(probes.length).toBeGreaterThan(0);
    expect(probes.every((p) => p === "health:https://b.ngrok-free.dev")).toBe(true);
    expect(parseDeployment(parseYamlish(await readFile(deploymentPath(I), "utf8"))).remote?.provider).toBe("zrok");

    // ngrok comes up: the record flips, and only then is zrok revoked
    up.add("https://b.ngrok-free.dev");
    log.length = 0;
    probes.length = 0;
    const r = await remoteSet({ ...opts, provider: "ngrok", options: { flags: {} }, yes: true });
    expect(r).toMatchObject({ from: "zrok", provider: "ngrok", applied: true, revoked: { undone: ["the zrok handler"] } });
    // write BEFORE revoke: when zrok's revoke runs, deployment.yaml already names ngrok
    expect(log).toEqual(["detect:ngrok", "revoke:zrok:dry:record=zrok", "configure:ngrok", "revoke:zrok:record=ngrok"]);
    expect(probes).toEqual(["health:https://b.ngrok-free.dev", "identity:https://b.ngrok-free.dev"]);
    expect(parseDeployment(parseYamlish(await readFile(deploymentPath(I), "utf8"))).remote).toMatchObject({ provider: "ngrok", origin: "https://b.ngrok-free.dev" });
  });
});

describe("doctor's `remote:origins` row — a hand-written remote origin the record does not name", () => {
  it("None plus a remote origin in .env: the None row stays ok and a degraded row names the origin, the stranded passkeys and the honest interim", async () => {
    const P = await checkout();
    const I = await instance();
    const rows = await remoteRows({ deployment: { shape: "launchd", services: {} }, productDir: P, instanceDir: I, env: { METISTRY_INSTANCE_DIR: I, METISTRY_ORIGIN: "https://studio.ts.net,http://127.0.0.1:8080" }, fetchFn: fakeNet(new Set()).fetchFn, exec: fakeExec(), platform: "darwin", uid: 501 });
    expect(rows.map((r) => `${r.name}=${r.status}`)).toEqual(["remote=ok", "remote:origins=degraded"]);
    const row = rows[1]!;
    expect(row.remediation).toContain("METISTRY_ORIGIN in .env also names https://studio.ts.net, which the remote-access record (none) does not");
    expect(row.remediation).toContain("passkeys added at https://studio.ts.net no longer sign in");
    expect(row.remediation).toContain("`metistry remote set tailscale` (or another provider) is how a remote origin is configured");
    expect(row.meta).toMatchObject({ provider: "none", dropped: ["https://studio.ts.net"], origins: ["http://127.0.0.1:8080"] });
    // the same sentence `up` prints
    expect(droppedOriginsNote(["https://studio.ts.net"], REMOTE_NONE)).toBe(row.remediation);
    // nothing dropped: no row
    const clean = await remoteRows({ deployment: { shape: "launchd", services: {} }, productDir: P, instanceDir: I, env: { METISTRY_INSTANCE_DIR: I, METISTRY_ORIGIN: "http://127.0.0.1:8080" }, fetchFn: fakeNet(new Set()).fetchFn, exec: fakeExec(), platform: "darwin", uid: 501 });
    expect(clean.map((r) => r.name)).toEqual(["remote"]);
    // through doctor: degraded never fails the report
    const report = await doctor({ productDir: P, env: { METISTRY_INSTANCE_DIR: I, METISTRY_ORIGIN: "https://studio.ts.net" }, deployment: { shape: "compose", services: {} }, fetchFn: fakeNet(new Set()).fetchFn, db: null, exec: fakeExec({ docker: () => ({ code: 127, stdout: "", stderr: "not found" }) }), platform: "linux", uid: 501, appPath: null });
    expect(report.ok).toBe(true);
    expect(report.rows.find((r) => r.name === "remote:origins")?.status).toBe("degraded");
  });
});

describe("doctor's `remote` kind for a provider", () => {
  const dep = (remote: RemoteRecord): Deployment => ({ shape: "launchd", services: {}, remote });

  it("classifies where a recorded upstream points: the proxy port or socket, the MAIN port, elsewhere, nowhere", () => {
    const ctx = { consolePort: 8080, proxyPort: 8081, proxySocket: "/i/.metistry/state/console-proxy.sock" };
    expect(classifyUpstream("http://127.0.0.1:8081", ctx)).toBe("proxy");
    expect(classifyUpstream("127.0.0.1:8081", ctx)).toBe("proxy");
    expect(classifyUpstream("/i/.metistry/state/console-proxy.sock", ctx)).toBe("proxy");
    expect(classifyUpstream("unix:/i/.metistry/state/console-proxy.sock", ctx)).toBe("proxy");
    expect(classifyUpstream("http://127.0.0.1:8080", ctx)).toBe("main");
    expect(classifyUpstream("http://localhost:8080/", ctx)).toBe("main");
    expect(classifyUpstream("http://127.0.0.1:9000", ctx)).toBe("other");
    expect(classifyUpstream(undefined, ctx)).toBe("none");
    expect(classifyUpstream("", ctx)).toBe("none");
  });

  it("FAILS a provider whose upstream is the console's main port, in the plan's words — and passes the proxy listener", async () => {
    const P = await checkout();
    const I = await instance();
    const up = new Set(["https://a.share.zrok.io"]);
    const log: string[] = [];
    const providers: RemoteRegistry = { none, zrok: fakeProvider({ id: "zrok", origin: "https://a.share.zrok.io", log }) };
    const common = { productDir: P, instanceDir: I, env: { METISTRY_INSTANCE_DIR: I }, fetchFn: fakeNet(up).fetchFn, exec: fakeExec(), platform: "darwin" as const, uid: 501, providers };

    const bad = await remoteRows({ ...common, deployment: dep({ provider: "zrok", origin: "https://a.share.zrok.io", settings: { upstream: "http://127.0.0.1:8080" } }) });
    expect(bad.map((r) => r.name)).toEqual(["remote:zrok:tool", "remote:zrok:proxy-listener", "remote:zrok:answers", "remote:zrok:own"]);
    const proxy = bad.find((r) => r.name === "remote:zrok:proxy-listener")!;
    expect(proxy.status).toBe("failed");
    expect(proxy.remediation).toBe(mainPortRemediation("zrok"));
    expect(proxy.remediation).toBe("zrok is forwarding to the console's main port, which accepts this Mac's owner token. Run `metistry remote set zrok`.");
    expect(proxy.action).toEqual({ kind: "run_verb", command: ["metistry", "remote", "set", "zrok"], label: "Set up Fake zrok again" });
    expect(bad.find((r) => r.name === "remote:zrok:tool")).toMatchObject({ status: "ok", meta: { version: "9.9", from: "pack" } });
    expect(bad.find((r) => r.name === "remote:zrok:answers")).toMatchObject({ status: "ok", meta: { origin: "https://a.share.zrok.io" } });

    const good = await remoteRows({ ...common, deployment: dep({ provider: "zrok", origin: "https://a.share.zrok.io", settings: { upstream: "http://127.0.0.1:8081" } }) });
    expect(good.every((r) => r.status === "ok")).toBe(true);
    // a namespaced instance's proxy port is whatever the environment says, not +1
    const namespaced = await remoteRows({ ...common, env: { METISTRY_INSTANCE_DIR: I, METISTRY_CONSOLE_PORT: "8460", METISTRY_CONSOLE_PROXY_PORT: "8466" }, deployment: dep({ provider: "zrok", origin: "https://a.share.zrok.io", settings: { upstream: "http://127.0.0.1:8461" } }) });
    expect(namespaced.find((r) => r.name === "remote:zrok:proxy-listener")).toMatchObject({ status: "failed", remediation: expect.stringContaining("is not this console's proxy listener (port 8466") });

    // through doctor itself: the report fails
    const report = await doctor({ productDir: P, env: { METISTRY_INSTANCE_DIR: I }, deployment: dep({ provider: "zrok", origin: "https://a.share.zrok.io", settings: { upstream: "http://127.0.0.1:8080" } }), fetchFn: fakeNet(up).fetchFn, db: null, exec: fakeExec({ docker: () => ({ code: 127, stdout: "", stderr: "not found" }) }), platform: "linux", uid: 501, appPath: null, remoteProviders: providers });
    expect(report.ok).toBe(false);
    expect(report.rows.filter((r) => r.kind === "remote").map((r) => r.status)).toEqual(["ok", "failed", "ok", "ok"]);
  });

  it("an origin that does not answer from this Mac fails the `answers` row with enroll's own sentence; a record naming an adapter this version lacks is one failed row", async () => {
    const P = await checkout();
    const I = await instance();
    const providers: RemoteRegistry = { none, zrok: fakeProvider({ id: "zrok", origin: "https://a.share.zrok.io", log: [] }) };
    const common = { productDir: P, instanceDir: I, env: { METISTRY_INSTANCE_DIR: I }, fetchFn: fakeNet(new Set()).fetchFn, exec: fakeExec(), platform: "darwin" as const, uid: 501, providers, timeoutMs: 50 };
    const down = await remoteRows({ ...common, deployment: dep({ provider: "zrok", origin: "https://a.share.zrok.io", settings: { upstream: "http://127.0.0.1:8081" } }) });
    expect(down.find((r) => r.name === "remote:zrok:answers")).toMatchObject({ status: "failed", remediation: expect.stringContaining("https://a.share.zrok.io doesn't answer from this Mac, so your phone won't reach it either. Settings ▸ Remote Access shows what zrok reports.") });

    const unknown = await remoteRows({ ...common, deployment: dep({ provider: "relay", origin: "https://abc.u.metistry.app", settings: {} }) });
    expect(unknown).toHaveLength(1);
    expect(unknown[0]).toMatchObject({ kind: "remote", name: "remote", status: "failed", remediation: expect.stringContaining("names relay, which this version of Metistry has no adapter for"), action: { kind: "run_verb", command: ["metistry", "remote", "off"] } });

    // and `remote status` carries the same rows, exit 1
    await writeFile(deploymentPath(I), applyRemoteToYaml(undefined, { provider: "relay", origin: "https://abc.u.metistry.app", settings: {} }, "compose"));
    const s = await remoteStatus({ ...common, out: () => {} });
    expect(s).toMatchObject({ provider: "relay", mode: null, origin: "https://abc.u.metistry.app", origins: ["https://abc.u.metistry.app", "http://127.0.0.1:8080"], ok: false });
    expect(renderRemoteStatus(s, createUi({ noColor: true }))).toContain("no adapter");
    expect(remoteChoices(providers).filter((c) => c.available).map((c) => c.id)).toEqual(["none", "zrok"]);
  });
});
