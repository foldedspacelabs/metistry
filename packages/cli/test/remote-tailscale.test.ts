// The Tailscale adapter (plan §2.23, X-106): a fake node is driven through the
// whole flow — the pack, the launchd job, Tailscale's login URL and
// `BackendState`, the approval pages, `funnel`/`serve` to the PROXY listener,
// public DNS — and through `metistry remote set tailscale --yes`, which writes
// the record only once the origin answers. The JSON fields read from
// `status --json` and `funnel status --json` are pinned by recorded fixtures.
//
// Nothing here touches a real Tailscale: every subprocess is the exec fake,
// HOME is a temp dir, and the owner's-app candidates are paths that do not
// exist unless a test says they do.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse as parseYamlish } from "yaml";
import { parseDeployment, type Deployment, type RemoteRecord } from "@foldedspacelabs/metistry-core";
import { doctor } from "../src/doctor.js";
import { labelFor, renderAgentPlist } from "../src/launchd.js";
import { BOOLEAN_FLAGS, main, parseArgs } from "../src/main.js";
import { none, remoteRows, remoteSet, remoteStatus, mainPortRemediation, type RemoteContext, type RemoteProvider, type RemoteRegistry } from "../src/remote/index.js";
import {
  APP_CLI_CANDIDATES,
  approvalLinksIn,
  BACKEND_STATES,
  chooseNodeSource,
  dnsNameOf,
  DNS_TIMEOUT_MS,
  handlerOf,
  hasCapability,
  isOpenableUrl,
  KEY_EXPIRY_WARN_DAYS,
  nodeNameFor,
  parseMode,
  parseServeConfig,
  parseStatus,
  stateRows,
  TAILNET_PHONE_NOTE,
  TAILSCALE_NODE_SERVICE,
  tailscale,
  tailscaleProvider,
  tailscaleSocketPath,
  tailscaleStateDir,
  type TailscaleDeps,
  type TailscaleServeConfig,
  type TailscaleStatus,
} from "../src/remote/tailscale.js";
import { remoteToolDir } from "../src/runtime-deps.js";
import { checkout, fakeExec } from "./fixtures.js";

const INSTANCE_ID = "11111111-1111-4111-8111-111111111111";
const NODE = "metistry-11111111";
const NAME = `${NODE}.tail1234.ts.net`;
const ORIGIN = `https://${NAME}`;
const AUTH_URL = "https://login.tailscale.com/a/0123456789abcdef";
const FUNNEL_URL = "https://login.tailscale.com/f/funnel?node=nAbCdEf1234";
const HTTPS_URL = "https://login.tailscale.com/f/https?node=nAbCdEf1234";
const APP_CLI = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";

const SHORT_TMP = process.platform === "darwin" ? "/tmp" : tmpdir();
const fixture = (name: string) => readFileSync(new URL(`./fixtures/tailscale/${name}`, import.meta.url), "utf8");
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/**
 * A short root on purpose: the node's socket is `<instance>/.metistry/state/run/tailscaled.sock`, and the adapter holds
 * that path to the kernel's 103-byte limit exactly as `up` holds Postgres's — macOS's per-user temp dir plus a mkdtemp
 * name is already over it, where the Mac app's `~/Library/Application Support/Metistry/<name>` is under it.
 */
async function instance(root: string = SHORT_TMP): Promise<string> {
  const dir = await mkdtemp(join(root, "mts-"));
  await mkdir(join(dir, ".metistry", "state"), { recursive: true });
  await writeFile(join(dir, ".metistry", "identity.yaml"), `name: Test\ninstance_id: ${INSTANCE_ID}\n`);
  return dir;
}

/** A product checkout with Metistry's Tailscale pack already fetched (the fetch path itself is remote-packs.test.ts). */
async function product(opts: { pack?: boolean } = {}): Promise<string> {
  const P = await checkout();
  if (opts.pack !== false) {
    const dir = remoteToolDir(P, "tailscale");
    await mkdir(join(dir, "bin"), { recursive: true });
    const bins = { "bin/tailscale": "#!/bin/sh\necho tailscale\n", "bin/tailscaled": "#!/bin/sh\necho tailscaled\n" };
    for (const [rel, body] of Object.entries(bins)) await writeFile(join(dir, rel), body, { mode: 0o755 });
    await writeFile(join(dir, "manifest.json"), JSON.stringify({ schema: 1, tool: "tailscale", version: "1.104.1", target: "darwin-arm64", signed: true, binaries: Object.fromEntries(Object.entries(bins).map(([r, b]) => [r, sha256(b)])) }));
    await writeFile(join(dir, ".release"), "0.9.0\n");
    await writeFile(join(dir, "LICENSE"), "BSD-3\n");
  }
  return P;
}

const deploymentPath = (I: string) => join(I, ".metistry", "deployment.yaml");
const readRecord = async (I: string) => parseDeployment(parseYamlish(await readFile(deploymentPath(I), "utf8"))).remote;

interface WorldOptions {
  /** the owner's app: absent, installed but stopped, or running (signed in) */
  app?: "absent" | "stopped" | "running";
  /** how many `status` polls after `up` until the owner has finished signing in (default 2); Infinity = never */
  signInAfterPolls?: number;
  /** Tailscale asks these approvals the first time the handler is set */
  approvals?: ("funnel" | "https")[];
  /** what the live serve config forwards to — default the proxy listener the command named */
  forwardTo?: string;
  /** the proxy listener answers with X-111's headers (default true); false = an old console; "down" = nothing answers */
  proxyLimits?: boolean | "down";
  /** public DNS resolves the name (default true) */
  dns?: boolean;
  /** the origin answers from this Mac (default true) */
  originUp?: boolean;
  /** the bundled daemon is already running when the test starts */
  daemonUp?: boolean;
  keyExpiry?: string | null;
  caps?: string[];
  /** the node's DNS name as Tailscale reports it (default NAME); "" = MagicDNS off */
  dnsName?: string;
}

