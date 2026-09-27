// A tiny in-memory model of the two tables the runner touches (`runs`,
// `outbound_messages`) — enough of Postgres to answer the runner's queries
// and nothing more, so the scheduler is tested as behaviour rather than as
// SQL strings. The real-db suite (scheduler.integration.test.ts) proves the
// SQL itself. Shared by runner.test.ts and scheduler.test.ts.

export interface RunRow {
  id: number;
  component: string;
  kind: string;
  tool: string | null;
  ts: Date;
  ok: boolean | null;
  error: string | null;
  meta: Record<string, unknown>;
}

export class FakeRuns {
  runs: RunRow[] = [];
  outbound: { ts: Date; kind: string; text: string }[] = [];
  /**
   * How far Postgres's clock is behind this process's, in ms — a Docker VM
   * that drifted while the Mac slept. A row's `ts` is `now - skewMs`.
   */
  skewMs = 0;
  constructor(public now: Date) {}

  seed(rows: { component: string; kind: string; tool?: string; minutesAgo: number; ok: boolean | null; error?: string; meta?: Record<string, unknown> }[]): this {
    for (const r of rows) {
      this.runs.push({
        id: this.runs.length + 1,
        component: r.component,
        kind: r.kind,
        tool: r.tool ?? null,
        ts: new Date(this.now.getTime() - r.minutesAgo * 60_000),
        ok: r.ok,
        error: r.error ?? null,
        meta: r.meta ?? {},
      });
    }
    return this;
  }

  rowsFor(component: string, tool?: string): RunRow[] {
    return this.runs.filter((r) => r.component === component && (tool === undefined || r.tool === tool));
  }

  async query(text: string, values: unknown[] = []): Promise<{ rows: any[] }> {
    if (text.includes("max(ts) FILTER")) {
      const [component, runKind, runnerKind, skipTool, preTool, heldTool] = values as string[];
      const mine = this.runs.filter((r) => r.component === component);
      const max = (xs: number[]) => (xs.length === 0 ? null : new Date(Math.max(...xs)));
      const tsOf = (pick: (r: RunRow) => boolean) => max(mine.filter(pick).map((r) => r.ts.getTime()));
      const slots = mine
        .filter((r) => r.kind === runKind && typeof r.meta.scheduled_for === "string" && /^\d{4}-\d{2}-\d{2}T/.test(r.meta.scheduled_for))
        .map((r) => Date.parse(String(r.meta.scheduled_for)));
      return {
        rows: [
          {
            last_run: tsOf((r) => r.kind === runKind),
            last_slot: max(slots),
            last_refused: tsOf((r) => r.kind === runKind && r.meta.schedule_refused !== undefined && r.meta.schedule_refused !== null),
            last_skip: tsOf((r) => r.kind === runnerKind && r.tool === skipTool),
            last_preflight: tsOf((r) => r.kind === runnerKind && r.tool === preTool),
            last_held: tsOf((r) => r.kind === runnerKind && r.tool === heldTool),
          },
        ],
      };
    }
    if (text.includes("last_ok")) {
      const kinds = (values[0] as string[]) ?? [];
      const keys = [...new Set(this.runs.filter((r) => kinds.includes(r.kind)).map((r) => `${r.component} ${r.kind}`))];
      return {
        rows: keys.flatMap((key) => {
          const [component, kind] = key.split(" ") as [string, string];
          const mine = this.runs.filter((r) => r.component === component && r.kind === kind).sort((a, b) => a.ts.getTime() - b.ts.getTime());
          const lastOk = [...mine].reverse().find((r) => r.ok === true);
          const open = mine.filter((r) => r.ok === false && (!lastOk || r.ts > lastOk.ts));
          if (open.length === 0) return [];
          return [{ component, kind, n: String(open.length), since: open[0]!.ts, last_error: open[open.length - 1]!.error }];
        }),
      };
    }
    if (text.startsWith("INSERT INTO runs")) {
      const [component, kind, , tool, , , meta] = values as (string | null)[];
      const row: RunRow = {
        id: this.runs.length + 1,
        component: component!,
        kind: kind!,
        tool: tool ?? null,
        ts: new Date(this.now.getTime() - this.skewMs),
        ok: null,
        error: null,
        meta: meta ? JSON.parse(meta) : {},
      };
      this.runs.push(row);
      return { rows: [{ id: row.id }] };
    }
    if (text.startsWith("UPDATE runs")) {
      const [id, ok, error, , , , meta] = values as [number, boolean, string | null, unknown, unknown, unknown, string | undefined];
      const row = this.runs.find((r) => r.id === id)!;
      row.ok = ok;
      row.error = error;
      if (meta) row.meta = { ...row.meta, ...JSON.parse(meta) };
      return { rows: [] };
    }
    if (text.includes("FROM outbound_messages")) {
      const tag = values[0] as string;
      const hits = this.outbound.filter((o) => o.kind === "alert" && o.text.includes(tag));
      return { rows: [{ ts: hits.length === 0 ? null : new Date(Math.max(...hits.map((o) => o.ts.getTime()))) }] };
    }
    if (text.startsWith("INSERT INTO outbound_messages")) {
      this.outbound.push({ ts: this.now, kind: "alert", text: String(values[0]) });
      return { rows: [] };
    }
    throw new Error(`unexpected query: ${text}`);
  }
}
