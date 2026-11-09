// Tailscale — two modes of one provider (plan §2.23, X-106): `funnel`, the
// default and the recommended path, puts `https://<node>.<tailnet>.ts.net` on
// the internet with TLS ending on this Mac and no app on the phone; `tailnet`
// (`tailscale serve`) reaches only the owner's own devices, each running the
// Tailscale app.
//
// THE NODE is one of two things, behind one switch:
//
//   pack   the bundled userspace `tailscaled` + `tailscale` (X-112's pack,
//          fetched only when the owner picks Tailscale): `--tun=userspace-
//          networking`, unprivileged, its state and socket under
//          `.metistry/state/tailscale/` (0700), hostname `metistry-<instance>`
//          so renaming the Mac changes nothing, run as its own launchd job
//          (`launchd.ts`, `renderAgentPlist`) because it must be up before
//          `metistry up` ever runs — the owner signs in through it first.
//   app    the owner's own Tailscale app (or a `tailscale` install), driven
//          through its CLI. Nothing is installed; the node is the Mac's own,
//          named after the Mac.
//
// `--use-app` forces the app, `--bundled` forces the pack; with neither, the
// owner's app is preferred WHEN IT IS RUNNING (a second node beside a running
// app is harmless but pointless), else the pack. The choice is recorded as
// `settings.node_from`, so `status` and `revoke` act on the node `configure`
// set up and never on the other one.
//
// SIGN-IN needs no credential from the owner and none passes through here:
// `tailscale up` hands back Tailscale's own login URL, the browser opens it,
// and completion is read from `BackendState` reaching `Running` — never from
// anything the owner types. Each one-time approval page Tailscale offers
// (enable HTTPS, enable Funnel) is surfaced as the flow's one step and waited
// for; the handler is retried until the approval has landed.
//
// THE HANDLER points at the console's PROXY listener (its loopback TCP port —
// Tailscale Serve documents only `http://127.0.0.1` targets), never the main
// port; `rows.ts` fails a record whose upstream is the main port, and this
// file's own `handler` row fails the LIVE serve config the same way. Funnel
// refuses to configure unless that listener answers with X-111's headers —
// the sign-in page goes on the internet only behind the rate limits.
//
// Everything that talks to Tailscale goes through `ctx.exec` (an argv, never a
// shell) and everything that waits goes through `deps`, so the tests drive a
// fake node through the whole flow; the JSON fields read from `status --json`
// and `funnel status --json` are pinned by recorded fixtures.

