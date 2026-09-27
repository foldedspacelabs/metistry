// Reconciler entrypoint. Config from environment only (invariant 7); the
// instance repo path is the ONE path this process knows, and this is the
// only process that holds it.

import pg from "pg";
import {
  EMBED_DEFAULT_BATCH,
  EMBED_DEFAULT_DIM,
  EMBED_DEFAULT_MODEL,
  EmbedClient,
  firstOnMachineBaseUrl,
  intEnv,
  loadCompute,
  optionalEnv,
  overlayFilesFromEnv,
  requireEnv,
  resolveInstanceLayout,
  resolveLocalModelUrl,
  describeVaultSync,
  pushOverrideNote,
} from "@foldedspacelabs/metistry-core";
import { Git } from "./git.js";
import { Committer, type PushResult } from "./committer.js";
import { Vault } from "./vault.js";
import { Embeddings } from "./embeddings.js";
import { Indexer } from "./indexer.js";
import { makeBridge } from "./server.js";
import { syncRecorder } from "./sync-record.js";
import { aheadBehind, commitRecorder, readVaultStatus, SyncScheduler, VaultPolicySource } from "./sync-policy.js";

const instanceDir = requireEnv("METISTRY_INSTANCE_DIR");
const token = requireEnv("METISTRY_BRIDGE_TOKEN_RECONCILER");
// The owner class (docs/ops/auth.md, "The principal comes from the
// credential"). Optional to START with — a reconciler that refused to boot
// would take an install down over a variable one command mints — and
// fail-CLOSED in effect: with no owner bearer, NO caller may write a §4.7
// protected path, and `check()` degrades with the fix. Never defaulted to the
// shared bearer, which is the hole this exists to close.
const ownerToken = optionalEnv("METISTRY_BRIDGE_TOKEN_RECONCILER_USER", "");
if (!ownerToken) {
  console.warn(
    "METISTRY_BRIDGE_TOKEN_RECONCILER_USER is not set: protected paths (.metistry/**, CLAUDE.md, README.md) are refused for EVERY caller, so `metistry update` and `metistry deployment set-shape` will be refused. `metistry secrets sync --to env` mints one; then restart this service.",
  );
} else if (ownerToken === token) {
  throw new Error(
    "METISTRY_BRIDGE_TOKEN_RECONCILER_USER is the same value as METISTRY_BRIDGE_TOKEN_RECONCILER — the owner class would then be every caller. Mint a distinct one: `metistry secrets mint METISTRY_BRIDGE_TOKEN_RECONCILER_USER`.",
  );
}
const host = optionalEnv("METISTRY_RECONCILER_HOST", "127.0.0.1"); // loopback default (invariant 8)
const port = intEnv("METISTRY_RECONCILER_PORT", 7812);
const commitIntervalSec = intEnv("METISTRY_COMMIT_INTERVAL_SEC", 30);
const reconcileIntervalSec = intEnv("METISTRY_RECONCILE_INTERVAL_SEC", 300);
// WHEN to push and pull (§2.21, T10-2): deployment.yaml's `vault:` block over
// the D4 overlay, re-read when the file changes; METISTRY_PUSH_SCHEDULE still
// overrides `push` for this release (a bad value stops the process here, as
// it always has).
const vaultPolicy = new VaultPolicySource(overlayFilesFromEnv(process.env, "deployment").split(":"), process.env);
if (vaultPolicy.current().policy.push_override !== undefined) console.warn(`reconciler: ${pushOverrideNote(vaultPolicy.current().policy.push_override!)}`);

const pool = new pg.Pool({
  host: optionalEnv("METISTRY_DB_HOST", "127.0.0.1"),
  port: intEnv("METISTRY_DB_PORT", 5432),
  database: optionalEnv("METISTRY_DB_NAME", "metistry"),
  user: optionalEnv("METISTRY_DB_USER", "metistry"),
  password: requireEnv("METISTRY_DB_PASSWORD"),
  max: 2,
});