/** A fake Tailscale — the bundled node and the owner's app — behind the exec seam, with the state every verb leaves behind. */
function world(P: string, I: string, o: WorldOptions = {}) {
  const packCli = join(remoteToolDir(P, "tailscale"), "bin", "tailscale");
  const sock = tailscaleSocketPath(I);
  const state = {
    daemonUp: o.daemonUp ?? false,
    backend: (o.daemonUp ? "NeedsLogin" : "NoState") as string,
    upCalled: false,
    polls: 0,
    approvalsPending: new Set(o.approvals ?? []),
    serve: {} as TailscaleServeConfig,
    loggedOut: false,
    app: { backend: o.app === "running" ? "Running" : o.app === "stopped" ? "Stopped" : "NoState", serve: {} as TailscaleServeConfig, handlerOff: false },
    opened: [] as string[],
    launchctl: [] as string[],
    tailscale: [] as string[],
    /** when set, the node reports this instead of Tailscale's login URL */
    badAuthUrl: undefined as string | undefined,
  };
  const dnsName = o.dnsName ?? NAME;
  const status = (backend: string, hostName: string): TailscaleStatus => {
    const base = JSON.parse(fixture(backend === "NeedsLogin" ? "status-needs-login.json" : "status-running.json")) as TailscaleStatus;
    base.BackendState = backend;
    if (backend !== "NeedsLogin" && backend !== "NoState") {
      base.Self = { ...base.Self, HostName: hostName, DNSName: dnsName ? `${dnsName}.` : "", ...(o.caps ? { CapMap: Object.fromEntries(o.caps.map((c) => [c, null])), Capabilities: o.caps } : {}), ...(o.keyExpiry === null ? { KeyExpiry: undefined } : o.keyExpiry ? { KeyExpiry: o.keyExpiry } : {}) };
      if (o.keyExpiry === null) delete base.Self.KeyExpiry;
    }
    return base;
  };
  const handle = (node: "pack" | "app") => (args: string[]) => {
    state.tailscale.push(`${node}: ${args.join(" ")}`);
    const a = node === "pack" ? args.filter((x) => x !== `--socket=${sock}`) : args;
    if (node === "pack" && args[0] !== `--socket=${sock}`) return { code: 2, stdout: "", stderr: `the bundled CLI must be told its socket (got ${args.join(" ")})` };
    const st = node === "pack" ? state : state.app;
    if (node === "pack" && !state.daemonUp) return { code: 1, stdout: "", stderr: `failed to connect to local Tailscale daemon for ${sock}; is Tailscale running?` };
    const hostName = node === "pack" ? NODE : "studio";
    const verb = a[0];
    if (verb === "version") return { code: 0, stdout: "1.104.1\n  tailscale commit: abc\n", stderr: "" };
    if (verb === "status" && a[1] === "--json") {
      if (node === "pack" && state.upCalled && state.backend !== "Running") {
        state.polls++;
        if (state.polls >= (o.signInAfterPolls ?? 2)) state.backend = "Running";
      }
      return { code: 0, stdout: JSON.stringify(status(st.backend, hostName)), stderr: "" };
    }
    if (verb === "up") {
      if (st.backend === "Running") return { code: 0, stdout: "", stderr: "" };
      if (node === "pack") {
        state.upCalled = true;
        state.backend = "NeedsLogin";
        return { code: 1, stdout: JSON.stringify({ AuthURL: state.badAuthUrl ?? AUTH_URL, QR: "data:image/png;base64,AAAA", BackendState: "NeedsLogin" }), stderr: "timeout waiting for Tailscale service to enter a Running state; check health with \"tailscale status\"\n" };
      }
      return { code: 1, stdout: "", stderr: "Tailscale is stopped.\n" };
    }
    if ((verb === "funnel" || verb === "serve") && a[1] === "status" && a[2] === "--json") return { code: 0, stdout: JSON.stringify(st.serve), stderr: "" };
    if ((verb === "funnel" || verb === "serve") && a[1] === "--bg") {
      if (st.backend !== "Running") return { code: 1, stdout: "", stderr: "Tailscale is not running.\n" };
      const target = a[3];
      if (node === "pack" && state.approvalsPending.size > 0) {
        const lines: string[] = [];
        if (state.approvalsPending.has("https")) lines.push("Tailscale Serve needs HTTPS certificates to be enabled for your tailnet.", "To enable, visit:", "", `\t${HTTPS_URL}`, "");
        if (verb === "funnel" && state.approvalsPending.has("funnel")) lines.push("Funnel is not enabled on your tailnet.", "To enable, visit:", "", `\t${FUNNEL_URL}`, "");
        if (lines.length > 0) {
          // the owner clicks the page between this refusal and the next try
          state.approvalsPending.clear();
          return { code: 1, stdout: "", stderr: lines.join("\n") };
        }
      }
      const hostPort = `${dnsName}:443`;
      st.serve = { TCP: { "443": { HTTPS: true } }, Web: { [hostPort]: { Handlers: { "/": { Proxy: o.forwardTo ?? target ?? "" } } } }, ...(verb === "funnel" ? { AllowFunnel: { [hostPort]: true } } : {}) };
      return { code: 0, stdout: `Available ${verb === "funnel" ? "on the internet" : "within your tailnet"}:\n\nhttps://${dnsName}/\n|-- proxy ${target}\n`, stderr: "" };
    }
    if ((verb === "funnel" || verb === "serve") && a[1] === "--https=443" && a[2] === "off") {
      st.serve = {};
      if (node === "app") state.app.handlerOff = true;
      return { code: 0, stdout: "", stderr: "" };
    }
    if (verb === "serve" && a[1] === "reset") {
      st.serve = {};
      return { code: 0, stdout: "", stderr: "" };
    }
    if (verb === "logout") {
      if (node === "pack") {
        state.loggedOut = true;
        state.backend = "NeedsLogin";
        state.upCalled = false;
        state.polls = 0;
      }
      return { code: 0, stdout: "", stderr: "" };
    }
    return { code: 2, stdout: "", stderr: `fake tailscale: unknown command ${a.join(" ")}` };
  };
  const exec = fakeExec({
    [packCli]: handle("pack"),
    [APP_CLI]: handle("app"),
    launchctl: (args) => {
      // only the node's own job: the protected write asks launchctl about the reconciler too
      if (!args.join(" ").includes(`.${TAILSCALE_NODE_SERVICE}`)) return undefined;
      state.launchctl.push(args.join(" "));
      if (args[0] === "bootstrap") state.daemonUp = true;
      if (args[0] === "bootout") state.daemonUp = false;
      return undefined; // print → exit 1 (not loaded), the fixture's default
    },
    open: (args) => {
      state.opened.push(args[0] ?? "");
      return { code: 0, stdout: "", stderr: "" };
    },
  });
  const probes: string[] = [];
  const fetchFn = (async (input: string | URL | Request) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    probes.push(`${url.host}${url.pathname}`);
    if (url.host === "127.0.0.1:8081") {
      if (o.proxyLimits === "down") throw new Error("fetch failed: ECONNREFUSED");
      return new Response(JSON.stringify({ error: "misdirected" }), { status: 421, headers: o.proxyLimits === false ? {} : { "strict-transport-security": "max-age=31536000; includeSubDomains", "content-security-policy": "default-src 'self'" } });
    }
    if (url.origin === ORIGIN && (o.originUp ?? true)) return new Response(JSON.stringify({ instance_id: INSTANCE_ID }), { status: 200, headers: { "content-type": "application/json" } });
    throw new Error("fetch failed");
  }) as unknown as typeof fetch;
  let clock = 1_700_000_000_000;
  const deps: Partial<TailscaleDeps> = {
    appCliCandidates: APP_CLI_CANDIDATES,
    exists: (p) => p === APP_CLI && (o.app ?? "absent") !== "absent",
    lookup: async () => ((o.dns ?? true) ? ["203.0.113.10"] : []),
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => clock,
    pollMs: 1,
    signInTimeoutMs: 50,
    approvalTimeoutMs: 50,
    dnsTimeoutMs: 50,
    nodeStartTimeoutMs: 50,
  };
  return { exec, state, fetchFn, probes, deps, provider: tailscaleProvider(deps), packCli, sock };
}

/** `remoteSet`'s options for a test, with HOME in a temp dir so the node's plist never lands in the real ~/Library/LaunchAgents. */
async function setOpts(P: string, I: string, w: ReturnType<typeof world>, providers: RemoteRegistry, lines: string[] = []) {
  const home = await mkdtemp(join(tmpdir(), "metistry-ts-home-"));
  return {
    home,
    opts: {
      productDir: P,
      instanceDir: I,
      env: { METISTRY_INSTANCE_DIR: I, HOME: home } as NodeJS.ProcessEnv,
      platform: "darwin" as const,
      uid: 501,
      fetchFn: w.fetchFn,
      exec: w.exec,
      out: (l: string) => lines.push(l),
      providers,
      pollMs: 1,
      sleep: async () => {},
      waitMs: 50,
      timeoutMs: 50,
    },
  };
}

