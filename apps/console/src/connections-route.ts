// `GET /api/connections` and `GET /api/connections/:name` — the Connections
// list and one connection (design-build-plan §2.1, §2.6; T4-8a). Owner reach,
// read-only: every write — a new connection, a changed command, a tool moved
// to Allow, the offer switch — is `metistry connections` on the Mac (M13),
// because a connection file says where Metistry reaches and with which
// credential, which is the boundary (invariant 10: no route writes one).
//
// The rows are `packages/connections`' own (`describeConnections`), so the
// Mac, the phone and the terminal say one thing. A row carries NAMES — a
// header's, an environment variable's, a secret's — never a value; a file
// that broke a rule (a key pasted where a name belongs) shows its name, its
// status and why, and nothing it holds.
//
// Nothing here dials. A GET that started a command or reached a server would
// be a read with a side effect; whether a connection answers is `metistry
// connections test` and `metistry doctor` on the Mac. What the last check
// found (`last_checked`) is read from the stamp that check left in the
// instance's state directory — a read, not a dial (`packages/connections`'
// `stamps.ts`).
//
// It degrades absent like the Secrets list: with no instance directory the
// console cannot see the files (the compose shape gives it no mount, by
// design), and both routes answer 503 naming what is missing.

import { resolveInstanceLayout, type SecretPresence } from "@foldedspacelabs/metistry-core";
import {
  CONNECTION_FILE_RE,
  describeConnectionDetail,
  describeConnectionTypes,
  describeConnections,
  loadInstanceCatalog,
  type ConnectionDetail,
  type ConnectionRow,
  type ConnectionTypeSummary,
  type ConnectionUser,
} from "@foldedspacelabs/metistry-connections";
import type { AgentRow } from "./agents.js";

/** What the console reads connections through. Absent from `ConsoleConfig` = no instance directory here, and both routes are 503. */
export interface ConnectionsView {
  /** the instance repo: `.metistry/connections/`, `variables.yaml`, `secrets.yaml`, `scheduled.yaml`, `.metistry/extensions/` */
  instanceDir: string;
  /** the product's `seed/` — the shipped connection types */
  seedDir?: string | undefined;
  /** presence only, bound to THIS instance's id — never a value; absent = no Keychain here, and nothing is said about items */
  presence?: SecretPresence | undefined;
}

export const CONNECTIONS_NOT_AVAILABLE =
  "connections are not readable from this deployment — the console needs METISTRY_INSTANCE_DIR pointing at the instance repo whose `.metistry/connections/` it lists " +
  "(the compose shape deliberately gives the console no instance mount — docs/ops/deployment-shapes.md). `metistry connections list` works either way.";

/** `GET /api/connections/:name` — a connection's name, lowercase kebab-case (the file is `<name>.yaml`). */
export const CONNECTION_ROUTE = /^GET \/api\/connections\/([^/]+)$/;

export function validConnectionName(name: string): boolean {
  return CONNECTION_FILE_RE.test(`${name}.yaml`) && name.length <= 64;
}

/**
 * Who is granted which connection (`used_by`'s agents and crews, X-96): the
 * live registry rows whose grants name it, by connection. Revoked and still
 * pending rows authenticate nothing and are left out; the assistant (an
 * `internal` row) reaches every connection and is not listed against each.
 * Whether a grant reaches is the offer switch's, which the listing applies.
 */
export function connectionGrants(rows: readonly Pick<AgentRow, "id" | "kind" | "grants" | "revoked" | "pending">[]): Map<string, ConnectionUser[]> {
  const out = new Map<string, ConnectionUser[]>();
  for (const r of rows) {
    if (r.revoked || r.pending || r.kind === "internal") continue;
    const kind = r.kind === "crew" ? "crew" : "agent";
    for (const name of new Set(r.grants.connections ?? [])) out.set(name, [...(out.get(name) ?? []), { kind, name: r.id }]);
  }
  return out;
}

function catalogOf(view: ConnectionsView) {
  return loadInstanceCatalog({ instanceDir: view.instanceDir, ...(view.seedDir ? { seedDir: view.seedDir } : {}) });
}

/**
 * `GET /api/connections` in full: every connection, and every connection type
 * this instance has installed — the product's seed and the owner's
 * extensions through the one registry (§2.7) — so *Add Connection* can offer
 * a known service and render its fields (T6-13b). A type is its manifest's
 * shape: field KINDS, never a value, and nothing of an OAuth field's client.
 * One catalog read serves both.
 */
export async function connectionsListing(view: ConnectionsView, granted?: ReadonlyMap<string, readonly ConnectionUser[]>): Promise<{ connections: ConnectionRow[]; types: ConnectionTypeSummary[] }> {
  const catalog = await catalogOf(view);
  return { connections: await describeConnections(catalog, { presence: view.presence, granted }), types: describeConnectionTypes(catalog.types) };
}

/** One connection in full, or undefined when there is no such file. */
export async function oneConnection(view: ConnectionsView, name: string, granted?: ReadonlyMap<string, readonly ConnectionUser[]>): Promise<ConnectionDetail | undefined> {
  const rel = `${resolveInstanceLayout(view.instanceDir).layout.connectionsDir}/${name}.yaml`;
  return describeConnectionDetail(name, await catalogOf(view), rel, { presence: view.presence, granted });
}
