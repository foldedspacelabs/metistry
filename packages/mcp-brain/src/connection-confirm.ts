// A connection call's confirm token, held server-side (plan §2.6; T4-9).
//
// Preview-then-confirm binds every bridge on a tool that changes something
// (CLAUDE.md, Packages). A connection call that changes things — or any call
// set to Ask First — first comes back as a PREVIEW: nothing is dialled, and a
// confirm token is minted. What the server keeps of it lives on the preview's
// own `runs` row (`kind = connection_call`, `meta.confirm`), so it survives a
// restart and needs no table of its own (§2.9: `runs.kind` values need no
// migration):
//
//   { digest:     SHA-256 of the token — the token itself is never stored,
//     payload:    SHA-256 of the canonical {principal, connection, tool, args}
//                 it previewed (core's connectionCallDigest),
//     mode:       "on"  — the caller confirms it (a Changes tool set to Allow)
//                 "ask" — only the owner's Approve redeems it (Ask First),
//     expires_at: when an "on" token stops redeeming,
//     proposal_id: the one Needs You row an "ask" token belongs to,
//     redeemed_at: set once, atomically, by the redemption that spends it }
//
// Two properties are the point, and both are SQL rather than a sentence:
//
//   * **Single use.** A redemption is one `UPDATE … WHERE NOT (confirm ?
//     'redeemed_at') RETURNING`: two presentations of one token race on a row
//     lock, and the loser matches nothing. A replayed token is refused.
//   * **The server's payload, never the caller's.** The redemption returns
//     the payload digest the preview recorded; the caller compares it with
//     the payload it is about to run and refuses on any difference. A token
//     previewed for one call can never run another — whoever presents it.
//
// Nothing here dials, and nothing here reads a secret. `runs_export` and
// `run_detail` serve `runs.meta` to a principal with `queries`, so what is
// kept there is digests and timestamps: a digest is not a token.

import type { Db } from "./types.js";

/** Who confirms: the caller (a Changes tool at Allow), or the owner's Approve (Ask First). */
export type ConfirmMode = "on" | "ask";

export interface ConfirmRecord {
  digest: string;
  payload: string;
  mode: ConfirmMode;
  expires_at?: string | undefined;
  proposal_id?: number | undefined;
}

/** Write the record onto the preview's own `runs` row. Done inside the call, before its answer leaves, so a token is redeemable the moment anyone holds it. */
export async function recordConfirm(db: Db, runId: number, record: ConfirmRecord): Promise<void> {
  await db.query(`UPDATE runs SET meta = meta || jsonb_build_object('confirm', $2::jsonb) WHERE id = $1`, [runId, JSON.stringify(record)]);
}

/** Why a redemption matched nothing — for the audit row; the caller hears one sentence whatever it was. */
export type RedeemMiss = "spent" | "expired" | "ask_only" | "unknown";

export type Redeemed = { ok: true; runId: number; payload: string } | { ok: false; miss: RedeemMiss };

/**
 * Spend a caller-confirmed ("on") token: this principal's, unspent, unexpired.
 * `windowS` bounds the scan to the rows the token could be on (the confirm
 * TTL), on `runs (component, ts)`'s index.
 */
export async function redeemCallerToken(db: Db, principal: string, digest: string, windowS: number): Promise<Redeemed> {
  const { rows } = await db.query(
    `UPDATE runs SET meta = jsonb_set(meta, '{confirm,redeemed_at}', to_jsonb(now()))
      WHERE kind = 'connection_call' AND component = $1
        AND ts > now() - make_interval(secs => $3)
        AND meta -> 'confirm' ->> 'digest' = $2
        AND meta -> 'confirm' ->> 'mode' = 'on'
        AND NOT (meta -> 'confirm' ? 'redeemed_at')
        AND (meta -> 'confirm' ->> 'expires_at')::timestamptz > now()
      RETURNING id, meta -> 'confirm' ->> 'payload' AS payload`,
    [principal, digest, windowS],
  );
  const hit = rows[0];
  if (hit) return { ok: true, runId: Number(hit.id), payload: String(hit.payload) };
  return { ok: false, miss: await whyMissed(db, principal, digest, windowS) };
}

