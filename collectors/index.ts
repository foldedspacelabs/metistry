// Collector registry, consumed by the console's routine runner. Adding a
// collector = a directory with a manifest + run.ts, plus one line here
// (the manifest stays the contract; this is just the module map until the
// runner grows dynamic loading).

import type { CollectorCtx, Db } from "./inbox-drain/run.js";
import { run as inboxDrain } from "./inbox-drain/run.js";
import { run as githubState } from "./github-state/run.js";

export interface RegisteredCollector {
  name: string;
  /** parsed from the manifest's schedule by the runner */
  run(db: Db, ctx?: CollectorCtx): Promise<number>;
}

export const collectors: RegisteredCollector[] = [
  { name: "inbox-drain", run: inboxDrain },
  { name: "github-state", run: githubState },
];
export type { Db, CollectorCtx };
