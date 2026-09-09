// Routine registry — same shape as collectors; the runner schedules both.
import type { Db, RoutineCtx } from "./morning-brief/run.js";
import { run as morningBrief } from "./morning-brief/run.js";
import { run as weeklyReview } from "./weekly-review/run.js";
import { run as replyReview } from "./reply-review/run.js";
import { run as knowledgeFold } from "./knowledge-fold/run.js";

export interface RegisteredRoutine {
  name: string;
  run(db: Db, ctx?: RoutineCtx): Promise<number>;
}

export const routines: RegisteredRoutine[] = [
  { name: "morning-brief", run: morningBrief },
  { name: "weekly-review", run: weeklyReview },
  { name: "reply-review", run: replyReview },
  { name: "knowledge-fold", run: knowledgeFold },
];
export type { Db, RoutineCtx };
