// `GET /api/secrets` — the Secrets list for every client (design-build-plan
// §2.14, T4-1): names, *Sent only to*, *Who may use it*, expiry, whether this
// instance's Keychain account holds an item, and *last used*. **Never a
// value**, and not by a promise: nothing this file is handed can return one.
//
//   * the POLICY comes from `.metistry/secrets.yaml`, whose schema (core's
//     `secretsFileSchema`) is strict — a file that tries to carry a value
//     does not load, and the route answers 400 naming the field;
//   * PRESENCE comes from a `SecretPresence` — `has(name)`, nothing else —
//     built in main.ts over `security find-generic-password` WITHOUT `-w`,
//     bound to this instance's `instance_id`. The console holds no call that
//     reads a Keychain item's data;
//   * *LAST USED* comes from the `secret_last_used` named query (invariant 3)
//     over the names the egress fill stamps on its run.
//
// Every write — set, replace, remove, hosts, grant — is `metistry secrets`
// on the Mac (M7): a value never crosses the API in either direction.
//
// It degrades absent like compute: with no instance directory the console
// cannot see the file (the compose shape gives it no mount, by design), and
// the route answers 503 naming what is missing.

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { SECRET_LAST_USED_QUERY, describeSecrets, parseSecretsFile, type SecretPresence, type SecretRow } from "@foldedspacelabs/metistry-core";
import type { QueryStore } from "@foldedspacelabs/metistry-queries";

/** What the console reads secrets through. Absent from `ConsoleConfig` = this deployment has no instance directory to read, and the route is 503. */
export interface SecretsView {
  /** `<instanceDir>/.metistry/secrets.yaml` — absent file = no secrets yet */
  file: string;
  /** presence only, bound to THIS instance's id; absent = no Keychain here (a container, Linux) and `present` is null */
  presence?: SecretPresence | undefined;
}

export const SECRETS_NOT_AVAILABLE =
  "secrets are not readable from this deployment — the console needs METISTRY_INSTANCE_DIR pointing at the instance repo whose `.metistry/secrets.yaml` it lists " +
  "(the compose shape deliberately gives the console no instance mount — docs/ops/deployment-shapes.md). `metistry secrets list --named` works either way.";

export type SecretsListing = { ok: true; secrets: SecretRow[] } | { ok: false; message: string };

/** The listing, or the reason the file does not validate. */
export async function listSecrets(view: SecretsView, queries: QueryStore): Promise<SecretsListing> {
  let file;
  try {
    file = parseSecretsFile(existsSync(view.file) ? await readFile(view.file, "utf8") : "");
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
  return { ok: true, secrets: await describeSecrets(file, view.presence, await lastUsed(queries)) };
}

/** name → ISO timestamp of its newest use. The query's absence is "never", not an error: the list is the file, and *last used* is derived. */
async function lastUsed(queries: QueryStore): Promise<Map<string, string>> {
  if (!queries.names().includes(SECRET_LAST_USED_QUERY)) return new Map();
  const { rows } = await queries.run(SECRET_LAST_USED_QUERY);
  const out = new Map<string, string>();
  for (const r of rows) {
    const at = r.last_used instanceof Date ? r.last_used.toISOString() : typeof r.last_used === "string" ? new Date(r.last_used).toISOString() : undefined;
    if (typeof r.name === "string" && at) out.set(r.name, at);
  }
  return out;
}
