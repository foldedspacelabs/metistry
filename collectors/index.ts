// Collector registry, consumed by the console's routine runner. Adding a
// collector = a directory with a manifest + run.ts, plus one line here
// (the manifest stays the contract; this is just the module map until the
// runner grows dynamic loading).

import type { CollectorCtx, Db } from "./inbox-drain/run.js";
import { run as inboxDrain } from "./inbox-drain/run.js";
import { run as githubState } from "./github-state/run.js";
import { run as awsCosts } from "./aws-costs/run.js";
import { run as claudeUsage } from "./claude-usage/run.js";
import { run as devinKnowledge } from "./devin-knowledge/run.js";
import { run as devinSessions } from "./devin-sessions/run.js";

export interface RegisteredCollector {
  name: string;
  /** parsed from the manifest's schedule by the runner */
  run(db: Db, ctx?: CollectorCtx): Promise<number>;
}

export const collectors: RegisteredCollector[] = [
  { name: "inbox-drain", run: inboxDrain },
  { name: "github-state", run: githubState },
  { name: "aws-costs", run: awsCosts },
  { name: "claude-usage", run: claudeUsage },
  { name: "devin-knowledge", run: devinKnowledge },
  { name: "devin-sessions", run: devinSessions },
];
export type { Db, CollectorCtx };

// The Devin conventions the console's dispatcher shares with these
// collectors — ONE base URL and ONE `external_ref` format in the repo, not a
// copy on each side of the round trip (targets/devin-sessions).
export { DEVIN_API } from "./devin-knowledge/run.js";
export {
  REF_PREFIX as DEVIN_REF_PREFIX,
  devinRef,
  parseDevinRef,
  SOURCE_AGENT as DEVIN_SOURCE_AGENT,
  type DevinWorkMeta,
} from "./devin-sessions/run.js";
