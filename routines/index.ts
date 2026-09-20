// Routine registry — same shape as collectors; the runner schedules both.
import type { Db, RoutineCtx } from "./morning-brief/run.js";
import { run as morningBrief } from "./morning-brief/run.js";
import { run as weeklyReview } from "./weekly-review/run.js";
import { run as replyReview } from "./reply-review/run.js";
import { run as knowledgeFold } from "./knowledge-fold/run.js";
import { run as planTomorrow } from "./plan-tomorrow/run.js";

export interface RegisteredRoutine {
  name: string;
  run(db: Db, ctx?: RoutineCtx): Promise<number>;
}

export const routines: RegisteredRoutine[] = [
  { name: "morning-brief", run: morningBrief },
  { name: "weekly-review", run: weeklyReview },
  { name: "reply-review", run: replyReview },
  { name: "knowledge-fold", run: knowledgeFold },
  { name: "plan-tomorrow", run: planTomorrow },
];
export type { Db, RoutineCtx };
// What `plan-tomorrow` needs and no collector does — the named-query store and
// the vault bridge. Exported so the console's runner can widen the ctx it
// hands every component in ONE type, rather than each caller guessing.
export type { PlanCtx, PlanVault } from "./plan-tomorrow/run.js";