// Which layout this instance is in, read ONCE. The vault root is the
// instance directory in both — what differs is where the inbox and the
// machinery sit, and a legacy instance has not run `metistry migrate-layout`
// yet (docs/ops/instance-layout.md).
const instanceLayout = resolveInstanceLayout(instanceDir);
if (instanceLayout.shape === "legacy") {
  console.warn(`instance layout: legacy — captures are ${instanceLayout.layout.inboxDir}/ and the config files are at the instance root. \`metistry migrate-layout\` moves them; \`metistry update\` will not carry this instance past 0.8.x until it has run.`);
}

const git = new Git(instanceDir);
if (!(await git.isRepo())) {
  throw new Error(`METISTRY_INSTANCE_DIR=${instanceDir} is not a git repository — see docs/ops/reconciler.md`);
}
const commitExternalEdits = optionalEnv("METISTRY_COMMIT_EXTERNAL_EDITS", "true") !== "false";
const committer = new Committer(git, {
  authorPrefix: optionalEnv("METISTRY_GIT_AUTHOR_NAME", "Metistry"),
  authorEmail: optionalEnv("METISTRY_GIT_AUTHOR_EMAIL", "metistry@localhost"),
  sourceTrailer: "Brain-Source", // §4.7 commit hygiene: self-declared provenance, never authorization
  sweepExternalEdits: commitExternalEdits, // swept before every integrate, as on every walk (§2.21 rule 2)
});
const vault = new Vault(instanceDir, git, committer, { maxBytes: intEnv("METISTRY_VAULT_MAX_BYTES", 2 * 1024 * 1024) });

// Phase 6: embeddings are on by default and cost nothing when the embedder
// is absent — the cycle degrades, the index does not (§6 decision 8). The
// wire is the local server's OpenAI-compatible /v1/embeddings (C18).
//
// compute.yaml is read here for ONE thing — the default URL when no variable
// names one — so a file that will not parse degrades to the default rather
// than stopping the reconciler. The console fails loudly on the same file;
// this process has no business being the second one to.
const computeBaseUrl = await loadCompute(optionalEnv("METISTRY_COMPUTE_FILES", overlayFilesFromEnv(process.env, "compute")))
  .then((c) => firstOnMachineBaseUrl(c.compute))
  .catch((err: unknown) => {
    console.warn(`compute.yaml is not readable for the embedder's default URL (${err instanceof Error ? err.message : String(err)})`);
    return undefined;
  });
const localModel = resolveLocalModelUrl(process.env, computeBaseUrl);
if (localModel.warning) console.warn(localModel.warning);
console.log(`embeddings: ${localModel.url}/embeddings (from ${localModel.from}), model ${optionalEnv("METISTRY_EMBED_MODEL", EMBED_DEFAULT_MODEL)}`);
const embedClient = new EmbedClient({
  url: localModel.url,
  model: optionalEnv("METISTRY_EMBED_MODEL", EMBED_DEFAULT_MODEL),
  dim: intEnv("METISTRY_EMBED_DIM", EMBED_DEFAULT_DIM),
  batch: intEnv("METISTRY_EMBED_BATCH", EMBED_DEFAULT_BATCH),
});
const readNote = async (p: string): Promise<string | null> => {
  const r = await vault.read(p);
  return r.ok ? r.value.content : null;
};
const embeddings =
  optionalEnv("METISTRY_EMBED_ENABLED", "true") === "false"
    ? undefined
    : new Embeddings(pool, embedClient, readNote, { maxFilesPerCycle: intEnv("METISTRY_EMBED_MAX_FILES_PER_CYCLE", 200) });

const indexer = new Indexer(
  pool,
  vault,
  committer,
  { commitExternalEdits, inboxPrefix: instanceLayout.layout.inboxDir },
  embeddings,
);

