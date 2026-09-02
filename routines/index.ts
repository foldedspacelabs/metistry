// Routine registry — same shape as collectors; the runner schedules both.
import type { Db, RoutineCtx } from "./morning-brief/run.js";
import { run as morningBrief } from "./morning-brief/run.js";

export interface RegisteredRoutine {
  name: string;
  run(db: Db, ctx?: RoutineCtx): Promise<number>;
}

export const routines: RegisteredRoutine[] = [{ name: "morning-brief", run: morningBrief }];
export type { Db, RoutineCtx };
