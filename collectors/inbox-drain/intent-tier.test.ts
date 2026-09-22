// The intent tier at the capture door — the rules that consume the fact, and
// the whole drain with a fake `/v1` for each server shape (PoC-20 phase 1).
//
// What these pin down, in the order the research cares about:
//   * the RULES decide, from the table here and the threshold in rules.yaml;
//   * a verdict below the owner's threshold changes nothing, and is still
//     audited (§4.3 property 1: the discarded verdicts are the interesting
//     rows);
//   * every way the tier can be absent leaves the drain BYTE-IDENTICAL to the
//     build before it existed (§3.2 P3, as a test not a promise);
//   * the money rule does not degrade.
import { describe, expect, it } from "vitest";
import { INTENT_NAMES, INTENT_UNSURE, codesFor, intentRulesSchema, parseCompute, type Compute, type Intent } from "@foldedspacelabs/metistry-core";
import { INBOX_KIND_FOR_INTENT, inboxKindForIntent, intentDecision, intentPlacement } from "./intent-tier.js";
import { run, type CollectorCtx } from "./run.js";

const rules = (min = 0.8, by: Record<string, number> = {}) => intentRulesSchema.parse({ min_confidence: min, by_intent: by });

// ---- a fake database that also answers the audit's INSERT ---------------------

function fakeDb(inboxRows: any[]) {
  const proposals: any[] = [];
  const runs: any[] = [];
  const updates: any[] = [];
  let nextRunId = 1;
  return {
    proposals,
    runs,
    updates,
    async query(text: string, values?: unknown[]): Promise<{ rows: any[] }> {
      if (text.startsWith("SELECT id, path")) return { rows: inboxRows };
      if (text.startsWith("INSERT INTO proposals")) {
        proposals.push(JSON.parse(String(values![0])));
        return { rows: [] };
      }
      if (text.includes("INSERT INTO runs")) {
        const id = nextRunId++;
        runs.push({ id, component: values![0], kind: values![1], tool: values![3], provider: values![4], model: values![5], meta: JSON.parse(String(values![6])) });
        return { rows: [{ id }] };
      }
      if (text.startsWith("UPDATE runs")) {
        const row = runs.find((r) => r.id === Number(values![0]));
        if (row) {
          row.ok = values![1];
          row.error = values![2];
        }
        return { rows: [] };
      }
      if (text.startsWith("UPDATE inbox")) {
        updates.push(JSON.parse(String(values![1])));
        return { rows: [] };
      }
      return { rows: [] };
    },
  };
}

const compute = (extra = "", base = "http://127.0.0.1:11434/v1"): Compute =>
  parseCompute(`
providers:
  applefm:
    kind: openai-compatible
    base_url: http://127.0.0.1:7810/v1
    locality: on_machine
  ollama:
    kind: openai-compatible
    base_url: ${base}
    locality: on_machine
assignments:
  default: { model: applefm/foundation-model }
${extra}`);

const withIntent = (base?: string) => compute("  intent: { model: ollama/gemma4:e4b-it-qat }\n", base);

/**
 * One `/v1` that answers BOTH shapes: an answer-token score for the intent
 * tier's request (the one carrying `logprobs`), and the JSON-schema
 * classification for the Apple FM tier's.
 */