const plistPath = (home: string) => join(home, "Library", "LaunchAgents", `${labelFor(TAILSCALE_NODE_SERVICE)}.plist`);

describe("the JSON Tailscale reports — the fixtures pin the fields read", () => {
  it("`status --json`: BackendState, AuthURL, Self.DNSName (trailing dot), Self.KeyExpiry, the capabilities", () => {
    const running = parseStatus(fixture("status-running.json"))!;
    expect(running.BackendState).toBe("Running");
    expect(dnsNameOf(running)).toBe(NAME);
    expect(running.Self?.HostName).toBe(NODE);
    expect(running.Self?.KeyExpiry).toBe("2027-04-17T12:00:00Z");
    expect(hasCapability(running, "https")).toBe(true);
    expect(hasCapability(running, "funnel")).toBe(true);
    expect(hasCapability(running, "nope")).toBe(false);
    // older builds: the list alone
    expect(hasCapability({ BackendState: "Running", Self: { Capabilities: ["funnel"] } }, "funnel")).toBe(true);
    expect(hasCapability({ BackendState: "Running", Self: { CapMap: { https: null } } }, "https")).toBe(true);
    const needs = parseStatus(fixture("status-needs-login.json"))!;
    expect(needs.BackendState).toBe("NeedsLogin");
    expect(needs.AuthURL).toBe(AUTH_URL);
    expect(dnsNameOf(needs)).toBeUndefined(); // "" — no name until signed in
    expect(hasCapability(needs, "https")).toBe(false);
    expect(parseStatus("not json")).toBeUndefined();
    expect(parseStatus('{"Version":"1"}')).toBeUndefined(); // no BackendState is not a status
  });

  it("`funnel status --json` / `serve status --json`: Web[<name>:443].Handlers['/'].Proxy and AllowFunnel[<name>:443]", () => {
    const funnel = parseServeConfig(fixture("funnel-status.json"))!;
    expect(handlerOf(funnel, `${NAME}:443`)).toEqual({ proxy: "http://127.0.0.1:8081", funnel: true });
    expect(handlerOf(funnel, "other.tail1234.ts.net:443")).toEqual({ proxy: undefined, funnel: false });
    const serve = parseServeConfig(fixture("serve-status-main-port.json"))!;
    expect(handlerOf(serve, "studio.tail1234.ts.net:443")).toEqual({ proxy: "http://127.0.0.1:8080", funnel: false });
    // an empty config prints nothing (or null): no handler, not an error
    expect(handlerOf(parseServeConfig(""), `${NAME}:443`)).toEqual({ proxy: undefined, funnel: false });
    expect(parseServeConfig("null")).toEqual({});
    expect(parseServeConfig("{broken")).toBeUndefined();
  });

  it("the approval pages a command's output offers are each named for what they approve, once", () => {
    const text = `Tailscale Serve needs HTTPS certificates to be enabled for your tailnet.\nTo enable, visit:\n\n\t${HTTPS_URL}\n\nFunnel is not enabled on your tailnet.\nTo enable, visit:\n\n\t${FUNNEL_URL}\n\t${FUNNEL_URL}\n`;
    expect(approvalLinksIn(text)).toEqual([
      { url: HTTPS_URL, what: "HTTPS" },
      { url: FUNNEL_URL, what: "Funnel" },
    ]);
    expect(approvalLinksIn("Available on the internet:\n\nhttps://x.ts.net/\n")).toEqual([]);
    expect(approvalLinksIn(`see https://login.tailscale.com/admin/dns`)).toEqual([{ url: "https://login.tailscale.com/admin/dns", what: "a Tailscale setting" }]);
  });
});

describe("each BackendState maps to its row and its sentence", () => {
  it("the table, for the bundled node and for the owner's app", () => {
    expect(BACKEND_STATES).toEqual(["NoState", "NeedsLogin", "NeedsMachineAuth", "Stopped", "Starting", "Running"]);
    const pack = Object.fromEntries(BACKEND_STATES.map((s) => [s, stateRows(s, "pack")]));
    const app = Object.fromEntries(BACKEND_STATES.map((s) => [s, stateRows(s, "app")]));
    expect(pack.Running).toEqual({ running: { status: "ok", sentence: "This Mac's Metistry node is running." }, signedIn: { status: "ok", sentence: "Signed in to Tailscale." } });
    expect(pack.NeedsLogin!.signedIn).toEqual({ status: "failed", sentence: "This Mac's Metistry node isn't signed in to Tailscale. Sign in again (`metistry remote authorize tailscale`)." });
    expect(pack.NeedsLogin!.running.status).toBe("ok"); // the daemon is up; it is the sign-in that is missing
    expect(pack.NeedsMachineAuth!.signedIn).toMatchObject({ status: "degraded", sentence: expect.stringContaining("waiting for approval in your Tailscale admin console") });
    expect(pack.Stopped!.running).toMatchObject({ status: "failed", sentence: expect.stringContaining("`metistry remote set tailscale`") });
    expect(pack.NoState!.running.status).toBe("failed");
    expect(pack.Starting!.signedIn.status).toBe("degraded");
    expect(app.NeedsLogin!.signedIn.sentence).toBe("This Mac isn't signed in to Tailscale. Sign in from the Tailscale menu.");
    expect(app.Stopped!.running.sentence).toBe("Tailscale is installed but not connected. Open Tailscale and turn it on.");
    expect(stateRows("Weird", "pack").running).toMatchObject({ status: "degraded", sentence: expect.stringContaining("unknown state (Weird)") });
  });

  it("through `status`: the node and signed-in rows carry the state's status and sentence", async () => {
    const P = await product();
    const I = await instance();
    const record: RemoteRecord = { provider: "tailscale", mode: "funnel", origin: ORIGIN, settings: { upstream: "http://127.0.0.1:8081", node: NODE, node_from: "pack", handler: `${NAME}:443` } };
    for (const [backend, running, signedIn] of [
      ["Running", "ok", "ok"],
      ["NeedsLogin", "ok", "failed"],
      ["NeedsMachineAuth", "ok", "degraded"],
      ["Starting", "ok", "degraded"],
      ["Stopped", "failed", "failed"],
    ] as const) {
      const w = world(P, I, { daemonUp: true });
      w.state.backend = backend;
      const rows = await remoteRows({ deployment: { shape: "launchd", services: {}, remote: record }, productDir: P, instanceDir: I, env: { METISTRY_INSTANCE_DIR: I }, fetchFn: w.fetchFn, exec: w.exec, platform: "darwin", uid: 501, providers: { none, tailscale: w.provider } });
      const node = rows.find((r) => r.name === "remote:tailscale:node")!;
      const signed = rows.find((r) => r.name === "remote:tailscale:signed-in")!;
      expect(node.status, backend).toBe(running);
      expect(signed.status, backend).toBe(signedIn);
      const expected = stateRows(backend, "pack");
      expect(signed.status === "ok" ? signed.meta?.["info"] : signed.remediation, backend).toContain(expected.signedIn.sentence);
      expect(node.status === "ok" ? node.meta?.["info"] : node.remediation, backend).toContain(expected.running.sentence);
      expect(signed.meta).toMatchObject({ backend_state: backend, node_from: "pack" });
    }
    // the daemon not running at all: both rows fail with the one sentence, and the signed-in row offers the sign-in verb
    const down = world(P, I, { daemonUp: false });
    const rows = await remoteRows({ deployment: { shape: "launchd", services: {}, remote: record }, productDir: P, instanceDir: I, env: { METISTRY_INSTANCE_DIR: I }, fetchFn: down.fetchFn, exec: down.exec, platform: "darwin", uid: 501, providers: { none, tailscale: down.provider } });
    expect(rows.find((r) => r.name === "remote:tailscale:node")).toMatchObject({ status: "failed", remediation: "This Mac's Metistry node isn't running. Run `metistry remote set tailscale` to start it.", action: { command: ["metistry", "remote", "set", "tailscale"] } });
    expect(rows.find((r) => r.name === "remote:tailscale:signed-in")).toMatchObject({ status: "failed", action: { command: ["metistry", "remote", "authorize", "tailscale"] } });
  });
});

