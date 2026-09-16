// Reconciler entrypoint. Config from environment only (invariant 7); the
// instance repo path is the ONE path this process knows, and this is the
// only process that holds it.

import pg from "pg";
import { EMBED_DEFAULT_BATCH, EMBED_DEFAULT_DIM, EMBED_DEFAULT_MODEL, EMBED_DEFAULT_URL, EmbedClient, intEnv, optionalEnv, requireEnv } from "@foldedspacelabs/metistry-core";
import { Git } from "./git.js";
import { Committer } from "./committer.js";
import { Vault } from "./vault.js";
import { Embeddings } from "./embeddings.js";
import { Indexer } from "./indexer.js";
import { makeBridge } from "./server.js";

const instanceDir = requireEnv("METISTRY_INSTANCE_DIR");
const token = requireEnv("METISTRY_BRIDGE_TOKEN_RECONCILER");
const host = optionalEnv("METISTRY_RECONCILER_HOST", "127.0.0.1"); // loopback default (invariant 8)
const port = intEnv("METISTRY_RECONCILER_PORT", 7812);
const commitIntervalSec = intEnv("METISTRY_COMMIT_INTERVAL_SEC", 30);
const reconcileIntervalSec = intEnv("METISTRY_RECONCILE_INTERVAL_SEC", 300);
const pushEverySec = parsePushSchedule(optionalEnv("METISTRY_PUSH_SCHEDULE", "@hourly"));

const pool = new pg.Pool({
  host: optionalEnv("METISTRY_DB_HOST", "127.0.0.1"),
  port: intEnv("METISTRY_DB_PORT", 5432),
  database: optionalEnv("METISTRY_DB_NAME", "metistry"),
  user: optionalEnv("METISTRY_DB_USER", "metistry"),
  password: requireEnv("METISTRY_DB_PASSWORD"),
  max: 2,
});

const git = new Git(instanceDir);
if (!(await git.isRepo())) {
  throw new Error(`METISTRY_INSTANCE_DIR=${instanceDir} is not a git repository — see docs/ops/reconciler.md`);
}
const committer = new Committer(git, {
  authorPrefix: optionalEnv("METISTRY_GIT_AUTHOR_NAME", "Metistry"),
  authorEmail: optionalEnv("METISTRY_GIT_AUTHOR_EMAIL", "metistry@localhost"),
  sourceTrailer: "Brain-Source", // §4.7 commit hygiene: self-declared provenance, never authorization
});
const vault = new Vault(instanceDir, git, committer, { maxBytes: intEnv("METISTRY_VAULT_MAX_BYTES", 2 * 1024 * 1024) });

// Phase 6: embeddings are on by default and cost nothing when the embedder
// is absent — the cycle degrades, the index does not (§6 decision 8).
const embedClient = new EmbedClient({
  url: optionalEnv("METISTRY_OLLAMA_URL", EMBED_DEFAULT_URL),
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
  { commitExternalEdits: optionalEnv("METISTRY_COMMIT_EXTERNAL_EDITS", "true") !== "false" },
  embeddings,
);

const server = makeBridge(
  { vault, committer, indexer, embeddings, embedClient, db: pool },
  { token, maxBodyBytes: intEnv("METISTRY_VAULT_MAX_BYTES", 2 * 1024 * 1024) + 64 * 1024 },
);
server.listen(port, host, () => {
  console.log(`reconciler listening on ${host}:${port} (repo: ${instanceDir}; commit every ${commitIntervalSec}s; reconcile every ${reconcileIntervalSec}s; push ${pushEverySec ? `every ${pushEverySec}s` : "never"})`);
});

setInterval(() => {
  committer.flush().then(
    (r) => {
      if (r.commits.length || r.failed) console.log(`reconciler: flushed ${r.commits.length} commit(s)${r.failed ? `, ${r.failed} failed` : ""}`);
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

if (pushEverySec) {
  setInterval(() => {
    committer.push().then((r) => {
      if (r.attempted) console.log(`reconciler: push ${r.ok ? "ok" : "failed"} (${r.remote})`);
    });
  }, pushEverySec * 1000);
}

/** `@hourly` | `@daily` | `never` | `<n>s` | `<n>m` | `<n>h` → seconds (0 = never). */
function parsePushSchedule(s: string): number {
  const v = s.trim().toLowerCase();
  if (v === "never" || v === "" || v === "0") return 0;
  if (v === "@hourly") return 3600;
  if (v === "@daily") return 86400;
  const m = /^(\d+)([smh]?)$/.exec(v);
  if (!m) throw new Error(`METISTRY_PUSH_SCHEDULE must be @hourly, @daily, never, or <n>[s|m|h] — got "${s}"`);
  const n = Number(m[1]);
  return m[2] === "m" ? n * 60 : m[2] === "h" ? n * 3600 : n;
}