// the schedule over the committer's sync (T10-3 is HOW; this is WHEN). A
// sync that did something is a log line; a quiet pull is not.
const logSync = (r: PushResult): PushResult => {
  if (r.attempted && (!r.ok || r.pushed || (r.integrated && r.integrated !== "up_to_date"))) {
    console.log(`reconciler: sync ${r.ok ? "ok" : "stopped"} (${r.remote}: ${r.integrated ?? "no fetch"}${r.behind ? `, ${r.behind} in` : ""}${r.pushed ? ", pushed" : ""})`);
  }
  return r;
};
const sync = new SyncScheduler(
  () => vaultPolicy.current().policy,
  {
    push: () => committer.push().then(logSync),
    pull: () => committer.pull().then(logSync),
    ahead: async () => (await aheadBehind(git)).ahead,
    conflict: () => committer.vault.conflict,
  },
  commitRecorder(pool),
);

const server = makeBridge(
  {
    vault,
    committer,
    indexer,
    embeddings,
    embedClient,
    db: pool,
    vaultStatus: () =>
      readVaultStatus({ git, policy: () => vaultPolicy.current(), lastPush: () => sync.lastPush, lastPull: () => committer.lastPull, conflict: () => committer.vault.conflict }),
  },
  { token, ...(ownerToken ? { ownerToken } : {}), maxBodyBytes: intEnv("METISTRY_VAULT_MAX_BYTES", 2 * 1024 * 1024) + 64 * 1024 },
);
server.listen(port, host, () => {
  console.log(`reconciler listening on ${host}:${port} (repo: ${instanceDir}; commit every ${commitIntervalSec}s; reconcile every ${reconcileIntervalSec}s; ${describeVaultSync(vaultPolicy.current().policy)}; protected paths: ${ownerToken ? "the owner bearer only" : "NO caller — mint METISTRY_BRIDGE_TOKEN_RECONCILER_USER"})`);
});

setInterval(() => {
  committer.flush().then(
    (r) => {
      if (r.commits.length || r.failed) console.log(`reconciler: flushed ${r.commits.length} commit(s)${r.failed ? `, ${r.failed} failed` : ""}`);
      // a `commit` event, and under `after_commit` the push
      sync.afterFlush(r.commits.length).catch((err) => console.error("reconciler: push after commit failed:", err instanceof Error ? err.message : err));
    },
    (err) => console.error("reconciler: flush failed:", err instanceof Error ? err.message : err),
  );
}, commitIntervalSec * 1000);

const reconcile = (trigger: string) =>
  indexer.reconcile(trigger).then(
    (s) => {
      if (s.added || s.changed || s.renamed || s.removed || s.conflicts_new || s.external_edits || s.inbox.added || s.inbox.changed || s.inbox.archived) console.log(`reconciler: ${JSON.stringify(s)}`);
    },
    (err) => console.error("reconciler: reconcile failed:", err instanceof Error ? err.message : err),
  );
setTimeout(() => reconcile("startup"), 2000);
setInterval(() => reconcile("interval"), reconcileIntervalSec * 1000);

// §2.21: every sync act is a `runs` row (and a conflict its one Needs You
// report); an integrate that changed files is followed by a walk that
// starts after it, never one that read the tree before it (rule 5).
committer.hooks = {
  record: syncRecorder(pool),
  integrated: () => {
    indexer.reconcileAfter("integrate").catch((err) => console.error("reconciler: re-walk after integrate failed:", err instanceof Error ? err.message : err));
  },
};

// push and pull on the policy in force, re-reading deployment.yaml first so
// `metistry vault settings` takes effect on the next tick
let lastPolicy = describeVaultSync(vaultPolicy.current().policy);
sync.start(undefined, () => {
  if (!vaultPolicy.refresh()) return;
  const now = describeVaultSync(vaultPolicy.current().policy);
  if (now !== lastPolicy) console.log(`reconciler: vault sync policy is now ${now}`);
  lastPolicy = now;
});
