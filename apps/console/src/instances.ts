// What `GET /api/instances` serves: the instance repo's `instances.yaml`,
// the peer registry (S4, docs/ops/instances.md). A registry is a file at
// this scale, not a service — SAM's control plane is a public port, an
// admin token and a database to authorize one person's two instances
// (docs/research/2026-09-13-google-sam-review.md, SKIP).
//
// Read per request rather than once at startup, because `metistry
// instances add` writes the file through the reconciler while the console
// is running and the app should not need a restart to see a new peer. It
// is a small file behind the `user` principal; a read per call is cheaper
// than a watcher that can go stale.
//
// Same overlay rule as identity (METISTRY_INSTANCES_FILES, colon-separated,
// last existing file wins) and the same degradation: no file is an empty
// registry, not an error — an install with one instance has no peers, and
// that is the ordinary case.

import { readFile } from "node:fs/promises";
import { emptyInstances, parseInstances, type InstancesResult } from "@foldedspacelabs/metistry-core";

export async function loadInstances(paths: string): Promise<InstancesResult> {
  let found: string | null = null;
  for (const p of paths.split(":").map((s) => s.trim()).filter(Boolean)) {
    try {
      found = await readFile(p, "utf8");
    } catch (err) {
      if ((err as { code?: string }).code !== "ENOENT") throw err;
    }
  }
  return found === null ? { ok: true, value: emptyInstances, errors: [] } : parseInstances(found);
}
