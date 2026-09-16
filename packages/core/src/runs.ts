// runs emission (CRIT-2: core owns it) — two-phase per CRIT-8: insert at
// start, update at completion, so hung/crashed calls are visible in flight.
// Takes any executor with pg's query shape; no pg dependency in core.

export interface RunExecutor {
  query(text: string, values: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

export interface RunStart {
  component: string;
  kind: string; // bridge_call | collector_run | turn | escalation | outbound | doctor | auth | capture | message
  session_id?: string;
  tool?: string;
  /**
   * The provider that serves the call — `compute.yaml`'s provider NAME, the
   * first segment of a `<provider>/<id>` reference (C12). Known before the
   * call, so it lands on the in-flight row: a call that hangs is still
   * attributable to whoever is not answering.
   */
  provider?: string;
  /** The model id as the provider knows it — everything after the first `/` of the reference. */
  model?: string;
  meta?: Record<string, unknown>;
}

export interface RunFinish {
  ok: boolean;
  error?: string;
  tokens_in?: number;
  tokens_out?: number;
  /** Prompt tokens the provider served from its cache — a column, not `meta`, because cache hit rate is a cost number. */
  cache_read_tokens?: number;
  cache_write_tokens?: number;
  cost_usd?: number;
  meta?: Record<string, unknown>;
}

/** Insert the in-flight row; returns the run id to finish with. */
export async function startRun(db: RunExecutor, r: RunStart): Promise<number> {
  const { rows } = await db.query(
    `INSERT INTO runs (component, kind, session_id, tool, provider, model, meta, started_at, ok)
     VALUES ($1, $2, $3, $4, $5, $6, $7, now(), NULL) RETURNING id`,
    [r.component, r.kind, r.session_id ?? null, r.tool ?? null, r.provider ?? null, r.model ?? null, JSON.stringify(r.meta ?? {})],
  );
  return Number(rows[0]?.id);
}

export async function finishRun(db: RunExecutor, id: number, f: RunFinish): Promise<void> {
  await db.query(
    `UPDATE runs SET finished_at = now(), ok = $2, error = $3,
       tokens_in = $4, tokens_out = $5, cost_usd = $6,
       cache_read_tokens = $8, cache_write_tokens = $9,
       duration_ms = (EXTRACT(EPOCH FROM (now() - started_at)) * 1000)::int,
       meta = meta || $7::jsonb
     WHERE id = $1`,
    [
      id,
      f.ok,
      f.error ?? null,
      f.tokens_in ?? null,
      f.tokens_out ?? null,
      f.cost_usd ?? null,
      JSON.stringify(f.meta ?? {}),
      f.cache_read_tokens ?? null,
      f.cache_write_tokens ?? null,
    ],
  );
}

/** Wrap an operation in a two-phase run; rethrows after recording failure. */
export async function withRun<T>(db: RunExecutor, start: RunStart, fn: () => Promise<T>): Promise<T> {
  const id = await startRun(db, start);
  try {
    const out = await fn();
    await finishRun(db, id, { ok: true });
    return out;
  } catch (err) {
    await finishRun(db, id, { ok: false, error: err instanceof Error ? err.message : String(err) });
    throw err;
  }
}
