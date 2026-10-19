// The registry of remote-access adapters, the chooser's rows, and doctor's
// `remote` kind (plan §2.23, "Doctor rows"). Imported by doctor.ts, so this
// file holds nothing that writes: the verbs are index.ts.
//
// Every provider gets the three shared rows before its own — *tool present*,
// *proxy listener* and *answers from this Mac* — because they are the three
// things that can be wrong with ANY provider, and the middle one is the
// finding X-103 closed: a provider forwarding to the console's MAIN port is
// honouring this Mac's owner token for whatever a tunnel carries, and doctor
// fails it by name.

import { REMOTE_PROVIDERS, instanceStatePath, remoteOf, runCheck, type Deployment, type RemoteProviderId, type RemoteRecord } from "@foldedspacelabs/metistry-core";
import { consolePort, consoleProxyPort } from "../deployment.js";
import { realExec, type Exec } from "../exec.js";
import { readInstanceId } from "../instance.js";
import { checkOriginReachable } from "../origins.js";
import { readSecretValue } from "../stdin-value.js";
import { none } from "./none.js";
import type { Detection, RemoteChoice, RemoteContext, RemoteProvider, RemoteRow } from "./provider.js";

/** The console's proxy socket, as the console names it (apps/console/src/proxy-listener.ts `PROXY_SOCKET_FILENAME`) — the same spelling, held to it by the conformance of `docs/ops/auth.md`. */
export const PROXY_SOCKET_FILENAME = "console-proxy.sock";

export function proxySocketPath(instanceDir: string): string {
  return instanceStatePath(instanceDir, PROXY_SOCKET_FILENAME);
}

export type RemoteRegistry = Partial<Record<RemoteProviderId, RemoteProvider>>;

/** The adapters this release ships. One per ticket: X-106 adds `tailscale`, X-108 `cloudflare`, … — a record naming one not here is reported, never guessed at. */
export const REMOTE_PROVIDERS_BUILT_IN: RemoteRegistry = { none };

export function providerFor(id: string, registry: RemoteRegistry = REMOTE_PROVIDERS_BUILT_IN): RemoteProvider | undefined {
  return (REMOTE_PROVIDERS as readonly string[]).includes(id) ? registry[id as RemoteProviderId] : undefined;
}

/** The ids a registry can run, in the chooser's order. */
export function availableProviders(registry: RemoteRegistry = REMOTE_PROVIDERS_BUILT_IN): RemoteProviderId[] {
  return REMOTE_PROVIDERS.filter((id) => registry[id] !== undefined);
}

/**
 * The chooser (plan §2.23, "The choices"), in this order wherever it is
 * listed. The facts are the plan's — each row names what it needs, who can
 * read the traffic, and the cost — so the wizard, Settings ▸ Remote Access
 * and `metistry remote --json` cannot disagree about them.
 */
export function remoteChoices(registry: RemoteRegistry = REMOTE_PROVIDERS_BUILT_IN): RemoteChoice[] {
  const rows: Omit<RemoteChoice, "available">[] = [
    { id: "none", label: "None", tag: "default", reachable_from: "this Mac only", tls_ends_at: "—", cost: "$0", needs: "nothing" },
    { id: "tailscale", label: "Tailscale — Any browser (Funnel)", tag: "recommended", reachable_from: "the internet; the phone needs no app", tls_ends_at: "the Mac", cost: "$0 (all plans)", needs: "a Tailscale account" },
    { id: "relay", label: "Metistry Relay", reachable_from: "the internet; no account anywhere", tls_ends_at: "the Mac (the relay passes TLS through unopened)", cost: "$0 — 5 GB a month", needs: "nothing" },
    { id: "cloudflare", label: "Cloudflare Tunnel", reachable_from: "the internet", tls_ends_at: "Cloudflare", cost: "$0 + a domain (~$10/yr)", needs: "a Cloudflare account with a domain on it" },
    { id: "zrok", label: "zrok", reachable_from: "the internet", tls_ends_at: "zrok's frontend (NetFoundry)", cost: "$0 (5 GB/day; a warning page unless a card is verified)", needs: "a zrok.io account" },
    { id: "ngrok", label: "ngrok", reachable_from: "the internet", tls_ends_at: "ngrok", cost: "$0 with a weekly warning page; $10/mo removes it", needs: "an ngrok account" },
    { id: "port-forward", label: "Port forwarding", reachable_from: "the internet", tls_ends_at: "the Mac", cost: "$0; impossible behind CGNAT", needs: "a router that allows NAT-PMP/UPnP, or a forward made by hand" },
  ];
  return rows.map((r) => ({ ...r, available: registry[r.id] !== undefined }));
}

// ---- the context ----------------------------------------------------------------