import { chmod, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { promises as dns } from "node:dns";
import { join } from "node:path";
import { instanceStatePath, runCheck } from "@foldedspacelabs/metistry-core";
import { BOOTOUT_INTERVAL_MS, BOOTOUT_TRIES, labelFor, launchAgentsDir, launchdCommands, logPathFor, renderAgentPlist } from "../launchd.js";
import { loadNamespace, suffixFor } from "../namespace.js";
import { SOCKET_PATH_LIMIT } from "../postgres.js";
import { launchdBaseEnv } from "../supervisor.js";
import { ensureRemotePack, findRemotePack, MANUAL_INSTALL, type RemotePack } from "./packs.js";
import type { AuthorizeOptions, Configured, Detection, ProviderOptions, RemoteContext, RemoteProvider, RemoteRow, Revoked } from "./provider.js";
import { classifyUpstream, mainPortRemediation } from "./upstream.js";

// ---- the constants ---------------------------------------------------------------------

export const TAILSCALE_MODES = ["funnel", "tailnet"] as const;
export type TailscaleMode = (typeof TAILSCALE_MODES)[number];
export const TAILSCALE_DEFAULT_MODE: TailscaleMode = "funnel";

/** Where the bundled node keeps its machine key: `<instance>/.metistry/state/tailscale/`, 0700. Its socket is in `state/run/` beside Postgres's and the supervisor's — the directory `up` already length-checks. */
export const TAILSCALE_STATE_DIRNAME = "tailscale";
export const TAILSCALE_SOCKET_FILENAME = "tailscaled.sock";
export const TAILSCALE_STATE_FILENAME = "tailscaled.state";
/** The node's launchd job is `com.foldedspacelabs.metistry[.<suffix>].tailscale` — `labelFor(TAILSCALE_NODE_SERVICE, suffix)`. */
export const TAILSCALE_NODE_SERVICE = "tailscale";
/** Funnel listens on 443, 8443 or 10000 only; 443 keeps the origin a bare name. */
export const TAILSCALE_HTTPS_PORT = 443; // limit: fixed — Tailscale's own rule (443, 8443, 10000); 443 is the one that needs no port in the origin
/** A node key that expires within this many days is `degraded` (§2.23's own number). */
export const KEY_EXPIRY_WARN_DAYS = 14; // limit: fixed — §2.23's own number for the node key expiry row

/** The owner's own Tailscale CLI, where macOS puts it: the app's bundled CLI (not on PATH), then Homebrew's, then a Linux install. */
export const APP_CLI_CANDIDATES = ["/Applications/Tailscale.app/Contents/MacOS/Tailscale", "/opt/homebrew/bin/tailscale", "/usr/local/bin/tailscale", "/usr/bin/tailscale"] as const;

export type NodeSource = "pack" | "app";

/** The sentence tailnet mode's sheet adds (§2.23). */
export const TAILNET_PHONE_NOTE = "Your phone must be signed in to the same Tailscale account.";

// ---- the JSON Tailscale reports (fields pinned by the fixtures) ------------------------------

/** `tailscale status --json`: the fields read, nothing more. Tailscale documents the shape as subject to change — the fixture test is the pin. */
export interface TailscaleStatus {
  BackendState: string;
  AuthURL?: string | undefined;
  Self?:
    | {
        HostName?: string | undefined;
        /** the MagicDNS name with a trailing dot: `metistry-abc.tail1234.ts.net.` */
        DNSName?: string | undefined;
        /** RFC 3339; absent when key expiry is disabled for the node */
        KeyExpiry?: string | undefined;
        Online?: boolean | undefined;
        /** the node's capabilities as a map (`https`, `funnel`, …) — newer builds */
        CapMap?: Record<string, unknown> | undefined;
        /** the same as a list — older builds */
        Capabilities?: string[] | undefined;
      }
    | undefined;
  CurrentTailnet?: { Name?: string | undefined; MagicDNSSuffix?: string | undefined; MagicDNSEnabled?: boolean | undefined } | undefined;
  Health?: string[] | undefined;
}

/** `tailscale funnel status --json` / `serve status --json`: the serve config, the fields read. */
export interface TailscaleServeConfig {
  TCP?: Record<string, { HTTPS?: boolean | undefined }> | undefined;
  Web?: Record<string, { Handlers?: Record<string, { Proxy?: string | undefined }> | undefined }> | undefined;
  AllowFunnel?: Record<string, boolean> | undefined;
}

export const BACKEND_STATES = ["NoState", "NeedsLogin", "NeedsMachineAuth", "Stopped", "Starting", "Running"] as const;

export function parseStatus(text: string): TailscaleStatus | undefined {
  try {
    const raw = JSON.parse(text) as unknown;
    if (raw === null || typeof raw !== "object" || typeof (raw as { BackendState?: unknown }).BackendState !== "string") return undefined;
    return raw as TailscaleStatus;
  } catch {
    return undefined;
  }
}

export function parseServeConfig(text: string): TailscaleServeConfig | undefined {
  const t = text.trim();
  if (t === "" || t === "null") return {};
  try {
    const raw = JSON.parse(t) as unknown;
    return raw !== null && typeof raw === "object" ? (raw as TailscaleServeConfig) : undefined;
  } catch {
    return undefined;
  }
}

/** `metistry-abc.tail1234.ts.net.` → `metistry-abc.tail1234.ts.net`; undefined when MagicDNS gives the node no name. */
export function dnsNameOf(s: TailscaleStatus | undefined): string | undefined {
  const n = s?.Self?.DNSName?.trim().replace(/\.$/, "").toLowerCase();
  return n ? n : undefined;
}

/** Whether the node holds a capability (`https`, `funnel`): the map on newer builds, the list on older ones. */
export function hasCapability(s: TailscaleStatus | undefined, cap: string): boolean {
  const self = s?.Self;
  if (!self) return false;
  if (self.CapMap && Object.prototype.hasOwnProperty.call(self.CapMap, cap)) return true;
  return Array.isArray(self.Capabilities) && self.Capabilities.includes(cap);
}

/** The one handler this adapter sets: `<name>:443` → `/` → the proxy listener. */
export function handlerOf(cfg: TailscaleServeConfig | undefined, hostPort: string): { proxy: string | undefined; funnel: boolean } {
  const web = cfg?.Web?.[hostPort];
  return { proxy: web?.Handlers?.["/"]?.Proxy, funnel: cfg?.AllowFunnel?.[hostPort] === true };
}

/** Every Tailscale approval page a command's output offers, in order, each named for what it approves. */
export function approvalLinksIn(text: string): { url: string; what: "HTTPS" | "Funnel" | "a Tailscale setting" }[] {
  const out: { url: string; what: "HTTPS" | "Funnel" | "a Tailscale setting" }[] = [];
  for (const m of text.matchAll(/https:\/\/login\.tailscale\.com\/[^\s"'<>]+/g)) {
    const url = m[0];
    if (out.some((o) => o.url === url)) continue;
    const path = url.slice("https://login.tailscale.com".length).toLowerCase();
    out.push({ url, what: path.includes("funnel") ? "Funnel" : path.includes("https") ? "HTTPS" : "a Tailscale setting" });
  }
  return out;
}

/** What `open` is handed: an `https:` URL and nothing else — Tailscale's login and approval pages are, and so is a headscale's. Anything the node reports that is not one is printed, never opened. */
export function isOpenableUrl(url: string): boolean {
  try {
    return new URL(url).protocol === "https:";
  } catch {
    return false;
  }
}

// ---- each BackendState, its row and its sentence --------------------------------------------

export interface StateRow {
  status: "ok" | "degraded" | "failed";
  /** the sentence, in the product's voice; `{node}` is the node as the owner knows it */
  sentence: string;
}

/**
 * What each `BackendState` means for the two rows that read it — *node running*
 * and *signed in* — for the bundled node and for the owner's app (whose fix is
 * in its menu, not in a Metistry verb). Exported so the test holds every
 * state to its row and sentence.
 */
export function stateRows(state: string, from: NodeSource): { running: StateRow; signedIn: StateRow } {
  const bundled = from === "pack";
  const signInFix = bundled ? "Sign in again (`metistry remote authorize tailscale`)." : "Sign in from the Tailscale menu.";
  switch (state) {
    case "Running":
      return { running: { status: "ok", sentence: bundled ? "This Mac's Metistry node is running." : "Your Tailscale app is running." }, signedIn: { status: "ok", sentence: "Signed in to Tailscale." } };
    case "Starting":
      return { running: { status: "ok", sentence: bundled ? "This Mac's Metistry node is starting." : "Your Tailscale app is starting." }, signedIn: { status: "degraded", sentence: "Tailscale is connecting — signed in, not yet up. Try again in a moment." } };
    case "NeedsLogin":
      return { running: { status: "ok", sentence: bundled ? "This Mac's Metistry node is running." : "Your Tailscale app is running." }, signedIn: { status: "failed", sentence: `${bundled ? "This Mac's Metistry node" : "This Mac"} isn't signed in to Tailscale. ${signInFix}` } };
    case "NeedsMachineAuth":
      return { running: { status: "ok", sentence: bundled ? "This Mac's Metistry node is running." : "Your Tailscale app is running." }, signedIn: { status: "degraded", sentence: `${bundled ? "This Mac's Metistry node" : "This Mac"} is signed in and waiting for approval in your Tailscale admin console (Machines).` } };
    case "Stopped":
      return {
        running: { status: "failed", sentence: bundled ? "This Mac's Metistry node is stopped. Run `metistry remote set tailscale` to start it." : "Tailscale is installed but not connected. Open Tailscale and turn it on." },
        signedIn: { status: "failed", sentence: "Tailscale isn't connected, so nothing is signed in." },
      };
    case "NoState":
      return {
        running: { status: "failed", sentence: bundled ? "This Mac's Metistry node has no state yet — it has never signed in. Run `metistry remote set tailscale`." : "Your Tailscale app has never signed in. Sign in from the Tailscale menu." },
        signedIn: { status: "failed", sentence: `${bundled ? "This Mac's Metistry node" : "This Mac"} isn't signed in to Tailscale. ${signInFix}` },
      };
    default:
      return { running: { status: "degraded", sentence: `Tailscale reports an unknown state (${state}).` }, signedIn: { status: "degraded", sentence: `Tailscale reports an unknown state (${state}), so whether it is signed in can't be read.` } };
  }
}

/** The sentence for a node whose CLI cannot be reached at all. */
export function notRunningSentence(from: NodeSource): string {
  return from === "pack" ? "This Mac's Metistry node isn't running. Run `metistry remote set tailscale` to start it." : "Tailscale is installed but not connected. Open Tailscale and turn it on.";
}

// ---- the seams -----------------------------------------------------------------------------

export interface TailscaleDeps {
  /** where the owner's own CLI may be */
  appCliCandidates: readonly string[];
  exists: (path: string) => boolean;
  /** public DNS for the Funnel name: the addresses, or [] when it does not resolve yet */
  lookup: (host: string) => Promise<string[]>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  /** between two polls of the node, the handler, or public DNS */
  pollMs: number;
  /** how long the bundled node may take to answer on its socket after launchd starts it */
  nodeStartTimeoutMs: number;
  /** how long the owner has to finish Tailscale's sign-in page (configure's wait; `authorize --timeout` is the dial) */
  signInTimeoutMs: number;
  /** how long the owner has to click an approval page (HTTPS, Funnel) */
  approvalTimeoutMs: number;
  /** how long a Funnel name may take to appear in public DNS */
  dnsTimeoutMs: number;
}

export const TAILSCALE_POLL_MS = 3_000; // limit: fixed — one look every three seconds while the owner signs in or clicks an approval; a human step, not a tunable
export const NODE_START_TIMEOUT_MS = 30_000; // limit: fixed — tailscaled answers on its socket in well under a second; thirty is a launchd job that did not start
export const SIGN_IN_TIMEOUT_MS = 300_000; // limit: fixed — five minutes for Tailscale's sign-in page inside `remote set`; `remote authorize tailscale --timeout` is the dial for longer
export const APPROVAL_TIMEOUT_MS = 300_000; // limit: fixed — five minutes for a one-click approval page; the same human step
export const DNS_TIMEOUT_MS = 600_000; // limit: fixed — Tailscale's own "public DNS records can take up to 10 minutes to show up"

export const DEFAULT_TAILSCALE_DEPS: TailscaleDeps = {
  appCliCandidates: APP_CLI_CANDIDATES,
  exists: existsSync,
  lookup: async (host) => {
    try {
      return (await dns.lookup(host, { all: true })).map((a) => a.address);
    } catch {
      return [];
    }
  },
  sleep: (ms) => new Promise((res) => setTimeout(res, ms)),
  now: Date.now,
  pollMs: TAILSCALE_POLL_MS,
  nodeStartTimeoutMs: NODE_START_TIMEOUT_MS,
  signInTimeoutMs: SIGN_IN_TIMEOUT_MS,
  approvalTimeoutMs: APPROVAL_TIMEOUT_MS,
  dnsTimeoutMs: DNS_TIMEOUT_MS,
};

// ---- the node -------------------------------------------------------------------------------

/** One Tailscale node as this adapter drives it: the CLI to run and how to reach its daemon. */
export interface TailscaleNode {
  from: NodeSource;
  /** the `tailscale` CLI */
  cli: string;
  /** `--socket=<path>` for the bundled node; nothing for the app, whose CLI finds its own daemon */
  socketArgs: string[];
  /** the bundled daemon and its pack, for the job and the `tool present` row */
  daemon?: string | undefined;
  pack?: RemotePack | undefined;
  /** the hostname the bundled node is given (`metistry-<instance>`); the app keeps the Mac's name */
  hostname?: string | undefined;
}

export function tailscaleStateDir(instanceDir: string): string {
  return instanceStatePath(instanceDir, TAILSCALE_STATE_DIRNAME);
}
export function tailscaleSocketPath(instanceDir: string): string {
  return instanceStatePath(instanceDir, "run", TAILSCALE_SOCKET_FILENAME);
}
/** `metistry-<first 8 hex of instance_id>` — the node's name is Metistry's, so renaming the Mac changes nothing. */
export function nodeNameFor(instanceId: string): string {
  return `metistry-${suffixFor(instanceId)}`;
}

/** The pack's binaries, as a node, or undefined when the pack (or either binary) is not here. */
function packNode(ctx: Pick<RemoteContext, "instanceDir">, pack: RemotePack | undefined, instanceId: string | undefined): TailscaleNode | undefined {
  if (!pack) return undefined;
  const cli = pack.bin("bin/tailscale");
  const daemon = pack.bin("bin/tailscaled");
  if (!cli || !daemon) return undefined;
  return { from: "pack", cli, socketArgs: [`--socket=${tailscaleSocketPath(ctx.instanceDir)}`], daemon, pack, ...(instanceId ? { hostname: nodeNameFor(instanceId) } : {}) };
}

/** The owner's own CLI, if any candidate exists on this Mac. Read-only. */
export function findAppCli(deps: Pick<TailscaleDeps, "appCliCandidates" | "exists">): string | undefined {
  return deps.appCliCandidates.find((c) => deps.exists(c));
}

/**
 * `--use-app` wins, `--bundled` wins, both is a contradiction; with neither the
 * owner's app is preferred when it is RUNNING, else the pack. A recorded
 * `settings.node_from` wins over all of it for `status` and `revoke`: they act
 * on the node `configure` set up.
 */
export function chooseNodeSource(flags: ProviderOptions["flags"], appRunning: boolean, recorded?: string | undefined): NodeSource {
  const useApp = flags["use-app"] === true;
  const bundled = flags["bundled"] === true;
  if (useApp && bundled) throw new Error("--use-app and --bundled contradict each other: the owner's Tailscale app, or the bundled node — pick one");
  if (useApp) return "app";
  if (bundled) return "pack";
  if (recorded === "app" || recorded === "pack") return recorded;
  return appRunning ? "app" : "pack";
}

/** `--mode funnel|tailnet`, default funnel; anything else is refused by name. */
export function parseMode(v: string | undefined): TailscaleMode {
  if (v === undefined) return TAILSCALE_DEFAULT_MODE;
  if ((TAILSCALE_MODES as readonly string[]).includes(v)) return v as TailscaleMode;
  throw new Error(`--mode takes funnel (any browser, the default) or tailnet (only your devices, each with the Tailscale app), not ${JSON.stringify(v)}`);
}

// ---- the adapter ----------------------------------------------------------------------------

export function tailscaleProvider(overrides: Partial<TailscaleDeps> = {}): RemoteProvider {
  const deps: TailscaleDeps = { ...DEFAULT_TAILSCALE_DEPS, ...overrides };

  const ts = (ctx: RemoteContext, node: TailscaleNode, args: string[], timeoutMs?: number) => ctx.exec(node.cli, [...node.socketArgs, ...args], { env: ctx.env, timeoutMs: timeoutMs ?? ctx.timeoutMs });

  /** `status --json` from one node, or undefined when its daemon cannot be reached. */
  async function readStatus(ctx: RemoteContext, node: TailscaleNode): Promise<TailscaleStatus | undefined> {
    const r = await ts(ctx, node, ["status", "--json"]);
    if (r.code !== 0) return undefined;
    return parseStatus(r.stdout);
  }

  /** `funnel status --json` (the serve config is one document; `funnel status` and `serve status` print the same). */
  async function readServe(ctx: RemoteContext, node: TailscaleNode, mode: TailscaleMode): Promise<TailscaleServeConfig | undefined> {
    const r = await ts(ctx, node, [mode === "funnel" ? "funnel" : "serve", "status", "--json"]);
    if (r.code !== 0) return undefined;
    return parseServeConfig(r.stdout);
  }

  async function readVersion(ctx: RemoteContext, node: TailscaleNode): Promise<string | undefined> {
    if (node.pack) return node.pack.version;
    const r = await ts(ctx, node, ["version"]);
    const first = r.stdout.trim().split("\n")[0]?.trim();
    return r.code === 0 && first ? first : undefined;
  }

  /** The two nodes as they stand: the owner's app (and whether it is running) and the pack's. */
  async function survey(ctx: RemoteContext) {
    const appCli = findAppCli(deps);
    const app: TailscaleNode | undefined = appCli ? { from: "app", cli: appCli, socketArgs: [] } : undefined;
    const appStatus = app ? await readStatus(ctx, app) : undefined;
    const appRunning = appStatus !== undefined && appStatus.BackendState !== "NoState" && appStatus.BackendState !== "Stopped";
    const pack = await findRemotePack(ctx.productDir, "tailscale");
    const packed = packNode(ctx, pack, ctx.instanceId);
    return { app, appStatus, appRunning, pack, packed };
  }

  function recordedMode(ctx: RemoteContext): TailscaleMode {
    return ctx.record.provider === "tailscale" && ctx.record.mode === "tailnet" ? "tailnet" : "funnel";
  }

  /** The node the RECORD names, for status and revoke — never the other one. */
  async function recordedNode(ctx: RemoteContext): Promise<{ node: TailscaleNode | undefined; from: NodeSource; status: TailscaleStatus | undefined }> {
    const s = await survey(ctx);
    const from = chooseNodeSource({}, s.appRunning, ctx.record.settings.node_from);
    const node = from === "app" ? s.app : s.packed;
    const status = node ? (from === "app" ? s.appStatus : await readStatus(ctx, node)) : undefined;
    return { node, from, status };
  }

  // ---- the launchd job for the bundled node ----

  async function nodeJob(ctx: RemoteContext) {
    const ns = await loadNamespace(ctx.instanceDir);
    const label = labelFor(TAILSCALE_NODE_SERVICE, ns?.labelSuffix);
    const home = ctx.env.HOME;
    if (!home) throw new Error("HOME is not set, so there is nowhere to write the node's launchd job (~/Library/LaunchAgents)");
    return { label, plist: join(launchAgentsDir(home), `${label}.plist`), log: logPathFor(TAILSCALE_NODE_SERVICE, ns?.labelSuffix) };
  }

  /** Make the state directory 0700 (creating it), refuse a socket path the kernel would truncate. */
  async function ensureStateDir(ctx: RemoteContext): Promise<{ dir: string; socket: string }> {
    const dir = tailscaleStateDir(ctx.instanceDir);
    const socket = tailscaleSocketPath(ctx.instanceDir);
    if (Buffer.byteLength(socket) > SOCKET_PATH_LIMIT) {
      throw new Error(`the node's socket path ${socket} is ${Buffer.byteLength(socket)} bytes — over the ${SOCKET_PATH_LIMIT}-byte unix socket limit (the same one \`metistry up\` holds Postgres and the supervisor to); move the instance directory somewhere shorter, or use --use-app`);
    }
    if (ctx.dryRun) return { dir, socket };
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await chmod(dir, 0o700);
    // tailscaled creates its LocalAPI socket 0666 and macOS grants every unix-socket peer read/write, so the
    // directory's mode is the only guard on who can drive the node — 0700, like the state directory
    await mkdir(join(socket, ".."), { recursive: true, mode: 0o700 });
    await chmod(join(socket, ".."), 0o700);
    return { dir, socket };
  }

  /** Start (or restart) the bundled node as a launchd job and wait until its CLI answers. */
  async function startNode(ctx: RemoteContext, node: TailscaleNode): Promise<void> {
    if (!node.daemon) throw new Error("internal: the bundled node has no daemon binary");
    if (ctx.platform !== "darwin") {
      throw new Error(`the bundled node runs as a launchd job, and this is ${ctx.platform} — run your own tailscaled and \`metistry remote set tailscale --use-app\``);
    }
    const { dir, socket } = await ensureStateDir(ctx);
    const job = await nodeJob(ctx);
    const argv = [node.daemon, "--tun=userspace-networking", `--statedir=${dir}`, `--state=${join(dir, TAILSCALE_STATE_FILENAME)}`, `--socket=${socket}`, "--port=0"];
    const env = { ...launchdBaseEnv(ctx.env), METISTRY_INSTANCE_DIR: ctx.instanceDir };
    const plist = renderAgentPlist({ label: job.label, programArguments: argv, log: job.log, environment: env });
    if (ctx.dryRun) {
      ctx.note(`would write ${job.plist} and bootstrap ${job.label} (tailscaled --tun=userspace-networking, state in ${dir})`);
      return;
    }
    await mkdir(join(job.plist, ".."), { recursive: true });
    await writeFile(job.plist, plist, { mode: 0o644 });
    ctx.note(`the node's launchd job: ${job.label} → ${job.plist} (log ${job.log})`);
    for (const c of launchdCommands(job.label, job.plist, ctx.uid)) {
      if (c.awaitGone) {
        for (let i = 0; i < BOOTOUT_TRIES; i++) {
          const p = await ctx.exec("launchctl", c.args, { env: ctx.env });
          if (p.code !== 0) break;
          await deps.sleep(BOOTOUT_INTERVAL_MS);
        }
        continue;
      }
      const r = await ctx.exec(c.cmd, c.args, { env: ctx.env });
      if (r.code !== 0 && !c.tolerateFailure) throw new Error(`launchctl ${c.args[0]} ${job.label} exited ${r.code}${r.stderr.trim() ? `: ${r.stderr.trim().split("\n").slice(-1)[0]}` : ""}`);
    }
    const deadline = deps.now() + deps.nodeStartTimeoutMs;
    for (;;) {
      if (await readStatus(ctx, node)) return;
      if (deps.now() >= deadline) throw new Error(`the node's launchd job ${job.label} started but tailscaled hasn't answered on ${socket} within ${Math.round(deps.nodeStartTimeoutMs / 1000)} s — its log is ${job.log}`);
      await deps.sleep(deps.pollMs);
    }
  }

  async function stopNode(ctx: RemoteContext, undone: string[]): Promise<void> {
    const job = await nodeJob(ctx);
    if (ctx.dryRun) {
      undone.push(`stop the node's launchd job ${job.label} and remove ${job.plist}`);
      return;
    }
    await ctx.exec("launchctl", ["bootout", `gui/${ctx.uid}/${job.label}`], { env: ctx.env }); // tolerated: not loaded is fine
    if (existsSync(job.plist)) await rm(job.plist, { force: true });
    undone.push(`the node's launchd job ${job.label} stopped and ${job.plist} removed`);
  }

  // ---- sign-in ----

  async function openInBrowser(ctx: RemoteContext, url: string, noBrowser: boolean, what: string): Promise<void> {
    ctx.note(`${what}: ${url}`);
    if (noBrowser || ctx.platform !== "darwin") return;
    if (!isOpenableUrl(url)) {
      ctx.note("that is not an https:// address, so it is printed and not opened — open it yourself if it is what you expect");
      return;
    }
    const r = await ctx.exec("open", [url], { env: ctx.env, timeoutMs: 20_000 });
    if (r.code !== 0) ctx.note(`the browser did not open (${r.stderr.trim() || `exit ${r.code}`}) — open the address above yourself`);
    else ctx.note("the browser is open — finish there; this waits");
  }

  /**
   * Bring the node to `Running`: `tailscale up` (the bundled node under its
   * own hostname) hands back the login URL when the node is not signed in;
   * the browser opens it; completion is `BackendState` reaching `Running`.
   */
  async function signIn(ctx: RemoteContext, node: TailscaleNode, o: { noBrowser: boolean; timeoutMs: number }): Promise<TailscaleStatus> {
    const before = await readStatus(ctx, node);
    if (before?.BackendState === "Running") return before;
    const upArgs = ["up", "--json", "--timeout=10s", ...(node.hostname ? [`--hostname=${node.hostname}`, "--accept-dns=false", "--accept-routes=false"] : [])];
    const up = await ts(ctx, node, upArgs, 30_000);
    let authUrl: string | undefined;
    try {
      const j = JSON.parse(up.stdout) as { AuthURL?: unknown };
      if (typeof j.AuthURL === "string" && j.AuthURL !== "") authUrl = j.AuthURL;
    } catch {
      /* `up` reached Running inside its timeout, or printed no JSON */
    }
    let s = await readStatus(ctx, node);
    if (s?.BackendState === "Running") return s;
    authUrl ??= s?.AuthURL || approvalLinksIn(`${up.stdout}\n${up.stderr}`).map((l) => l.url)[0];
    if (!authUrl) {
      if (node.from === "app") throw new Error(`${notRunningSentence("app")} (Tailscale reports ${s?.BackendState ?? "nothing"}; \`tailscale up\` said: ${(up.stderr || up.stdout).trim().split("\n").slice(-1)[0] || `exit ${up.code}`})`);
      throw new Error(`the node gave no login URL (BackendState ${s?.BackendState ?? "unknown"}; \`tailscale up\` said: ${(up.stderr || up.stdout).trim().split("\n").slice(-1)[0] || `exit ${up.code}`})`);
    }
    await openInBrowser(ctx, authUrl, o.noBrowser, "sign in to Tailscale at");
    const deadline = deps.now() + o.timeoutMs;
    for (;;) {
      await deps.sleep(deps.pollMs);
      s = await readStatus(ctx, node);
      if (s?.BackendState === "Running") return s;
      if (s?.BackendState === "NeedsMachineAuth") ctx.note("signed in — waiting for approval in your Tailscale admin console (Machines)");
      if (deps.now() >= deadline) throw new Error(`Tailscale's sign-in didn't finish within ${Math.round(o.timeoutMs / 1000)} s (BackendState ${s?.BackendState ?? "unknown"}) — open ${authUrl} and run \`metistry remote authorize tailscale\` to wait again`);
    }
  }

  // ---- the handler ----

  /**
   * `tailscale funnel|serve --bg --https=443 http://127.0.0.1:<proxy port>`.
   * Each approval page the command offers (enable HTTPS, enable Funnel) is the
   * flow's one step: surfaced, opened, and waited for by retrying the command
   * until it succeeds.
   */
  async function setHandler(ctx: RemoteContext, node: TailscaleNode, mode: TailscaleMode, upstream: string, noBrowser: boolean): Promise<void> {
    const args = [mode === "funnel" ? "funnel" : "serve", "--bg", `--https=${TAILSCALE_HTTPS_PORT}`, upstream];
    const opened = new Set<string>();
    const deadline = deps.now() + deps.approvalTimeoutMs;
    for (;;) {
      const r = await ts(ctx, node, args, 30_000);
      if (r.code === 0) return;
      const text = `${r.stdout}\n${r.stderr}`;
      const links = approvalLinksIn(text);
      if (links.length === 0) throw new Error(`\`tailscale ${args.join(" ")}\` exited ${r.code}: ${text.trim().split("\n").filter(Boolean).slice(-2).join(" ") || "no output"}`);
      for (const l of links) {
        if (opened.has(l.url)) continue;
        opened.add(l.url);
        await openInBrowser(ctx, l.url, noBrowser, `Tailscale asks you to approve ${l.what} for this node — one click at`);
      }
      if (deps.now() >= deadline) throw new Error(`the ${links.map((l) => l.what).join(" and ")} approval didn't land within ${Math.round(deps.approvalTimeoutMs / 1000)} s — click ${links.map((l) => l.url).join(" and ")}, then run \`metistry remote set tailscale\` again`);
      await deps.sleep(deps.pollMs);
    }
  }

  /**
   * Funnel puts the sign-in page on the internet, so it is refused unless the
   * console's proxy listener answers with X-111's headers — the one marker,
   * from outside the console, that the hardened listener is the one running.
   * A `421 misdirected` is an answer (no remote host is configured yet); no
   * answer at all means the console is not up.
   */
  async function requireProxyLimits(ctx: RemoteContext): Promise<void> {
    const url = `http://127.0.0.1:${ctx.proxyPort}/health`;
    let res: Response;
    try {
      res = await ctx.fetchFn(url, { method: "GET", signal: AbortSignal.timeout(ctx.timeoutMs), redirect: "manual" });
    } catch (e) {
      throw new Error(`the console's proxy listener isn't answering on 127.0.0.1:${ctx.proxyPort} (${e instanceof Error && e.name === "TimeoutError" ? `no answer within ${ctx.timeoutMs / 1000} s` : e instanceof Error ? e.message : String(e)}) — Funnel puts the sign-in page on the internet and needs that listener's rate limits; \`metistry up\` first`);
    }
    if (!res.headers.get("strict-transport-security")) {
      throw new Error(`the console on 127.0.0.1:${ctx.proxyPort} isn't the hardened proxy listener — its answers carry none of the rate-limit headers Funnel waits on (plan §2.23, X-111). \`metistry update\` then \`metistry up\`, or choose \`--mode tailnet\`, which stays off the internet`);
    }
  }

  async function waitForPublicName(ctx: RemoteContext, host: string): Promise<void> {
    // the flow's sentence (plan §2.23, step 5), in Tailscale's own words — the wait behind it is DNS_TIMEOUT_MS
    ctx.note(`Waiting for ${host} to appear on the internet — this can take up to 10 minutes.`);
    const deadline = deps.now() + deps.dnsTimeoutMs;
    for (;;) {
      const addrs = await deps.lookup(host);
      if (addrs.length > 0) {
        ctx.note(`${host} resolves (${addrs.join(", ")})`);
        return;
      }
      if (deps.now() >= deadline) throw new Error(`${host} hasn't appeared in public DNS within ${Math.round(deps.dnsTimeoutMs / 60_000)} minutes — the handler is set; run \`metistry remote set tailscale\` again to wait more`);
      await deps.sleep(deps.pollMs);
    }
  }

  const upstreamFor = (ctx: RemoteContext) => `http://127.0.0.1:${ctx.proxyPort}`;

  // ---- the four verbs ----

  const provider: RemoteProvider = {
    id: "tailscale",
    label: "Tailscale — Any browser (Funnel)",

    async detect(ctx: RemoteContext): Promise<Detection> {
      const s = await survey(ctx);
      const from = chooseNodeSource({}, s.appRunning, ctx.record.provider === "tailscale" ? ctx.record.settings.node_from : undefined);
      const node = from === "app" ? s.app : s.packed;
      const status = node ? (from === "app" ? s.appStatus : await readStatus(ctx, node)) : undefined;
      const version = node ? await readVersion(ctx, node) : undefined;
      const name = dnsNameOf(status);
      const mode = recordedMode(ctx);
      const serve = node && status ? await readServe(ctx, node, mode) : undefined;
      const handler = name ? handlerOf(serve, `${name}:${TAILSCALE_HTTPS_PORT}`) : { proxy: undefined, funnel: false };
      const upstream = upstreamFor(ctx);
      const would: string[] = [];
      if (!node) would.push(from === "pack" ? `fetch Metistry's Tailscale pack and start the node as a launchd job (metistry-${ctx.instanceId ? suffixFor(ctx.instanceId) : "<instance>"}, state in ${tailscaleStateDir(ctx.instanceDir)})` : "use your Tailscale app's CLI");
      else if (from === "pack" && !status) would.push(`start the bundled node as a launchd job (state in ${tailscaleStateDir(ctx.instanceDir)})`);
      if (status?.BackendState !== "Running") would.push("sign this node in at Tailscale's login page (opened in the browser)");
      if (handler.proxy !== upstream) would.push(`point \`tailscale ${mode === "funnel" ? "funnel" : "serve"}\` at the proxy listener ${upstream}${handler.proxy ? ` (today: ${handler.proxy})` : ""}`);
      if (mode === "funnel" && !handler.funnel) would.push("turn Funnel on for this node (an approval page, if Tailscale asks)");
      return {
        tool: node ? { present: true, from: node.from === "pack" ? "pack" : "owner", ...(version ? { version } : {}) } : { present: false },
        signed_in: node ? status?.BackendState === "Running" : false,
        ...(name && handler.proxy === upstream ? { origin: `https://${name}` } : {}),
        would_change: would,
      };
    },

    async configure(ctx: RemoteContext, opts: ProviderOptions): Promise<Configured> {
      const mode = parseMode(opts.mode);
      const noBrowser = opts.flags["no-browser"] === true;
      const upstream = upstreamFor(ctx);
      // 0. Funnel only behind X-111's limits — checked before anything is fetched or started
      if (mode === "funnel") await requireProxyLimits(ctx);
      // 1. the node
      const s = await survey(ctx);
      const from = chooseNodeSource(opts.flags, s.appRunning);
      let node: TailscaleNode | undefined;
      if (from === "app") {
        node = s.app;
        if (!node) throw new Error("Tailscale isn't installed on this Mac — --use-app needs the Tailscale app (tailscale.com/download) or `brew install tailscale`; without the flag Metistry brings its own node");
        ctx.note(`using your Tailscale app (${node.cli})`);
      } else {
        const got = await ensureRemotePack(ctx, "tailscale");
        if (!got.pack) throw new Error(got.reason);
        node = packNode(ctx, got.pack, ctx.instanceId);
        if (!node) throw new Error(`the Tailscale pack at ${got.pack.dir} is missing bin/tailscale or bin/tailscaled — ${MANUAL_INSTALL.tailscale}`);
        if (!node.hostname) throw new Error("this instance has no instance_id yet, so its node has no name — `metistry up` stamps one; then run this again");
        ctx.note(`${got.fetched ? "fetched" : "using"} Metistry's Tailscale pack (${got.pack.version})`);
        if (!(await readStatus(ctx, node))) await startNode(ctx, node);
        else await ensureStateDir(ctx);
      }
      if (ctx.dryRun) {
        ctx.note(`would sign the node in, run \`tailscale ${mode === "funnel" ? "funnel" : "serve"} --bg --https=${TAILSCALE_HTTPS_PORT} ${upstream}\` and record the origin`);
        return { origin: null, mode, settings: { upstream, node_from: from } };
      }
      // 2. sign in — completion is BackendState, never anything typed here
      const status = await signIn(ctx, node, { noBrowser, timeoutMs: deps.signInTimeoutMs });
      const name = dnsNameOf(status);
      if (!name) throw new Error("MagicDNS is off for your tailnet, so this Mac has no name. Turn it on in the Tailscale admin console, DNS page.");
      // 3. the handler, to the PROXY listener; each approval page is the one step
      await setHandler(ctx, node, mode, upstream, noBrowser);
      const serve = await readServe(ctx, node, mode);
      const hostPort = `${name}:${TAILSCALE_HTTPS_PORT}`;
      const handler = handlerOf(serve, hostPort);
      if (handler.proxy !== upstream) throw new Error(`after \`tailscale ${mode === "funnel" ? "funnel" : "serve"}\`, the handler for ${hostPort} is ${handler.proxy ?? "absent"}, not ${upstream}`);
      if (mode === "funnel" && !handler.funnel) throw new Error(`Funnel isn't on for ${hostPort} after \`tailscale funnel\` — approve it at the link Tailscale gave, then run this again`);
      // 4. the public name (Funnel): awaited, up to Tailscale's own ten minutes
      if (mode === "funnel") await waitForPublicName(ctx, name);
      else ctx.note(TAILNET_PHONE_NOTE);
      return {
        origin: `https://${name}`,
        mode,
        settings: { upstream, node: status.Self?.HostName ?? node.hostname ?? name.split(".")[0] ?? name, node_from: from, handler: hostPort },
      };
    },

    async status(ctx: RemoteContext): Promise<RemoteRow[]> {
      const mode = recordedMode(ctx);
      const { node, from, status } = await recordedNode(ctx);
      const rows: RemoteRow[] = [];
      const row = async (name: string, probe: string, fn: () => Promise<{ status?: "ok" | "degraded" | "failed" | "absent"; remediation?: string; meta?: Record<string, unknown> }>, action?: RemoteRow["action"]) => {
        rows.push({ kind: "remote", ...(action ? { action } : {}), ...(await runCheck(`remote:tailscale:${name}`, probe, fn)) });
      };
      const setAgain: RemoteRow["action"] = { kind: "run_verb", command: ["metistry", "remote", "set", "tailscale"], label: "Set up Tailscale again" };
      const authorize: RemoteRow["action"] = { kind: "run_verb", command: ["metistry", "remote", "authorize", "tailscale"], label: "Sign in to Tailscale" };
      const state = status?.BackendState;
      const sr = state ? stateRows(state, from) : undefined;

      await row("node", `the ${from === "pack" ? "bundled node (a launchd job)" : "Tailscale app"} answers \`tailscale status\``, async () => {
        const meta = { node_from: from, backend_state: state ?? null, ...(node ? { cli: node.cli } : {}) };
        if (!node) return { status: "failed", remediation: from === "pack" ? `Metistry's Tailscale pack isn't here — \`metistry remote set tailscale\` fetches it` : "Tailscale isn't installed on this Mac. Install it from tailscale.com or the App Store, then sign in.", meta };
        if (!sr) return { status: "failed", remediation: notRunningSentence(from), meta };
        return sr.running.status === "ok" ? { meta: { ...meta, info: sr.running.sentence } } : { status: sr.running.status, remediation: sr.running.sentence, meta };
      }, setAgain);

      await row("signed-in", "BackendState is Running", async () => {
        const meta = { node_from: from, backend_state: state ?? null, dns_name: dnsNameOf(status) ?? null };
        if (!sr) return { status: "failed", remediation: notRunningSentence(from), meta };
        return sr.signedIn.status === "ok" ? { meta: { ...meta, info: `${sr.signedIn.sentence}${dnsNameOf(status) ? ` This node is ${dnsNameOf(status)}.` : ""}` } } : { status: sr.signedIn.status, remediation: sr.signedIn.sentence, meta };
      }, from === "pack" ? authorize : undefined);

      if (from === "pack") {
        await row("state-dir", `${tailscaleStateDir(ctx.instanceDir)} exists and is private (0700)`, async () => {
          const dir = tailscaleStateDir(ctx.instanceDir);
          try {
            const st = await stat(dir);
            const mode = st.mode & 0o777;
            if (mode !== 0o700) return { status: "failed", remediation: `the node's state directory ${dir} is mode ${mode.toString(8)}, not 700 — it holds the node's machine key; \`chmod 700 ${dir}\``, meta: { dir, mode: mode.toString(8) } };
            return { meta: { dir, mode: "700", info: "the node's state is private to you" } };
          } catch {
            return { status: "failed", remediation: `the node's state directory ${dir} is missing — \`metistry remote set tailscale\``, meta: { dir } };
          }
        }, setAgain);
      }

      const name = dnsNameOf(status);
      await row("https", "MagicDNS gives this node a name and HTTPS certificates are allowed for the tailnet", async () => {
        if (!status) return { status: "failed", remediation: notRunningSentence(from), meta: {} };
        if (!name) return { status: "failed", remediation: "MagicDNS is off for your tailnet, so this Mac has no name. Turn it on in the Tailscale admin console, DNS page.", meta: { magic_dns: false } };
        if (!hasCapability(status, "https")) return { status: "failed", remediation: "HTTPS certificates are off for your tailnet. Open the link Tailscale gave to allow them (`metistry remote set tailscale` asks again).", meta: { dns_name: name, https: false } };
        return { meta: { dns_name: name, https: true, info: `https://${name} can hold a certificate` } };
      }, setAgain);

      const hostPort = name ? `${name}:${TAILSCALE_HTTPS_PORT}` : undefined;
      const serve = node && status ? await readServe(ctx, node, mode) : undefined;
      const handler = hostPort ? handlerOf(serve, hostPort) : { proxy: undefined, funnel: false };

      if (mode === "funnel") {
        await row("funnel", `Funnel is allowed for this node and on for ${hostPort ?? "its name"}`, async () => {
          if (!status) return { status: "failed", remediation: notRunningSentence(from), meta: {} };
          if (!hasCapability(status, "funnel")) return { status: "failed", remediation: "Funnel isn't allowed for this node. Open the link Tailscale gave to approve it, or add the `funnel` attribute in your tailnet's policy file (`metistry remote set tailscale` asks again).", meta: { funnel_allowed: false } };
          if (!handler.funnel) return { status: "failed", remediation: `Funnel is allowed but not on for ${hostPort} — \`metistry remote set tailscale\``, meta: { funnel_allowed: true, funnel_on: false } };
          return { meta: { funnel_allowed: true, funnel_on: true, info: `anyone with the address can open https://${name}` } };
        }, setAgain);
      }

      await row("handler", `\`tailscale ${mode === "funnel" ? "funnel" : "serve"} status\` forwards ${hostPort ?? "the node's name"} to the proxy listener (port ${ctx.proxyPort}), never the main port ${ctx.consolePort}`, async () => {
        if (!status) return { status: "failed", remediation: notRunningSentence(from), meta: {} };
        const recordedHost = ctx.record.origin ? new URL(ctx.record.origin).hostname.toLowerCase() : undefined;
        if (recordedHost && name && recordedHost !== name) {
          return { status: "failed", remediation: `This Mac's Tailscale name changed from ${recordedHost} to ${name}. Phones added under the old name must be added again — \`metistry remote set tailscale\` records the new one.`, meta: { recorded: recordedHost, dns_name: name } };
        }
        const meta = { host_port: hostPort ?? null, proxy: handler.proxy ?? null, proxy_port: ctx.proxyPort, console_port: ctx.consolePort };
        switch (classifyUpstream(handler.proxy, ctx)) {
          case "proxy":
            return { meta: { ...meta, info: `${hostPort} → ${handler.proxy}` } };
          case "main":
            return { status: "failed", remediation: mainPortRemediation("tailscale"), meta };
          case "other":
            return { status: "failed", remediation: `Tailscale is forwarding ${hostPort} to ${handler.proxy}, which is not this console's proxy listener (port ${ctx.proxyPort}). Run \`metistry remote set tailscale\`.`, meta };
          case "none":
            return { status: "failed", remediation: "Tailscale isn't forwarding to Metistry. Run `metistry remote set tailscale`.", meta };
        }
      }, setAgain);

      if (mode === "funnel") {
        await row("public-name", `${name ?? "the node's name"} resolves in public DNS from this Mac`, async () => {
          if (!name) return { status: "failed", remediation: "there is no name to resolve yet (MagicDNS, above)", meta: {} };
          const addrs = await deps.lookup(name);
          if (addrs.length === 0) return { status: "failed", remediation: `${name} hasn't appeared in public DNS yet — Tailscale says this can take up to 10 minutes after Funnel is turned on. If it stays this way, run \`metistry remote set tailscale\` again.`, meta: { dns_name: name, addresses: [] } };
          return { meta: { dns_name: name, addresses: addrs, info: `${name} → ${addrs.join(", ")}` } };
        });
      }

      await row("key-expiry", `the node key expires more than ${KEY_EXPIRY_WARN_DAYS} days from now, or never`, async () => {
        if (!status) return { status: "failed", remediation: notRunningSentence(from), meta: {} };
        const raw = status.Self?.KeyExpiry;
        if (!raw) return { meta: { key_expiry: null, info: "key expiry is disabled for this node" } };
        const at = Date.parse(raw);
        if (Number.isNaN(at)) return { status: "degraded", remediation: `Tailscale reports a key expiry of ${raw}, which is not a date`, meta: { key_expiry: raw } };
        const days = Math.floor((at - deps.now()) / 86_400_000);
        const date = new Date(at).toISOString().slice(0, 10);
        const fix = from === "pack" ? "Disable key expiry for it in the admin console (Machines), or `metistry remote authorize tailscale` to sign in again before then." : "Disable key expiry for it in the admin console (Machines), or sign in again from the Tailscale menu before then.";
        if (days < 0) return { status: "failed", remediation: `This Mac's Tailscale key expired on ${date}. ${fix}`, meta: { key_expiry: raw, days } };
        if (days <= KEY_EXPIRY_WARN_DAYS) return { status: "degraded", remediation: `This Mac's Tailscale key expires on ${date} (${days} day${days === 1 ? "" : "s"}). ${fix}`, meta: { key_expiry: raw, days } };
        return { meta: { key_expiry: raw, days, info: `expires ${date}` } };
      }, from === "pack" ? authorize : undefined);

      return rows;
    },

    async revoke(ctx: RemoteContext): Promise<Revoked> {
      const mode = recordedMode(ctx);
      const { node, from, status } = await recordedNode(ctx);
      const undone: string[] = [];
      const left: string[] = [];
      const name = dnsNameOf(status) ?? (ctx.record.origin ? new URL(ctx.record.origin).hostname : undefined);
      const hostPort = name ? `${name}:${TAILSCALE_HTTPS_PORT}` : `the node's name:${TAILSCALE_HTTPS_PORT}`;
      const verb = mode === "funnel" ? "funnel" : "serve";
      if (from === "app") {
        // the owner's node: only the handler Metistry added goes; the app stays signed in
        if (node && status) {
          if (ctx.dryRun) undone.push(`turn off the ${verb} handler for ${hostPort} (your app stays signed in)`);
          else {
            const r = await ts(ctx, node, [verb, `--https=${TAILSCALE_HTTPS_PORT}`, "off"], 30_000);
            if (r.code !== 0 && !/no .*(handler|serve|config)/i.test(`${r.stdout}${r.stderr}`)) throw new Error(`\`tailscale ${verb} --https=${TAILSCALE_HTTPS_PORT} off\` exited ${r.code}: ${(r.stderr || r.stdout).trim().split("\n").slice(-1)[0]}`);
            undone.push(`the ${verb} handler for ${hostPort} turned off (your Tailscale app stays signed in)`);
          }
        } else {
          left.push(`the ${verb} handler for ${hostPort}, if your Tailscale app still has one — it isn't running now, so it couldn't be turned off (\`tailscale ${verb} --https=${TAILSCALE_HTTPS_PORT} off\`)`);
        }
        return { undone, left_for_owner: left };
      }
      // the bundled node: handler off, signed out, stopped, its state gone
      if (node && status) {
        if (ctx.dryRun) {
          undone.push(`reset the node's serve config (the ${verb} handler for ${hostPort})`, "log the node out of Tailscale");
        } else {
          const reset = await ts(ctx, node, ["serve", "reset"], 30_000);
          if (reset.code !== 0) throw new Error(`\`tailscale serve reset\` exited ${reset.code}: ${(reset.stderr || reset.stdout).trim().split("\n").slice(-1)[0]}`);
          undone.push(`the ${verb} handler for ${hostPort} removed (serve config reset)`);
          const out = await ts(ctx, node, ["logout"], 30_000);
          if (out.code !== 0) throw new Error(`\`tailscale logout\` exited ${out.code}: ${(out.stderr || out.stdout).trim().split("\n").slice(-1)[0]}`);
          undone.push("the node logged out of Tailscale (its node key is revoked)");
        }
      } else if (node) {
        left.push("the node isn't running, so it couldn't be logged out — its key still appears in your Tailscale admin console until it expires or you remove it");
      }
      if (ctx.platform === "darwin") await stopNode(ctx, undone);
      const dir = tailscaleStateDir(ctx.instanceDir);
      if (ctx.dryRun) undone.push(`remove the node's state ${dir}`);
      else if (existsSync(dir)) {
        await rm(dir, { recursive: true, force: true });
        undone.push(`the node's state ${dir} removed`);
      }
      left.push(`the node ${ctx.record.settings.node ?? name ?? "metistry-<instance>"} in your Tailscale admin console (Machines) — remove it there`);
      return { undone, left_for_owner: left };
    },

    async authorize(ctx: RemoteContext, opts: AuthorizeOptions): Promise<{ signed_in: boolean; detail: string }> {
      const s = await survey(ctx);
      const from = chooseNodeSource({}, s.appRunning, ctx.record.provider === "tailscale" ? ctx.record.settings.node_from : undefined);
      const node = from === "app" ? s.app : s.packed;
      if (!node) {
        return { signed_in: false, detail: from === "pack" ? "Metistry's Tailscale pack isn't here — `metistry remote set tailscale` fetches it and signs in" : "Tailscale isn't installed on this Mac. Install it from tailscale.com or the App Store, then sign in." };
      }
      if (from === "pack" && !(await readStatus(ctx, node))) await startNode(ctx, node);
      try {
        const st = await signIn(ctx, node, { noBrowser: opts.noBrowser, timeoutMs: opts.timeoutMs });
        const name = dnsNameOf(st);
        return { signed_in: true, detail: `${from === "pack" ? "this Mac's Metistry node" : "your Tailscale app"} is signed in${name ? ` as ${name}` : ""}` };
      } catch (e) {
        return { signed_in: false, detail: e instanceof Error ? e.message : String(e) };
      }
    },
  };
  return provider;
}

/** The adapter this release ships, on the real seams. */
export const tailscale: RemoteProvider = tailscaleProvider();