/**
 * Spend an owner-confirmed ("ask") token: the one the proxy minted for THIS
 * proposal, on the preview row it names, for the agent that asked. A token
 * copied into another row matches nothing — it belongs to one request.
 */
export async function redeemApprovalToken(db: Db, q: { previewRun: number; principal: string; digest: string; proposalId: number }): Promise<Redeemed> {
  const { rows } = await db.query(
    `UPDATE runs SET meta = jsonb_set(meta, '{confirm,redeemed_at}', to_jsonb(now()))
      WHERE id = $1 AND kind = 'connection_call' AND component = $2
        AND meta -> 'confirm' ->> 'digest' = $3
        AND meta -> 'confirm' ->> 'mode' = 'ask'
        AND meta -> 'confirm' ->> 'proposal_id' = $4::text
        AND NOT (meta -> 'confirm' ? 'redeemed_at')
      RETURNING id, meta -> 'confirm' ->> 'payload' AS payload`,
    [q.previewRun, q.principal, q.digest, String(q.proposalId)],
  );
  const hit = rows[0];
  if (hit) return { ok: true, runId: Number(hit.id), payload: String(hit.payload) };
  const { rows: seen } = await db.query(
    `SELECT (meta -> 'confirm' ? 'redeemed_at') AS spent FROM runs
      WHERE id = $1 AND kind = 'connection_call' AND component = $2 AND meta -> 'confirm' ->> 'digest' = $3 AND meta -> 'confirm' ->> 'proposal_id' = $4::text`,
    [q.previewRun, q.principal, q.digest, String(q.proposalId)],
  );
  return { ok: false, miss: seen[0]?.spent === true ? "spent" : "unknown" };
}

/**
 * Give a spent "ask" token back — ONLY when the call it approved was refused
 * before anything was dialled (a `ConnectionRefused`: the tool moved to
 * Never, a grant is missing). Nothing reached the upstream, so the owner may
 * fix it and Approve again. A call that was dialled keeps its token spent:
 * an upstream that timed out may still have acted, and a second Approve must
 * not repeat it.
 */
export async function releaseApprovalToken(db: Db, runId: number): Promise<void> {
  await db.query(`UPDATE runs SET meta = meta #- '{confirm,redeemed_at}' WHERE id = $1 AND kind = 'connection_call'`, [runId]);
}

async function whyMissed(db: Db, principal: string, digest: string, windowS: number): Promise<RedeemMiss> {
  const { rows } = await db.query(
    `SELECT meta -> 'confirm' ->> 'mode' AS mode, (meta -> 'confirm' ? 'redeemed_at') AS spent,
            coalesce((meta -> 'confirm' ->> 'expires_at')::timestamptz <= now(), false) AS expired
       FROM runs
      WHERE kind = 'connection_call' AND component = $1 AND meta -> 'confirm' ->> 'digest' = $2
        AND ts > now() - make_interval(secs => $3) - interval '1 day'
      ORDER BY id DESC LIMIT 1`,
    [principal, digest, windowS],
  );
  const r = rows[0];
  if (!r) return "unknown";
  if (r.mode === "ask") return "ask_only";
  if (r.spent === true) return "spent";
  if (r.expired === true) return "expired";
  return "unknown";
}

/** Calls this principal made through the proxy to one connection in the last hour — what a rate limit counts (plan §3.3 T4-9: "rate limits from `runs`"). */
export async function recentConnectionCalls(db: Db, principal: string, connection: string): Promise<{ dialled: number; asked: number }> {
  const { rows } = await db.query(
    `SELECT count(*) FILTER (WHERE meta ->> 'dialled' = 'true')::int AS dialled,
            count(*) FILTER (WHERE meta ->> 'mode' = 'ask' AND ok IS TRUE)::int AS asked
       FROM runs
      WHERE kind = 'connection_call' AND component = $1 AND meta ->> 'connection' = $2 AND ts > now() - interval '1 hour'`,
    [principal, connection],
  );
  const r = rows[0];
  return { dialled: Number(r?.dialled ?? 0), asked: Number(r?.asked ?? 0) };
}