export interface RemoteContextOptions {
  productDir: string;
  instanceDir: string;
  env: NodeJS.ProcessEnv;
  record: RemoteRecord;
  instanceId?: string | undefined;
  exec?: Exec | undefined;
  fetchFn?: typeof fetch | undefined;
  platform?: NodeJS.Platform | undefined;
  uid?: number | undefined;
  /** test seam for a pasted token; default stdin or the hidden prompt (stdin-value.ts) */
  readToken?: ((what: string) => Promise<string>) | undefined;
  note?: ((line: string) => void) | undefined;
  dryRun?: boolean | undefined;
  timeoutMs?: number | undefined;
}

/** The context every adapter verb takes, with the console's two ports and the socket resolved from THIS install's environment (a namespaced block included). */
export function remoteContext(o: RemoteContextOptions): RemoteContext {
  return {
    productDir: o.productDir,
    instanceDir: o.instanceDir,
    env: o.env,
    instanceId: o.instanceId,
    record: o.record,
    consolePort: consolePort(o.env),
    proxyPort: consoleProxyPort(o.env),
    proxySocket: proxySocketPath(o.instanceDir),
    exec: o.exec ?? realExec,
    fetchFn: o.fetchFn ?? fetch,
    platform: o.platform ?? process.platform,
    uid: o.uid ?? (typeof process.getuid === "function" ? process.getuid() : 0),
    readToken: o.readToken ?? ((what) => readSecretValue(what)),
    note: o.note ?? (() => {}),
    dryRun: o.dryRun === true,
    timeoutMs: o.timeoutMs ?? 5000,
  };
}

// ---- the shared rows --------------------------------------------------------------

/** The sentence doctor fails a misdirected provider with (§2.23, "Doctor rows"), verbatim. */
export function mainPortRemediation(provider: string): string {
  return `${provider} is forwarding to the console's main port, which accepts this Mac's owner token. Run \`metistry remote set ${provider}\`.`;
}

/**
 * Where the recorded upstream points: the proxy listener (its port or its
 * socket), the MAIN port, somewhere else, or nowhere recorded. A URL or a
 * bare `host:port` is read for its port; a path is compared to the socket.
 */
export function classifyUpstream(upstream: string | undefined, ctx: Pick<RemoteContext, "consolePort" | "proxyPort" | "proxySocket">): "proxy" | "main" | "other" | "none" {
  if (upstream === undefined || upstream.trim() === "") return "none";
  const u = upstream.trim();
  if (u === ctx.proxySocket || u === `unix:${ctx.proxySocket}` || u === `unix://${ctx.proxySocket}`) return "proxy";
  let port: number | undefined;
  try {
    const url = new URL(u.includes("://") ? u : `http://${u}`);
    port = url.port === "" ? (url.protocol === "https:" ? 443 : 80) : Number(url.port);
  } catch {
    return "other";
  }
  if (port === ctx.consolePort) return "main";
  if (port === ctx.proxyPort) return "proxy";
  return "other";
}

const runVerb = (command: string[], label: string): NonNullable<RemoteRow["action"]> => ({ kind: "run_verb", command, label });

/**
 * The three rows every provider gets before its own: tool present, proxy
 * listener, answers from this Mac (`GET <origin>/health` returning this
 * instance — origins.ts's probe, the same one `metistry enroll` makes).
 */
