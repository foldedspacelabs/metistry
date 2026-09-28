// The Linear sync's test instance: a scratch instance directory under
// os.tmpdir() with one Linear connection, its secret's policy and (optionally)
// a scheduled.yaml entry, opened through the console's own opener
// (`instanceSyncOpener`) over a fake Linear that answers from the recorded
// GraphQL fixtures in `collectors/linear/fixtures/`.
//
// The fixtures are written from Linear's GraphQL schema, in the shape
// `https://api.linear.app/graphql` answers `MetistryAssignedIssues`,
// `MetistryIssuesById`, `MetistryIssueToComplete` and `MetistryCompleteIssue` — not captured from a live workspace: no test calls
// the real API, and no key or workspace data is in the repository.
//
//   assigned-1a.json, assigned-1b.json  the first pass, two pages (the cursor is followed)
//   assigned-2.json                     the second pass: ENG-101 renamed; ENG-102 and ENG-103 gone from the list
//   issues-by-id-2.json                 what became of those two: ENG-102 completed, ENG-103 given to someone else
//   complete-read.json                  Close in Linear's read (`MetistryIssueToComplete`): OPS-7, open, and its team's two completed states
//   complete-update.json                its one change (`MetistryCompleteIssue`): OPS-7 moved to Done

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { instanceSyncOpener, type SyncOpener } from "@foldedspacelabs/metistry-connections";

export const SEED_DIR = fileURLToPath(new URL("../../seed", import.meta.url));
// a personal key's shape, built at run time so no key-shaped literal is in the tree
export const KEY = ["lin", "api", "Tr5Wq8Zx2Cv7Bn4Ml1Kj6Hg3Fd9Sa0Po2Iu4Yt7Re"].join("_");
export const ENV = { METISTRY_SECRET_LINEAR_API_KEY: KEY };

export const CONNECTION_YAML = `name: linear
type: tracker
provider: linear
reach:
  http:
    url: https://api.linear.app/graphql
    auth: { scheme: api_key, header: Authorization, secret: linear_api_key }
secrets: [linear_api_key]
`;

export const SECRETS_YAML = `secrets:
  linear_api_key:
    hosts: [api.linear.app]
    grants: { "connection:linear": on }
`;

export function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`../linear/fixtures/${name}`, import.meta.url), "utf8"));
}

/** A scratch instance with the Linear connection. `files` overrides or adds `.metistry/` files by name. */
export function linearInstance(files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "metistry-linear-"));
  mkdirSync(join(dir, ".metistry", "connections"), { recursive: true });
  const all: Record<string, string> = { "connections/linear.yaml": CONNECTION_YAML, "secrets.yaml": SECRETS_YAML, ...files };
  for (const [rel, text] of Object.entries(all)) writeFileSync(join(dir, ".metistry", rel), text);
  return dir;
}

export interface Sent {
  url: string;
  authorization: string | null;
  operation: string;
  variables: Record<string, unknown>;
}

/**
 * A fake Linear answering by operation name: `assigned` is the sequence of
 * pages `MetistryAssignedIssues` returns (in order, the last repeating), and
 * `byId` what `MetistryIssuesById` returns. Records every request as it
 * reached the wire — after the door filled it.
 */
export function fakeLinear(script: { assigned: unknown[]; byId?: unknown; complete?: { read: unknown; update?: unknown } }): { fetch: typeof fetch; sent: Sent[] } {
  const sent: Sent[] = [];
  let page = 0;
  const f = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const body = JSON.parse(String(init.body ?? "{}")) as { query?: string; variables?: Record<string, unknown> };
    const operation = /(?:query|mutation)\s+(\w+)/.exec(body.query ?? "")?.[1] ?? "";
    sent.push({ url: String(input), authorization: new Headers(init.headers).get("authorization"), operation, variables: body.variables ?? {} });
    if (operation === "MetistryIssuesById") return Response.json(script.byId ?? { data: { issues: { nodes: [] } } });
    if (operation === "MetistryIssueToComplete") return Response.json(script.complete?.read ?? { data: { issue: null } });
    if (operation === "MetistryCompleteIssue") return Response.json(script.complete?.update ?? { errors: [{ message: "no update scripted" }] });
    const answer = script.assigned[Math.min(page, script.assigned.length - 1)];
    page++;
    return Response.json(answer);
  }) as typeof fetch;
  return { fetch: f, sent };
}

/** The console's opener over a scratch instance and a fake Linear. */
export function opener(instanceDir: string, fetchFn: typeof fetch, env: NodeJS.ProcessEnv = ENV): SyncOpener {
  return instanceSyncOpener({ instanceDir, seedDir: SEED_DIR, extensions: false, env, fetch: fetchFn });
}
