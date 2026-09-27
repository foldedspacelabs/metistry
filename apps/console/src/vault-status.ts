// `GET /api/vault/status` (design-build-plan §2.21, T10-2): branch, ahead and
// behind, last commit, last push and pull, any conflict, and the sync policy
// in force — Settings ▸ Instance's *History* reads it (T10-7), and every
// `vault.sync` event sends a client back here.
//
// The console holds no git and no working tree (D5, invariant 7): the answer
// is the reconciler's `GET /vault/status`, fetched with the console's bearer
// and parsed with core's STRICT `vaultStatusSchema` before it is sent on, so
// the route can only ever carry the fields the schema names — whatever the
// bridge says.

import { vaultStatusSchema, type VaultStatus } from "@foldedspacelabs/metistry-core";

/** What the console reads the status through. Absent from `ConsoleConfig` = no vault bridge in this deployment, and the route is 503. */
export type VaultStatusReader = () => Promise<VaultStatus>;

export const VAULT_STATUS_NOT_AVAILABLE =
  "the vault's sync status comes from the reconciler, and no vault bridge is configured in this deployment — METISTRY_RECONCILER_URL + METISTRY_BRIDGE_TOKEN_RECONCILER (docs/ops/reconciler.md)";

/** The bridge did not give a status: down, refused, or answered something that is not one. */
export class VaultStatusUnavailable extends Error {}

export function httpVaultStatus(cfg: { url: string; token: string; timeoutMs?: number }): VaultStatusReader {
  const base = cfg.url.replace(/\/+$/, "");
  return async () => {
    let r: Response;
    try {
      r = await fetch(`${base}/vault/status`, { headers: { authorization: `Bearer ${cfg.token}` }, signal: AbortSignal.timeout(cfg.timeoutMs ?? 10_000) });
    } catch (err) {
      throw new VaultStatusUnavailable(`the reconciler did not answer (${err instanceof Error ? err.message : String(err)})`);
    }
    if (!r.ok) throw new VaultStatusUnavailable(`the reconciler answered HTTP ${r.status} — a reconciler older than this console has no /vault/status; \`metistry restart reconciler\` after an update`);
    return parseVaultStatus(await r.json().catch(() => undefined));
  };
}

/** The strict parse, on this side of the wire. */
export function parseVaultStatus(body: unknown): VaultStatus {
  const parsed = vaultStatusSchema.safeParse(body);
  if (!parsed.success) throw new VaultStatusUnavailable("the reconciler's /vault/status did not match the status schema");
  return parsed.data;
}
