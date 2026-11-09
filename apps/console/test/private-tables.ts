// A connection of a test's own, in which some tables are empty and nobody
// else's rows can reach it.
//
// Scope-by-marker (docs/ops/testing.md) is for a suite that READS its own rows
// back by a key. A few subjects cannot: a query that counts the whole table
// (`pending_count`, `task_ageing` — the point of both is that they take no
// filter), and the Needs You notifier, which pushes whatever the whole queue
// grows by. Beside a parallel file that raises proposals or writes tasks, the
// answer to such a subject moves under it — and the old cure, `DELETE FROM
// vault_tasks`, emptied the table out from under the files reading their own
// `mt-…` rows (X-25).
//
// So the test takes a connection and shadows the tables with TEMP tables of
// the same shape (`LIKE public.<t> INCLUDING ALL`: columns, defaults, checks,
// indexes; no foreign keys, no triggers, so nothing here notifies anyone). An
// unqualified `proposals` on this connection then names the shadow, the
// subject runs on this connection, and the real table is never read or
// written. Nothing is deleted from a shared table, and nothing needs cleaning
// but the shadows, which `done()` drops before the connection goes back.
import type pg from "pg";

export interface PrivateTables extends pg.PoolClient {
  /** Drop the shadows and give the connection back to the pool. */
  done(): Promise<void>;
}

export async function privateTables(pool: pg.Pool, tables: readonly string[]): Promise<PrivateTables> {
  for (const t of tables) if (!/^[a-z][a-z0-9_]*$/.test(t)) throw new Error(`privateTables: ${JSON.stringify(t)} is not a table name`);
  const client = await pool.connect();
  try {
    for (const t of tables) await client.query(`CREATE TEMP TABLE ${t} (LIKE public.${t} INCLUDING ALL)`);
  } catch (e) {
    client.release(true); // a half-shadowed connection must not go back
    throw e;
  }
  const out = client as PrivateTables;
  out.done = async () => {
    try {
      for (const t of tables) await client.query(`DROP TABLE pg_temp.${t}`);
      client.release();
    } catch {
      client.release(true); // drop the connection, and the shadows with it
    }
  };
  return out;
}