function fakeV1(opts: { intent?: Intent; peak?: number; logprobs?: "present" | "null"; category?: string; status?: number }) {
  const sent: Array<{ url: string; body: any }> = [];
  const fn = (async (url: string, init: any) => {
    const body = JSON.parse(init.body);
    sent.push({ url: String(url), body });
    if (opts.status && opts.status !== 200) return new Response(JSON.stringify({ error: "nope" }), { status: opts.status, headers: { "content-type": "application/json" } });
    if (body.logprobs === true) {
      if (opts.logprobs === "null") {
        return new Response(JSON.stringify({ choices: [{ message: { content: "" }, logprobs: null }] }), { status: 200, headers: { "content-type": "application/json" } });
      }
      // A distribution whose RENORMALISED peak is exactly `peak`: the rest is
      // spread over four other codes, each of which stays below it.
      const codes = codesFor(INTENT_NAMES.length);
      const want = opts.intent ?? "note_capture";
      const peak = opts.peak ?? 0.99;
      const i = INTENT_NAMES.indexOf(want);
      const others = [1, 2, 3, 4].map((d) => (i + d) % INTENT_NAMES.length);
      const top = [
        { token: codes[i], logprob: Math.log(peak) },
        ...others.map((o) => ({ token: codes[o], logprob: Math.log((1 - peak) / others.length) })),
      ];
      return new Response(
        JSON.stringify({ choices: [{ message: { content: codes[i] }, logprobs: { content: [{ top_logprobs: top }] } }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(
      JSON.stringify({ choices: [{ message: { content: JSON.stringify({ category: opts.category ?? "idea", has_action: false, action: "" }) } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;
  return { fn, sent };
}

const ctxFor = (cfg: Compute, fetchFn: typeof fetch, extra: Partial<CollectorCtx> = {}): CollectorCtx => ({
  compute: () => cfg,
  secretEnv: {},
  usesModel: "applefm/foundation-model",
  fetchFn,
  ...extra,
});

const ambiguous = { id: 1, path: "1-note.md", mime: "text/markdown", note: "thoughts on the migration approach", source: "note" };
const todoRow = { id: 2, path: "2-note.md", mime: "text/markdown", note: "buy milk", source: "note" };

// ---- the rules, on their own --------------------------------------------------

describe("the decision table is rule code, total over the enum", () => {
  it("names a kind for every intent or explicitly nothing", () => {
    expect(Object.keys(INBOX_KIND_FOR_INTENT).sort()).toEqual([...INTENT_NAMES].sort());
    for (const [intent, kind] of Object.entries(INBOX_KIND_FOR_INTENT)) {
      expect(kind === null || ["todo", "event", "idea", "link", "note"].includes(kind)).toBe(true);
      expect(intent).not.toBe(undefined);
    }
  });

  it("maps `unsure` to nothing, whatever the confidence", () => {
    expect(inboxKindForIntent(INTENT_UNSURE)).toBeNull();
    expect(intentDecision(rules(0.5), { intent: INTENT_UNSURE, confidence: 1 }).applied).toBe(false);
  });

  it("discards an intent this build does not know, rather than inventing a kind", () => {
    expect(inboxKindForIntent("book_a_flight")).toBeNull();
  });

  it("applies only at or above THE OWNER'S threshold, per intent", () => {
    const r = rules(0.8, { task_create: 0.95 });
    expect(intentDecision(r, { intent: "task_create", confidence: 0.9 }).applied).toBe(false);
    expect(intentDecision(r, { intent: "task_create", confidence: 0.96 }).applied).toBe(true);
    expect(intentDecision(r, { intent: "note_capture", confidence: 0.81 }).applied).toBe(true);
    expect(intentDecision(r, { intent: "note_capture", confidence: 0.79 }).why).toMatch(/under rules.yaml's threshold/);
  });

  it("produces no placement for an intent that says nothing about a capture's category", () => {
    const d = intentDecision(rules(0.1), { intent: "status_open_work", confidence: 1 });
    expect(d.applied).toBe(false);
    expect(d.why).toMatch(/says nothing about which inbox category/);
    expect(intentPlacement({ outcome: "guarded", reason: "x" })).toBeUndefined();
  });
});

// ---- the whole drain ----------------------------------------------------------

describe("the drain with the intent tier configured", () => {
  it("scores only the rules' fall-throughs, places the capture, and never calls the slower tier for it", async () => {
    const v1 = fakeV1({ intent: "note_capture", peak: 0.99 });
    const db = fakeDb([ambiguous, todoRow]);
    await run(db, ctxFor(withIntent(), v1.fn, { intentRules: rules(0.8) }));

    // one request, and it is the scored one — the JSON-schema tier was not needed
    expect(v1.sent).toHaveLength(1);
    expect(v1.sent[0]!.url).toBe("http://127.0.0.1:11434/v1/chat/completions");
    expect(v1.sent[0]!.body.model).toBe("gemma4:e4b-it-qat");
    expect(v1.sent[0]!.body.logprobs).toBe(true);
    expect(v1.sent[0]!.body.max_tokens).toBe(1); // ollama's measured shape
    expect(v1.sent[0]!.body.reasoning_effort).toBe("none");

    const p1 = db.proposals.find((p) => p.inbox_id === 1);
    expect(p1.classification.kind).toBe("note");
    expect(p1.classification.reason).toBe("intent:note_capture");
    expect(p1.tier).toBe("ollama");
    expect(p1.intent).toMatchObject({ outcome: "scored", intent: "note_capture", applied: true, threshold: 0.8, kind: "note" });

    // the rule-placed row was never scored at all
    const p2 = db.proposals.find((p) => p.inbox_id === 2);
    expect(p2.tier).toBe("deterministic");
    expect(p2.intent).toBeUndefined();
  });

  it("falls THROUGH to the JSON-schema tier when the verdict is under the threshold, and records the discarded verdict", async () => {
    const v1 = fakeV1({ intent: "note_capture", peak: 0.4, category: "idea" });
    const db = fakeDb([ambiguous]);
    await run(db, ctxFor(withIntent(), v1.fn, { intentRules: rules(0.9) }));

    expect(v1.sent).toHaveLength(2); // scored first, then the schema tier
    expect(v1.sent[1]!.body.response_format.type).toBe("json_schema");
    const p = db.proposals[0];
    expect(p.classification.kind).toBe("idea"); // the schema tier's answer stands
    expect(p.tier).toBe("applefm");
    expect(p.intent).toMatchObject({ outcome: "scored", applied: false });
    expect(p.intent.why).toMatch(/under rules.yaml's threshold/);
  });

  it("puts EVERY verdict in a runs row, including the discarded ones (§4.3)", async () => {
    const v1 = fakeV1({ intent: "task_create", peak: 0.3 });
    const db = fakeDb([ambiguous]);
    await run(db, ctxFor(withIntent(), v1.fn, { intentRules: rules(0.9) }));
    expect(db.runs).toHaveLength(1);
    const row = db.runs[0];
    expect(row.component).toBe("inbox-drain");
    expect(row.kind).toBe("classify");
    expect(row.tool).toBe("intent");
    expect(row.provider).toBe("ollama");
    expect(row.model).toBe("gemma4:e4b-it-qat");
    expect(row.meta.inbox_id).toBe(1);
    expect(row.meta.applied).toBe(false);
    expect(row.meta.intent).toBe("task_create");
    expect(typeof row.meta.alpha).toBe("number");
    // `ok` is "the tier ran", not "the classifier was right" (§4.3 property 2)
    expect(row.ok).toBe(true);
  });

  it("marks a server that could not answer as NOT ok, so the watchdog can see it", async () => {
    const v1 = fakeV1({ logprobs: "null" });
    const db = fakeDb([ambiguous]);
    await run(db, ctxFor(withIntent(), v1.fn, { intentRules: rules(0.8) }));
    expect(db.runs[0].ok).toBe(false);
    expect(String(db.runs[0].error)).toMatch(/without answer-token logprobs/);
    expect(db.proposals[0].intent.outcome).toBe("unavailable");
    expect(db.proposals[0].tier).toBe("applefm"); // and the tier below still ran
  });

  it("uses LM Studio's measured request shape when the provider is LM Studio", async () => {
    const v1 = fakeV1({ intent: "note_capture" });
    const db = fakeDb([ambiguous]);
    await run(db, ctxFor(withIntent("http://127.0.0.1:1234/v1"), v1.fn, { intentRules: rules(0.8) }));
    expect(v1.sent[0]!.body.max_tokens).toBe(2); // at 1 it answers logprobs: null
    expect(v1.sent[0]!.body.top_logprobs).toBe(10); // past 10 it answers 400
  });

  it("does not ask a server that structurally has no logprobs — Apple FM is the JSON-schema arm", async () => {
    const v1 = fakeV1({ intent: "note_capture" });
    const db = fakeDb([ambiguous]);
    await run(db, ctxFor(withIntent("http://127.0.0.1:7810/v1"), v1.fn, { intentRules: rules(0.8) }));
    expect(v1.sent.every((s) => s.body.logprobs !== true)).toBe(true);
    expect(db.proposals[0].intent.outcome).toBe("unavailable");
    expect(String(db.proposals[0].intent.why)).toMatch(/no per-token logits|no answer-token logprobs/);
  });

  it("never sends a capture the deterministic guard refuses, and says why", async () => {
    const v1 = fakeV1({ intent: "note_capture" });
    const db = fakeDb([{ ...ambiguous, note: "សូមរំលឹកខ្ញុំឱ្យទូរស័ព្ទទៅទន្តបណ្ឌិតនៅថ្ងៃស្អែក" }]);
    await run(db, ctxFor(withIntent(), v1.fn, { intentRules: rules(0.8) }));
    expect(v1.sent.some((s) => s.body.logprobs === true)).toBe(false);
    expect(db.proposals[0].intent).toMatchObject({ outcome: "guarded" });
    expect(String(db.proposals[0].intent.reason)).toMatch(/out of script/);
    expect(db.runs[0].ok).toBe(true); // the tier worked: it declined to ask
  });
});

// ---- absent is byte-identical to today ----------------------------------------

describe("absent degrades to the build before this existed (§3.2 P3)", () => {
  // Each case pairs a ctx that CARRIES half the configuration with the same
  // ctx carrying none of it. Byte-identical proposals is the assertion, and
  // the reference is rebuilt per case so the comparison never crosses a
  // difference that is not the intent tier's.
  const cases: Array<[string, () => CollectorCtx, () => CollectorCtx]> = [
    [
      "compute.yaml assigns a model, rules.yaml names no threshold",
      () => ctxFor(withIntent(), fakeV1({ category: "idea" }).fn),
      () => ctxFor(compute(), fakeV1({ category: "idea" }).fn),
    ],
    [
      "rules.yaml names a threshold, compute.yaml assigns no model",
      () => ctxFor(compute(), fakeV1({ category: "idea" }).fn, { intentRules: rules(0.8) }),
      () => ctxFor(compute(), fakeV1({ category: "idea" }).fn),
    ],
    [
      "no compute config at all, threshold set",
      () => ({ usesModel: "applefm/foundation-model", fetchFn: fakeV1({ category: "idea" }).fn, intentRules: rules(0.8) }),
      () => ({ usesModel: "applefm/foundation-model", fetchFn: fakeV1({ category: "idea" }).fn }),
    ],
  ];

  it("produces the same proposal bytes as a build with no intent tier, on every absent shape", async () => {
    for (const [name, half, none] of cases) {
      const reference = fakeDb([ambiguous]);
      await run(reference, none());
      const db = fakeDb([ambiguous]);
      await run(db, half());
      expect(JSON.stringify(db.proposals), name).toBe(JSON.stringify(reference.proposals));
      expect(db.runs, name).toHaveLength(0); // no verdict, no audit row
    }
  });
});

describe("the money rule does not degrade for the intent tier either", () => {
  it("THROWS rather than scoring on a billable provider, and sends nothing", async () => {
    // compute.yaml refuses this at load, so the object is built by hand: this
    // is the half that survives an instance editing its own file after CI ran.
    const cfg = parseCompute(`
providers:
  applefm: { kind: openai-compatible, base_url: http://127.0.0.1:7810/v1, locality: on_machine }
  openrouter:
    kind: openai-compatible
    base_url: https://openrouter.ai/api/v1
    locality: off_machine
    data_policy: { allow: [Areas], deny_sources: [], max_brief_bytes: 1024 }
assignments:
  default: { model: applefm/foundation-model }
`) as Compute;
    (cfg.assignments as { intent?: { model: string } }).intent = { model: "openrouter/anthropic/claude-sonnet-5" };
    const v1 = fakeV1({ intent: "note_capture" });
    const db = fakeDb([ambiguous]);
    await expect(run(db, ctxFor(cfg, v1.fn, { intentRules: rules(0.8) }))).rejects.toThrow(/locality: off_machine/);
    expect(v1.sent).toHaveLength(0);
  });
});