export async function sharedRemoteRows(ctx: RemoteContext, provider: RemoteProvider, detection: Detection): Promise<RemoteRow[]> {
  const p = provider.id;
  const record = ctx.record;
  const setAgain = runVerb(["metistry", "remote", "set", p], `Set up ${provider.label} again`);
  const rows: RemoteRow[] = [];

  rows.push({
    kind: "remote",
    ...(detection.tool.present ? {} : { action: setAgain }),
    ...(await runCheck(`remote:${p}:tool`, `the ${p} tool is here (${detection.tool.from === "pack" ? "Metistry's pack" : detection.tool.from === "owner" ? "your own install" : "in-process"})`, async () => {
      const meta = { provider: p, present: detection.tool.present, ...(detection.tool.version ? { version: detection.tool.version } : {}), ...(detection.tool.from ? { from: detection.tool.from } : {}) };
      if (!detection.tool.present) return { status: "absent", remediation: `the ${p} tool isn't on this Mac — \`metistry remote set ${p}\` fetches it (docs/ops/remote-access.md)`, meta };
      return { meta: { ...meta, ...(detection.tool.version ? { info: `${p} ${detection.tool.version}${detection.tool.from === "pack" ? " (Metistry's pack)" : detection.tool.from === "owner" ? " (your own install)" : ""}` } : {}) } };
    })),
  });

  const upstream = record.settings.upstream;
  const where = classifyUpstream(upstream, ctx);
  rows.push({
    kind: "remote",
    ...(where === "proxy" ? {} : { action: setAgain }),
    ...(await runCheck(`remote:${p}:proxy-listener`, `${p} forwards to the console's proxy listener (port ${ctx.proxyPort} or ${ctx.proxySocket}), never the main port ${ctx.consolePort}`, async () => {
      const meta = { provider: p, upstream: upstream ?? null, proxy_port: ctx.proxyPort, console_port: ctx.consolePort };
      switch (where) {
        case "proxy":
          return { meta };
        case "main":
          return { status: "failed", remediation: mainPortRemediation(p), meta };
        case "other":
          return { status: "failed", remediation: `${p} is forwarding to ${upstream}, which is not this console's proxy listener (port ${ctx.proxyPort}, or ${ctx.proxySocket}). Run \`metistry remote set ${p}\`.`, meta };
        case "none":
          return { status: "degraded", remediation: `${p} recorded no upstream, so nothing says where it forwards to — \`metistry remote set ${p}\` records it`, meta };
      }
    })),
  });

  const origin = record.origin;
  rows.push({
    kind: "remote",
    ...(await runCheck(`remote:${p}:answers`, origin ? `GET ${origin}/health answers from this Mac${ctx.instanceId ? " and names this instance" : ""} (within ${ctx.timeoutMs / 1000} s)` : `an origin is recorded for ${p}`, async () => {
      if (!origin) return { status: "failed", remediation: `${p} recorded no origin, so there is no address for your phone to open — \`metistry remote set ${p}\``, meta: { provider: p, origin: null } };
      let url: URL;
      try {
        url = new URL(origin);
      } catch {
        return { status: "failed", remediation: `${p}'s recorded origin ${origin} is not a URL — \`metistry remote set ${p}\``, meta: { provider: p, origin } };
      }
      const refusal = await checkOriginReachable(url, { fetchFn: ctx.fetchFn, instanceId: ctx.instanceId, provider: p, timeoutMs: ctx.timeoutMs });
      if (refusal) return { status: "failed", remediation: `${refusal.message}${refusal.detail ? ` (${refusal.detail})` : ""}`, meta: { provider: p, origin, case: refusal.case } };
      return { meta: { provider: p, origin, info: `${origin} answers from this Mac` } };
    })),
  });
  return rows;
}

// ---- doctor's `remote` kind ------------------------------------------------------

export interface RemoteRowsOptions {
  deployment: Deployment;
  productDir: string;
  instanceDir: string;
  env: NodeJS.ProcessEnv;
  fetchFn?: typeof fetch | undefined;
  exec?: Exec | undefined;
  platform?: NodeJS.Platform | undefined;
  uid?: number | undefined;
  timeoutMs?: number | undefined;
  /** test seam: the adapters (default the ones this release ships) */
  providers?: RemoteRegistry | undefined;
  /** this instance's id; read from identity.yaml when not given */
  instanceId?: string | undefined;
}

/**
 * Doctor's `remote` rows: None's one `ok` row; for a provider, the three
 * shared rows and then its own; for a provider this release has no adapter
 * for, one `failed` row that says so. Never throws — an adapter that does is
 * one failed row, not a doctor that cannot finish.
 */
export async function remoteRows(o: RemoteRowsOptions): Promise<RemoteRow[]> {
  const record = remoteOf(o.deployment);
  const registry = o.providers ?? REMOTE_PROVIDERS_BUILT_IN;
  const provider = providerFor(record.provider, registry);
  if (!provider) {
    return [
      {
        kind: "remote",
        action: runVerb(["metistry", "remote", "off"], "Turn off remote access"),
        ...(await runCheck("remote", `deployment.yaml remote: ${record.provider} — an adapter this version of Metistry has`, async () => ({
          status: "failed",
          remediation: `deployment.yaml names ${record.provider}, which this version of Metistry has no adapter for — \`metistry update\` if a newer release has it, or \`metistry remote off\` (your phone can't reach this Mac through it meanwhile)`,
          meta: { provider: record.provider, origin: record.origin ?? null, available: availableProviders(registry) },
        }))),
      },
    ];
  }
  const instanceId = o.instanceId ?? (await readInstanceId(o.instanceDir).catch(() => undefined));
  const ctx = remoteContext({ productDir: o.productDir, instanceDir: o.instanceDir, env: o.env, record, instanceId, exec: o.exec, fetchFn: o.fetchFn, platform: o.platform, uid: o.uid, timeoutMs: o.timeoutMs });
  if (provider.id === "none") return provider.status(ctx);
  try {
    const detection = await provider.detect(ctx);
    return [...(await sharedRemoteRows(ctx, provider, detection)), ...(await provider.status(ctx))];
  } catch (err) {
    return [
      {
        kind: "remote",
        ...(await runCheck(`remote:${provider.id}`, `${provider.id} reports its state`, async () => ({
          status: "failed",
          remediation: `${provider.id} could not report its state (${err instanceof Error ? err.message : String(err)}) — \`metistry remote test\` says more`,
          meta: { provider: provider.id, origin: record.origin ?? null },
        }))),
      },
    ];
  }
}
