// When each connection was last checked, and what the check found: the
// `last_checked` the listing serves (X-96).
//
// A check (`checkConnection`) is a dial made by whichever process ran it —
// `metistry connections test`, `metistry doctor`, the Mac's Test — and none of
// those holds a database. So the stamp is a small file in the instance's
// gitignored state directory, which the console, the CLI and the Mac's reads
// all see because they all see the instance (invariant 7: a path the caller
// gives, no shared filesystem beyond the instance itself). It is derived and
// disposable (invariant 1): lose it and every connection reads *never
// checked* until its next check, which is the honest answer.
//
// A stamp is a name, a time and doctor's one word — never the check's
// remediation text, which may repeat a secret's or a host's name more freely
// than a list should. Reading is tolerant (a garbled file is "never
// checked", not an error: the list is the connection files, this is
// decoration); writing is atomic (a temp file, then a rename), and writes
// within one process are serialised so a doctor pass that checks every
// connection at once keeps every stamp.

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { resolveInstanceLayout } from "@foldedspacelabs/metistry-core";

/** The file, under `<instance>/.metistry/state/`. */
export const CHECK_STAMPS_FILE = "connection-checks.json";

/** doctor's four words — what a check can find. */
export const CHECK_VERDICTS = ["ok", "degraded", "failed", "absent"] as const;
export type CheckVerdict = (typeof CHECK_VERDICTS)[number];

/** The last check of one connection, as the listing serves it. */
export interface LastChecked {
  /** ISO 8601, UTC */
  at: string;
  status: CheckVerdict;
}

function pathFor(instanceDir: string): string {
  return resolveInstanceLayout(instanceDir).state(CHECK_STAMPS_FILE);
}

function isVerdict(v: unknown): v is CheckVerdict {
  return typeof v === "string" && (CHECK_VERDICTS as readonly string[]).includes(v);
}

/** name → its last check. A missing, unreadable or garbled file is empty; one malformed entry is skipped, not fatal. */
export async function readCheckStamps(instanceDir: string | undefined): Promise<Map<string, LastChecked>> {
  const out = new Map<string, LastChecked>();
  if (!instanceDir) return out;
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(pathFor(instanceDir), "utf8"));
  } catch {
    return out;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return out;
  for (const [name, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof v !== "object" || v === null) continue;
    const { at, status } = v as { at?: unknown; status?: unknown };
    if (typeof at !== "string" || Number.isNaN(Date.parse(at)) || !isVerdict(status)) continue;
    out.set(name, { at: new Date(at).toISOString(), status });
  }
  return out;
}

let queue: Promise<unknown> = Promise.resolve();

/**
 * Record that `name` was checked now. Never throws: a state directory that
 * cannot be written is a check that goes unrecorded, not a check that fails.
 */
export function stampCheck(instanceDir: string | undefined, name: string, status: CheckVerdict, at: Date = new Date()): Promise<void> {
  if (!instanceDir) return Promise.resolve();
  const run = queue.then(async () => {
    try {
      const file = pathFor(instanceDir);
      const all = Object.fromEntries(await readCheckStamps(instanceDir));
      all[name] = { at: at.toISOString(), status };
      await mkdir(dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      await writeFile(tmp, `${JSON.stringify(all, null, 2)}\n`, { mode: 0o600 });
      await rename(tmp, file);
    } catch {
      // unrecorded, not failed
    }
  });
  queue = run;
  return run;
}