describe("which node: the owner's app when it is running, else the bundled one — behind one switch", () => {
  it("chooseNodeSource: --use-app, --bundled, both, neither, and a recorded choice", () => {
    expect(chooseNodeSource({}, true)).toBe("app");
    expect(chooseNodeSource({}, false)).toBe("pack");
    expect(chooseNodeSource({ "use-app": true }, false)).toBe("app");
    expect(chooseNodeSource({ bundled: true }, true)).toBe("pack");
    expect(chooseNodeSource({}, true, "pack")).toBe("pack"); // status/revoke act on the node configure set up
    expect(chooseNodeSource({}, false, "app")).toBe("app");
    expect(() => chooseNodeSource({ "use-app": true, bundled: true }, true)).toThrow(/contradict/);
    expect(parseMode(undefined)).toBe("funnel");
    expect(parseMode("tailnet")).toBe("tailnet");
    expect(() => parseMode("public")).toThrow(/--mode takes funnel .* or tailnet/);
    expect(nodeNameFor(INSTANCE_ID)).toBe(NODE);
  });

  it("detect is read-only and says which node it found: the running app as the owner's install, else the pack (or nothing)", async () => {
    const P = await product();
    const I = await instance();
    const ctx = (w: ReturnType<typeof world>): RemoteContext => ({ productDir: P, instanceDir: I, env: {}, instanceId: INSTANCE_ID, record: { provider: "none", settings: {} }, consolePort: 8080, proxyPort: 8081, proxySocket: "/x.sock", exec: w.exec, fetchFn: w.fetchFn, platform: "darwin", uid: 501, readToken: async () => "", note: () => {}, dryRun: true, timeoutMs: 50 });
    const app = world(P, I, { app: "running" });
    const d1 = await app.provider.detect(ctx(app));
    expect(d1.tool).toEqual({ present: true, from: "owner", version: "1.104.1" });
    expect(d1.signed_in).toBe(true);
    expect(d1.would_change.join("\n")).toContain("point `tailscale funnel` at the proxy listener http://127.0.0.1:8081");
    const stopped = world(P, I, { app: "stopped" });
    const d2 = await stopped.provider.detect(ctx(stopped));
    expect(d2.tool).toEqual({ present: true, from: "pack", version: "1.104.1" }); // an app that is not running is not preferred
    expect(d2.signed_in).toBe(false);
    expect(d2.would_change[0]).toContain("start the bundled node as a launchd job");
    const bare = world(await product({ pack: false }), I, {});
    const d3 = await bare.provider.detect({ ...ctx(bare), productDir: await product({ pack: false }) });
    expect(d3.tool).toEqual({ present: false });
    expect(d3.would_change[0]).toContain("fetch Metistry's Tailscale pack");
    // nothing was started, opened or written by any of that
    for (const w of [app, stopped, bare]) {
      expect(w.state.launchctl).toEqual([]);
      expect(w.state.opened).toEqual([]);
    }
    expect(existsSync(tailscaleStateDir(I))).toBe(false);
  });

  it("--use-app with no Tailscale on the Mac is refused naming the install; --bundled beside a running app takes the pack", async () => {
    const P = await product();
    const I = await instance();
    const w = world(P, I, { app: "absent" });
    const { opts } = await setOpts(P, I, w, { none, tailscale: w.provider });
    await expect(remoteSet({ ...opts, provider: "tailscale", options: { flags: { "use-app": true } }, yes: true })).rejects.toThrow(/Tailscale isn't installed on this Mac — --use-app needs the Tailscale app .* nothing was written/);
    expect(existsSync(deploymentPath(I))).toBe(false);
    expect(w.state.launchctl).toEqual([]);
    const both = world(P, I, { app: "running" });
    const b = await setOpts(P, I, both, { none, tailscale: both.provider });
    await expect(remoteSet({ ...b.opts, provider: "tailscale", options: { flags: { "use-app": true, bundled: true } }, yes: true })).rejects.toThrow(/contradict/);
    const forced = await remoteSet({ ...b.opts, provider: "tailscale", options: { flags: { bundled: true } }, yes: true });
    expect(forced.applied).toBe(true);
    expect((await readRecord(I))?.settings["node_from"]).toBe("pack");
    expect(both.state.tailscale.some((l) => l.startsWith("app:") && l.includes("funnel --bg"))).toBe(false);
    expect(both.state.tailscale.some((l) => l.startsWith("pack:") && l.includes("funnel --bg"))).toBe(true);
  });
});

describe("`metistry remote set tailscale --yes` — Funnel, the bundled node, end to end", () => {
  it("fetches nothing twice, starts the node as a launchd job, signs in through the login URL, approves, forwards to the PROXY port, waits for DNS, writes the record", async () => {
    const P = await product();
    const I = await instance();
    const w = world(P, I, { approvals: ["https", "funnel"] });
    const lines: string[] = [];
    const { home, opts } = await setOpts(P, I, w, { none, tailscale: w.provider }, lines);
    const r = await remoteSet({ ...opts, provider: "tailscale", options: { flags: {} }, yes: true });
    expect(r).toMatchObject({ from: "none", provider: "tailscale", origin: ORIGIN, applied: true });

    // the record: funnel, the origin, the proxy listener as upstream — never the main port — and which node
    expect(await readRecord(I)).toEqual({ provider: "tailscale", mode: "funnel", origin: ORIGIN, settings: { upstream: "http://127.0.0.1:8081", node: NODE, node_from: "pack", handler: `${NAME}:443` } });

    // the node's job: a plist under THIS home, bootstrapped by the launchd sequence, tailscaled unprivileged in userspace mode with its state under the instance
    const label = labelFor(TAILSCALE_NODE_SERVICE);
    expect(label).toBe("com.foldedspacelabs.metistry.tailscale");
    const plist = await readFile(plistPath(home), "utf8");
    expect(plist).toContain(`<string>${join(remoteToolDir(P, "tailscale"), "bin", "tailscaled")}</string>`);
    expect(plist).toContain("<string>--tun=userspace-networking</string>");
    expect(plist).toContain(`<string>--statedir=${tailscaleStateDir(I)}</string>`);
    expect(plist).toContain(`<string>--socket=${w.sock}</string>`);
    expect(plist).toContain("<string>--port=0</string>"); // never the owner's app's 41641
    expect(plist).toContain(`<key>METISTRY_INSTANCE_DIR</key><string>${I}</string>`);
    expect(plist).toContain("<key>KeepAlive</key><true/>");
    expect(plist).toContain("<key>StandardOutPath</key><string>/tmp/metistry-tailscale.log</string>");
    expect(w.state.launchctl).toEqual([`bootout gui/501/${label}`, `print gui/501/${label}`, `bootstrap gui/501 ${plistPath(home)}`, `kickstart -k gui/501/${label}`]);

    // the state directory is 0700 — and so is the socket's directory: tailscaled's socket is 0666, so the directory is the only guard
    expect(((await stat(tailscaleStateDir(I))).mode & 0o777).toString(8)).toBe("700");
    expect(((await stat(join(w.sock, ".."))).mode & 0o777).toString(8)).toBe("700");

    // sign-in: `up` under Metistry's hostname, the login URL opened, completion read from BackendState
    expect(w.state.tailscale).toContain(`pack: --socket=${w.sock} up --json --timeout=10s --hostname=${NODE} --accept-dns=false --accept-routes=false`);
    expect(w.state.opened[0]).toBe(AUTH_URL);
    expect(lines.join("\n")).toContain(`sign in to Tailscale at: ${AUTH_URL}`);

    // the handler: funnel, 443, to the proxy listener; each approval page surfaced once and the command retried
    const funnels = w.state.tailscale.filter((l) => l.includes("funnel --bg"));
    expect(funnels.length).toBe(2); // refused with the approval links, then set
    expect(funnels[0]).toBe(`pack: --socket=${w.sock} funnel --bg --https=443 http://127.0.0.1:8081`);
    expect(w.state.opened.slice(1)).toEqual([HTTPS_URL, FUNNEL_URL]);
    expect(lines.join("\n")).toContain(`approve HTTPS for this node — one click at: ${HTTPS_URL}`);
    expect(lines.join("\n")).toContain(`approve Funnel for this node — one click at: ${FUNNEL_URL}`);
    expect(w.state.tailscale.some((l) => l.includes("8080"))).toBe(false);

    // public DNS awaited with Tailscale's own ten minutes, then the origin had to answer from this Mac before the write
    expect(lines.join("\n")).toContain(`Waiting for ${NAME} to appear on the internet — this can take up to 10 minutes.`);
    expect(DNS_TIMEOUT_MS).toBe(10 * 60_000); // the sentence is Tailscale's own number, and so is the wait behind it
    expect(w.probes).toContain(`${NAME}/health`);
    expect(w.probes[0]).toBe("127.0.0.1:8081/health"); // X-111's limits were checked before anything else

    // doctor afterwards: every tailscale row ok
    const rows = await remoteRows({ deployment: { shape: "launchd", services: {}, remote: (await readRecord(I))! }, productDir: P, instanceDir: I, env: { METISTRY_INSTANCE_DIR: I }, fetchFn: w.fetchFn, exec: w.exec, platform: "darwin", uid: 501, providers: { none, tailscale: w.provider } });
    expect(rows.map((x) => `${x.name}=${x.status}`)).toEqual([
      "remote:tailscale:tool=ok",
      "remote:tailscale:proxy-listener=ok",
      "remote:tailscale:answers=ok",
      "remote:tailscale:node=ok",
      "remote:tailscale:signed-in=ok",
      "remote:tailscale:state-dir=ok",
      "remote:tailscale:https=ok",
      "remote:tailscale:funnel=ok",
      "remote:tailscale:handler=ok",
      "remote:tailscale:public-name=ok",
      "remote:tailscale:key-expiry=ok",
    ]);
    expect(rows.find((x) => x.name === "remote:tailscale:tool")?.meta).toMatchObject({ version: "1.104.1", from: "pack" });

    // a second `set` is idempotent: no second sign-in, the handler re-asserted, the same record
    const again = await remoteSet({ ...opts, provider: "tailscale", options: { flags: {} }, yes: true });
    expect(again.applied).toBe(true);
    expect(w.state.opened).toHaveLength(3);
  });

  it("tailnet mode: `serve`, no X-111 gate, no public DNS wait, and the sheet's sentence", async () => {
    const P = await product();
    const I = await instance();
    const w = world(P, I, { proxyLimits: false, dns: false });
    const lines: string[] = [];
    const { opts } = await setOpts(P, I, w, { none, tailscale: w.provider }, lines);
    const r = await remoteSet({ ...opts, provider: "tailscale", options: { mode: "tailnet", flags: {} }, yes: true });
    expect(r).toMatchObject({ provider: "tailscale", origin: ORIGIN, applied: true });
    expect(await readRecord(I)).toMatchObject({ mode: "tailnet", settings: { upstream: "http://127.0.0.1:8081", node_from: "pack" } });
    expect(w.state.tailscale.some((l) => l.endsWith("serve --bg --https=443 http://127.0.0.1:8081"))).toBe(true);
    expect(w.state.tailscale.some((l) => l.includes("funnel"))).toBe(false);
    expect(lines.join("\n")).toContain(TAILNET_PHONE_NOTE);
    expect(lines.join("\n")).not.toContain("appear on the internet");
    const rows = await remoteRows({ deployment: { shape: "launchd", services: {}, remote: (await readRecord(I))! }, productDir: P, instanceDir: I, env: { METISTRY_INSTANCE_DIR: I }, fetchFn: w.fetchFn, exec: w.exec, platform: "darwin", uid: 501, providers: { none, tailscale: w.provider } });
    expect(rows.map((x) => x.name)).not.toContain("remote:tailscale:funnel");
    expect(rows.map((x) => x.name)).not.toContain("remote:tailscale:public-name");
    expect(rows.every((x) => x.status === "ok")).toBe(true);
  });

  it("--mode is validated before anything runs", async () => {
    const P = await product();
    const I = await instance();
    const w = world(P, I);
    const { opts } = await setOpts(P, I, w, { none, tailscale: w.provider });
    await expect(remoteSet({ ...opts, provider: "tailscale", options: { mode: "public", flags: {} }, yes: true })).rejects.toThrow(/--mode takes funnel .* or tailnet/);
    expect(w.state.launchctl).toEqual([]);
    expect(w.probes).toEqual([]);
    expect(existsSync(deploymentPath(I))).toBe(false);
  });
});

describe("funnel mode refuses to configure before X-111's limits are on", () => {
  it("a proxy listener without the hardening headers: refused by name, nothing fetched, started, opened or written", async () => {
    const P = await product();
    const I = await instance();
    const w = world(P, I, { proxyLimits: false });
    const { home, opts } = await setOpts(P, I, w, { none, tailscale: w.provider });
    await expect(remoteSet({ ...opts, provider: "tailscale", options: { flags: {} }, yes: true })).rejects.toThrow(/isn't the hardened proxy listener — its answers carry none of the rate-limit headers Funnel waits on \(plan §2\.23, X-111\).*--mode tailnet.*nothing was written and remote access is still none/);
    expect(w.probes).toEqual(["127.0.0.1:8081/health"]);
    expect(w.state.launchctl).toEqual([]);
    expect(w.state.tailscale.every((l) => l.endsWith("status --json"))).toBe(true); // detect's read-only look, nothing more
    expect(w.state.opened).toEqual([]);
    expect(existsSync(plistPath(home))).toBe(false);
    expect(existsSync(tailscaleStateDir(I))).toBe(false);
    expect(existsSync(deploymentPath(I))).toBe(false);
  });

  it("no proxy listener answering at all: refused naming `metistry up`", async () => {
    const P = await product();
    const I = await instance();
    const w = world(P, I, { proxyLimits: "down" });
    const { opts } = await setOpts(P, I, w, { none, tailscale: w.provider });
    await expect(remoteSet({ ...opts, provider: "tailscale", options: { flags: {} }, yes: true })).rejects.toThrow(/proxy listener isn't answering on 127\.0\.0\.1:8081 .*`metistry up` first/);
    expect(w.state.launchctl).toEqual([]);
    expect(existsSync(deploymentPath(I))).toBe(false);
  });
});

describe("a handler pointing at the main port fails doctor", () => {
  const dep = (remote: RemoteRecord): Deployment => ({ shape: "launchd", services: {}, remote });

  it("the LIVE serve config forwarding to the console's main port fails the handler row with the plan's sentence — whatever the record says", async () => {
    const P = await product();
    const I = await instance();
    const w = world(P, I, { daemonUp: true, forwardTo: "http://127.0.0.1:8080" });
    w.state.backend = "Running";
    // configure's own check refuses to record it…
    const { opts } = await setOpts(P, I, w, { none, tailscale: w.provider });
    await expect(remoteSet({ ...opts, provider: "tailscale", options: { flags: {} }, yes: true })).rejects.toThrow(/the handler for .* is http:\/\/127\.0\.0\.1:8080, not http:\/\/127\.0\.0\.1:8081/);
    expect(existsSync(deploymentPath(I))).toBe(false);
    // …and doctor fails it by name when it is found live, even beside a record that claims the proxy port
    const rows = await remoteRows({ deployment: dep({ provider: "tailscale", mode: "funnel", origin: ORIGIN, settings: { upstream: "http://127.0.0.1:8081", node: NODE, node_from: "pack" } }), productDir: P, instanceDir: I, env: { METISTRY_INSTANCE_DIR: I }, fetchFn: w.fetchFn, exec: w.exec, platform: "darwin", uid: 501, providers: { none, tailscale: w.provider } });
    const handler = rows.find((r) => r.name === "remote:tailscale:handler")!;
    expect(handler.status).toBe("failed");
    expect(handler.remediation).toBe(mainPortRemediation("tailscale"));
    expect(handler.remediation).toBe("tailscale is forwarding to the console's main port, which accepts this Mac's owner token. Run `metistry remote set tailscale`.");
    expect(handler.action).toEqual({ kind: "run_verb", command: ["metistry", "remote", "set", "tailscale"], label: "Set up Tailscale again" });
    expect(rows.find((r) => r.name === "remote:tailscale:proxy-listener")?.status).toBe("ok"); // the record's claim; the live row is what catches the drift

    // a RECORD at the main port fails the shared row too, and the report
    const report = await doctor({ productDir: P, env: { METISTRY_INSTANCE_DIR: I }, deployment: dep({ provider: "tailscale", mode: "funnel", origin: ORIGIN, settings: { upstream: "http://127.0.0.1:8080", node: NODE, node_from: "pack" } }), fetchFn: w.fetchFn, db: null, exec: w.exec, platform: "darwin", uid: 501, appPath: null, remoteProviders: { none, tailscale: w.provider } });
    expect(report.ok).toBe(false);
    expect(report.rows.filter((r) => r.name === "remote:tailscale:proxy-listener" || r.name === "remote:tailscale:handler").map((r) => r.status)).toEqual(["failed", "failed"]);
  });

  it("no handler at all, and a node whose name changed, each fail the handler row with their own sentence", async () => {
    const P = await product();
    const I = await instance();
    const w = world(P, I, { daemonUp: true });
    w.state.backend = "Running"; // signed in, nothing served
    const base = { productDir: P, instanceDir: I, env: { METISTRY_INSTANCE_DIR: I }, fetchFn: w.fetchFn, exec: w.exec, platform: "darwin" as const, uid: 501, providers: { none, tailscale: w.provider } };
    const none1 = await remoteRows({ ...base, deployment: dep({ provider: "tailscale", mode: "funnel", origin: ORIGIN, settings: { upstream: "http://127.0.0.1:8081", node_from: "pack" } }) });
    expect(none1.find((r) => r.name === "remote:tailscale:handler")).toMatchObject({ status: "failed", remediation: "Tailscale isn't forwarding to Metistry. Run `metistry remote set tailscale`." });
    expect(none1.find((r) => r.name === "remote:tailscale:funnel")).toMatchObject({ status: "failed", remediation: expect.stringContaining("Funnel is allowed but not on") });
    const renamed = await remoteRows({ ...base, deployment: dep({ provider: "tailscale", mode: "funnel", origin: "https://old-name.tail1234.ts.net", settings: { upstream: "http://127.0.0.1:8081", node_from: "pack" } }) });
    expect(renamed.find((r) => r.name === "remote:tailscale:handler")).toMatchObject({ status: "failed", remediation: `This Mac's Tailscale name changed from old-name.tail1234.ts.net to ${NAME}. Phones added under the old name must be added again — \`metistry remote set tailscale\` records the new one.` });
  });

  it("the other rows: MagicDNS off, HTTPS or Funnel not allowed, public DNS not yet, the key expiring", async () => {
    const P = await product();
    const I = await instance();
    const rec: RemoteRecord = { provider: "tailscale", mode: "funnel", origin: ORIGIN, settings: { upstream: "http://127.0.0.1:8081", node_from: "pack" } };
    const rowsOf = async (o: WorldOptions) => {
      const w = world(P, I, { daemonUp: true, ...o });
      w.state.backend = "Running";
      return remoteRows({ deployment: dep(rec), productDir: P, instanceDir: I, env: { METISTRY_INSTANCE_DIR: I }, fetchFn: w.fetchFn, exec: w.exec, platform: "darwin", uid: 501, providers: { none, tailscale: w.provider } });
    };
    const noDns = await rowsOf({ dnsName: "" });
    expect(noDns.find((r) => r.name === "remote:tailscale:https")).toMatchObject({ status: "failed", remediation: "MagicDNS is off for your tailnet, so this Mac has no name. Turn it on in the Tailscale admin console, DNS page." });
    const noHttps = await rowsOf({ caps: [] });
    expect(noHttps.find((r) => r.name === "remote:tailscale:https")).toMatchObject({ status: "failed", remediation: expect.stringContaining("HTTPS certificates are off for your tailnet. Open the link Tailscale gave to allow them") });
    expect(noHttps.find((r) => r.name === "remote:tailscale:funnel")).toMatchObject({ status: "failed", remediation: expect.stringContaining("Funnel isn't allowed for this node") });
    const noPublic = await rowsOf({ dns: false });
    expect(noPublic.find((r) => r.name === "remote:tailscale:public-name")).toMatchObject({ status: "failed", remediation: expect.stringContaining(`${NAME} hasn't appeared in public DNS yet — Tailscale says this can take up to 10 minutes`) });
    const soon = new Date(1_700_000_000_000 + 10 * 86_400_000).toISOString();
    const expiring = await rowsOf({ keyExpiry: soon });
    expect(expiring.find((r) => r.name === "remote:tailscale:key-expiry")).toMatchObject({ status: "degraded", remediation: expect.stringMatching(/^This Mac's Tailscale key expires on \d{4}-\d{2}-\d{2} \(10 days\)\. Disable key expiry for it in the admin console/), action: { command: ["metistry", "remote", "authorize", "tailscale"] } });
    expect(KEY_EXPIRY_WARN_DAYS).toBe(14);
    const expired = await rowsOf({ keyExpiry: new Date(1_700_000_000_000 - 86_400_000).toISOString() });
    expect(expired.find((r) => r.name === "remote:tailscale:key-expiry")?.status).toBe("failed");
    const never = await rowsOf({ keyExpiry: null });
    expect(never.find((r) => r.name === "remote:tailscale:key-expiry")).toMatchObject({ status: "ok", meta: { key_expiry: null } });
  });
});

describe("revoke leaves no handler and a logged-out node", () => {
  it("`remote off`: the serve config reset, the node logged out, its job booted out and its plist and state removed — the admin-console entry left for the owner", async () => {
    const P = await product();
    const I = await instance();
    const w = world(P, I);
    const lines: string[] = [];
    const { home, opts } = await setOpts(P, I, w, { none, tailscale: w.provider }, lines);
    await remoteSet({ ...opts, provider: "tailscale", options: { flags: {} }, yes: true });
    expect(handlerOf(w.state.serve, `${NAME}:443`).proxy).toBe("http://127.0.0.1:8081");
    w.state.launchctl.length = 0;

    // the preview names what it would undo and leave, and changes nothing
    const preview = await remoteSet({ ...opts, provider: "none", options: { flags: {} } });
    expect(preview.applied).toBe(false);
    expect(lines.join("\n")).toContain("then undo at tailscale: reset the node's serve config");
    expect(lines.join("\n")).toContain(`left for you at tailscale: the node ${NODE} in your Tailscale admin console (Machines) — remove it there`);
    expect(w.state.loggedOut).toBe(false);
    expect(existsSync(plistPath(home))).toBe(true);

    const off = await remoteSet({ ...opts, provider: "none", options: { flags: {} }, yes: true });
    expect(off).toMatchObject({ from: "tailscale", provider: "none", applied: true });
    expect(off.revoked?.undone).toEqual([
      `the funnel handler for ${NAME}:443 removed (serve config reset)`,
      "the node logged out of Tailscale (its node key is revoked)",
      `the node's launchd job com.foldedspacelabs.metistry.tailscale stopped and ${plistPath(home)} removed`,
      `the node's state ${tailscaleStateDir(I)} removed`,
    ]);
    expect(off.revoked?.left_for_owner).toEqual([`the node ${NODE} in your Tailscale admin console (Machines) — remove it there`]);
    // no handler, a logged-out node, no job, no state
    expect(w.state.serve).toEqual({});
    expect(w.state.loggedOut).toBe(true);
    expect(w.state.tailscale.slice(-2).map((l) => l.replace(`--socket=${w.sock} `, ""))).toEqual(["pack: serve reset", "pack: logout"]);
    expect(w.state.launchctl).toEqual(["bootout gui/501/com.foldedspacelabs.metistry.tailscale"]);
    expect(existsSync(plistPath(home))).toBe(false);
    expect(existsSync(tailscaleStateDir(I))).toBe(false);
    expect(await readRecord(I)).toEqual({ provider: "none", settings: {} });
  });

  it("with the owner's app: only Metistry's handler is turned off — the app stays signed in, nothing is stopped", async () => {
    const P = await product();
    const I = await instance();
    const w = world(P, I, { app: "running", proxyLimits: false });
    const { home, opts } = await setOpts(P, I, w, { none, tailscale: w.provider });
    const r = await remoteSet({ ...opts, provider: "tailscale", options: { mode: "tailnet", flags: { "use-app": true } }, yes: true });
    expect(r.applied).toBe(true);
    expect(await readRecord(I)).toMatchObject({ mode: "tailnet", settings: { node_from: "app", node: "studio" } });
    expect(w.state.launchctl).toEqual([]); // the app is the node: no job of ours
    expect(existsSync(plistPath(home))).toBe(false);
    expect(existsSync(tailscaleStateDir(I))).toBe(false);
    expect(w.state.tailscale.some((l) => l.startsWith("app: serve --bg --https=443 http://127.0.0.1:8081"))).toBe(true);
    const off = await remoteSet({ ...opts, provider: "none", options: { flags: {} }, yes: true });
    expect(off.revoked).toEqual({ undone: [`the serve handler for ${NAME}:443 turned off (your Tailscale app stays signed in)`], left_for_owner: [] });
    expect(w.state.app.handlerOff).toBe(true);
    expect(w.state.tailscale.some((l) => l.includes("logout"))).toBe(false);
    expect(w.state.launchctl).toEqual([]);
  });
});

describe("no half-switch: a `remote set tailscale` that cannot reach the new origin leaves the old provider active", () => {
  const fakeOld = (log: string[]): RemoteProvider => ({
    id: "zrok",
    label: "Fake zrok",
    async detect() {
      return { tool: { present: true, version: "9", from: "pack" }, signed_in: true, origin: "https://a.share.zrok.io", would_change: [] };
    },
    async configure(ctx) {
      return { origin: "https://a.share.zrok.io", settings: { upstream: `http://127.0.0.1:${ctx.proxyPort}` } };
    },
    async status() {
      return [];
    },
    async revoke(ctx) {
      log.push(`revoke:zrok${ctx.dryRun ? ":dry" : ""}`);
      return { undone: ["the zrok share"], left_for_owner: [] };
    },
  });

  it("the origin never answers from this Mac: nothing written, the old provider not revoked, and the Tailscale node left configured for a retry", async () => {
    const P = await product();
    const I = await instance();
    const log: string[] = [];
    const w = world(P, I, { originUp: false });
    const { opts } = await setOpts(P, I, w, { none, zrok: fakeOld(log), tailscale: w.provider });
    // zrok in place first: its origin answers through the shared fake (anything not the funnel name refuses — so give it its own)
    const zrokUp = ((input: string | URL | Request) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      if (url.origin === "https://a.share.zrok.io") return Promise.resolve(new Response(JSON.stringify({ instance_id: INSTANCE_ID }), { status: 200, headers: { "content-type": "application/json" } }));
      return w.fetchFn(input);
    }) as unknown as typeof fetch;
    await remoteSet({ ...opts, fetchFn: zrokUp, provider: "zrok", options: { flags: {} }, yes: true });
    expect((await readRecord(I))?.provider).toBe("zrok");
    log.length = 0;

    await expect(remoteSet({ ...opts, fetchFn: zrokUp, provider: "tailscale", options: { flags: {} }, yes: true })).rejects.toThrow(new RegExp(`${ORIGIN} hasn't answered from this Mac within 0 s .*nothing was written and zrok is still in place`));
    expect((await readRecord(I))?.provider).toBe("zrok");
    expect(log).toEqual(["revoke:zrok:dry"]); // the preview's dry revoke only — zrok was never undone
    // the node is signed in and the handler set (configure is idempotent; a retry picks it up), but the record says zrok
    expect(w.state.backend).toBe("Running");
    expect(handlerOf(w.state.serve, `${NAME}:443`).proxy).toBe("http://127.0.0.1:8081");
  });

  it("a sign-in the owner never finishes: configure fails, nothing is written, remote access is still none", async () => {
    const P = await product();
    const I = await instance();
    const w = world(P, I, { signInAfterPolls: Infinity });
    const { opts } = await setOpts(P, I, w, { none, tailscale: w.provider });
    await expect(remoteSet({ ...opts, provider: "tailscale", options: { flags: {} }, yes: true })).rejects.toThrow(/Tailscale's sign-in didn't finish within 0 s \(BackendState NeedsLogin\) — open https:\/\/login\.tailscale\.com\/a\/0123456789abcdef and run `metistry remote authorize tailscale` to wait again.*nothing was written and remote access is still none/);
    expect(existsSync(deploymentPath(I))).toBe(false);
    expect(w.state.opened).toEqual([AUTH_URL]);
    // `remote authorize tailscale` is the verb that waits again — and reports honestly when it still does not finish
    const ctx: RemoteContext = { productDir: P, instanceDir: I, env: opts.env, instanceId: INSTANCE_ID, record: { provider: "none", settings: {} }, consolePort: 8080, proxyPort: 8081, proxySocket: "/x", exec: w.exec, fetchFn: w.fetchFn, platform: "darwin", uid: 501, readToken: async () => "", note: () => {}, dryRun: false, timeoutMs: 50 };
    const a = await w.provider.authorize!(ctx, { noBrowser: true, timeoutMs: 10 });
    expect(a.signed_in).toBe(false);
    expect(a.detail).toContain("didn't finish within 0 s");
    expect(w.state.opened).toEqual([AUTH_URL]); // --no-browser: not opened again
  });

  it("only an https:// address is handed to `open`: anything else the node reports is printed and refused", async () => {
    expect(isOpenableUrl(AUTH_URL)).toBe(true);
    expect(isOpenableUrl("https://headscale.example.net/register/mkey:abc")).toBe(true);
    for (const bad of ["http://login.tailscale.com/a/x", "javascript:alert(1)", "file:///etc/passwd", "login.tailscale.com/a/x", "", "-"]) expect(isOpenableUrl(bad), bad).toBe(false);
    const P = await product();
    const I = await instance();
    const w = world(P, I, { signInAfterPolls: Infinity });
    const { opts } = await setOpts(P, I, w, { none, tailscale: w.provider });
    const lines: string[] = [];
    const ctx: RemoteContext = { productDir: P, instanceDir: I, env: opts.env, instanceId: INSTANCE_ID, record: { provider: "none", settings: {} }, consolePort: 8080, proxyPort: 8081, proxySocket: "/x", exec: w.exec, fetchFn: w.fetchFn, platform: "darwin", uid: 501, readToken: async () => "", note: (l) => lines.push(l), dryRun: false, timeoutMs: 50 };
    w.state.badAuthUrl = "javascript:alert(1)";
    const a = await w.provider.authorize!(ctx, { noBrowser: false, timeoutMs: 10 });
    expect(a.signed_in).toBe(false);
    expect(w.state.opened).toEqual([]); // never handed to `open`
    expect(lines.join("\n")).toContain("sign in to Tailscale at: javascript:alert(1)");
    expect(lines.join("\n")).toContain("not an https:// address, so it is printed and not opened");
  });

  it("the bundled node needs launchd: on another platform it is refused naming --use-app; a socket path too long for the kernel is refused before anything starts", async () => {
    const P = await product();
    const I = await instance();
    const w = world(P, I);
    const { opts } = await setOpts(P, I, w, { none, tailscale: w.provider });
    await expect(remoteSet({ ...opts, platform: "linux", provider: "tailscale", options: { flags: {} }, yes: true })).rejects.toThrow(/the bundled node runs as a launchd job, and this is linux — run your own tailscaled and `metistry remote set tailscale --use-app`/);
    expect(w.state.launchctl).toEqual([]);
    const deep = await mkdtemp(join(SHORT_TMP, `mts-${"x".repeat(80)}-`));
    await mkdir(join(deep, ".metistry", "state"), { recursive: true });
    await writeFile(join(deep, ".metistry", "identity.yaml"), `name: Test\ninstance_id: ${INSTANCE_ID}\n`);
    const w2 = world(P, deep);
    const s2 = await setOpts(P, deep, w2, { none, tailscale: w2.provider });
    await expect(remoteSet({ ...s2.opts, provider: "tailscale", options: { flags: {} }, yes: true })).rejects.toThrow(/over the 103-byte unix socket limit .*move the instance directory somewhere shorter, or use --use-app/);
    expect(w2.state.launchctl).toEqual([]);
    expect(existsSync(tailscaleStateDir(deep))).toBe(false);
  });
});

describe("the CLI: flags reach the adapter, the registry ships tailscale", () => {
  it("--bundled, --use-app and --no-browser are switches; `remote set tailscale --mode tailnet --bundled --no-browser --yes` hands them to configure", async () => {
    expect(BOOLEAN_FLAGS.has("bundled")).toBe(true);
    expect(BOOLEAN_FLAGS.has("use-app")).toBe(true);
    expect(BOOLEAN_FLAGS.has("no-browser")).toBe(true);
    expect(parseArgs(["remote", "set", "tailscale", "--mode", "tailnet", "--bundled", "--no-browser"]).flags).toMatchObject({ mode: "tailnet", bundled: true, "no-browser": true });
    const P = await product();
    // through `main()`, which sets METISTRY_INSTANCE_DIR: the isolation check wants it under os.tmpdir(), and this recorder starts no node, so the socket length is moot
    const I = await instance(tmpdir());
    const seen: unknown[] = [];
    const recorder: RemoteProvider = {
      id: "tailscale",
      label: "Recorder",
      async detect() {
        return { tool: { present: true }, signed_in: true, would_change: [] };
      },
      async configure(_ctx, opts) {
        seen.push(opts);
        return { origin: ORIGIN, mode: opts.mode, settings: { upstream: "http://127.0.0.1:8081" } };
      },
      async status() {
        return [];
      },
      async revoke() {
        return { undone: [], left_for_owner: [] };
      },
    };
    const w = world(P, I);
    const out: string[] = [];
    const code = await main(["remote", "set", "tailscale", "--mode", "tailnet", "--bundled", "--no-browser", "--yes", "--json", "--product-dir", P, "--instance", I], { out: (l) => out.push(l), err: () => {}, exec: w.exec, fetchFn: w.fetchFn, platform: "darwin", uid: 501, remoteProviders: { none, tailscale: recorder } });
    expect(code).toBe(0);
    expect(seen).toEqual([{ mode: "tailnet", flags: { mode: "tailnet", bundled: true, "no-browser": true } }]);
  });

  it("this release ships none AND tailscale: `remote --json` says so, and a record naming tailscale is no longer 'no adapter'", async () => {
    const P = await product();
    const I = await instance();
    const w = world(P, I);
    const s = await remoteStatus({ productDir: P, instanceDir: I, env: { METISTRY_INSTANCE_DIR: I }, platform: "darwin", uid: 501, fetchFn: w.fetchFn, exec: w.exec, out: () => {} });
    expect(s.available).toEqual(["none", "tailscale"]);
    expect(s.choices.find((c) => c.id === "tailscale")).toMatchObject({ tag: "recommended", available: true });
    expect(tailscale.id).toBe("tailscale");
    expect(tailscale.label).toBe("Tailscale — Any browser (Funnel)");
  });

  it("renderAgentPlist: argv as strings, env dict, one log, KeepAlive — and XML-escaped", () => {
    const p = renderAgentPlist({ label: "com.foldedspacelabs.metistry.tailscale", programArguments: ["/x/tailscaled", "--statedir=/a b/&c"], log: "/tmp/metistry-tailscale.log", environment: { HOME: "/Users/o", PATH: "/usr/bin:/bin" } });
    expect(p).toContain("<key>Label</key><string>com.foldedspacelabs.metistry.tailscale</string>");
    expect(p).toContain("<string>--statedir=/a b/&amp;c</string>");
    expect(p).toContain("<key>HOME</key><string>/Users/o</string>");
    expect(p).toContain("<key>RunAtLoad</key><true/>");
    expect(p).toContain("<key>StandardErrorPath</key><string>/tmp/metistry-tailscale.log</string>");
    expect(() => renderAgentPlist({ label: "x", programArguments: [], log: "/tmp/x.log" })).toThrow(/no program/);
  });
});
