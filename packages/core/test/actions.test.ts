// The closed enum and the autonomy table (docs/ops/actions.md). Misuse first:
// what these functions REFUSE is the whole of their value, because everything
// downstream — the bridge's tool, the console's executor, the CLI — takes
// their word for it.
import { describe, expect, it } from "vitest";
import {
  ACTION_DEFAULTS,
  ACTION_KINDS,
  ACTION_MODES,
  AUTONOMY_LEVELS,
  admitsAnyAction,
  actionWorkId,
  autonomyWidenings,
  describeAction,
  effectiveActions,
  effectiveActionsDetailed,
  parseAction,
  type Action,
  type ActionKind,
} from "../src/index.js";

const dispatch = { kind: "dispatch", args: { work_id: 12, target: "devin", brief: "look at the flake" } };

describe("the enum is closed", () => {
  it("admits exactly four kinds and nothing else", () => {
    expect([...ACTION_KINDS]).toEqual(["dispatch", "task_update", "comment", "capture"]);
    for (const kind of ["send_email", "message", "git_push", "shell", "grant", "autonomy", "", "DISPATCH"]) {
      const r = parseAction({ kind, args: {} });
      expect(r.ok, kind).toBe(false);
      if (!r.ok) expect(r.error).toContain("kind must be one of");
    }
    // a kind is never inferred from the args either
    expect(parseAction({ args: { work_id: 1 } }).ok).toBe(false);
    expect(parseAction(null).ok).toBe(false);
    expect(parseAction("dispatch").ok).toBe(false);
  });

  it("refuses an argument nobody named, and names the field that failed", () => {
    // a field that would travel into a service call unread
    const extra = parseAction({ kind: "capture", args: { note: "hi", principal: "user" } });
    expect(extra.ok).toBe(false);
    if (!extra.ok) expect(extra.error).toMatch(/principal|unrecognized/i);
    // wrong types, missing requireds, empty strings — each names its path
    for (const bad of [
      { kind: "dispatch", args: { work_id: "12", target: "t", brief: "b" } },
      { kind: "dispatch", args: { work_id: 0, target: "t", brief: "b" } },
      { kind: "dispatch", args: { work_id: 12, target: "", brief: "b" } },
      { kind: "dispatch", args: { work_id: 12, target: "t" } },
      { kind: "task_update", args: { work_id: 12, patch: {} } },
      { kind: "task_update", args: { work_id: 12, patch: { status: "done" } } },
      { kind: "task_update", args: { work_id: 12, patch: { claimed_by: "x" } } },
      { kind: "capture", args: {} },
      { kind: "capture", args: { note: "   " } },
    ]) {
      expect(parseAction(bad).ok, JSON.stringify(bad)).toBe(false);
    }
    expect(parseAction({ kind: "task_update", args: { work_id: 12, patch: { status: "blocked" } } }).ok).toBe(true);
    expect(parseAction({ kind: "task_update", args: { work_id: 12, patch: { owner: null } } }).ok).toBe(true);
  });

  it("a comment names exactly one anchor, and an artifact comment names its version", () => {
    expect(parseAction({ kind: "comment", args: { work_id: 4, body: "hi" } }).ok).toBe(true);
    expect(parseAction({ kind: "comment", args: { artifact_id: "art_1", version_id: "ver_1", body: "hi" } }).ok).toBe(true);
    // neither, both, or an artifact with no version: all refused
    for (const bad of [
      { body: "hi" },
      { work_id: 4, artifact_id: "art_1", version_id: "ver_1", body: "hi" },
      { artifact_id: "art_1", body: "hi" },
      { work_id: 4, version_id: "ver_1", body: "hi" },
      { work_id: 4, body: "" },
    ]) {
      expect(parseAction({ kind: "comment", args: bad }).ok, JSON.stringify(bad)).toBe(false);
    }
  });

  it("names the work row an action is about, so a proposal can link it — and invents none where there is none", () => {
    expect(actionWorkId(parseActionOrThrow(dispatch))).toBe(12);
    expect(actionWorkId(parseActionOrThrow({ kind: "task_update", args: { work_id: 7, patch: { title: "x" } } }))).toBe(7);
    expect(actionWorkId(parseActionOrThrow({ kind: "comment", args: { work_id: 9, body: "b" } }))).toBe(9);
    expect(actionWorkId(parseActionOrThrow({ kind: "comment", args: { artifact_id: "art_1", version_id: "ver_1", body: "b" } }))).toBeUndefined();
    expect(actionWorkId(parseActionOrThrow({ kind: "capture", args: { note: "n" } }))).toBeUndefined();
  });

  it("describes itself deterministically — the queue title is not prose", () => {
    expect(describeAction(parseActionOrThrow(dispatch))).toBe('dispatch task #12 to target "devin"');
    expect(describeAction(parseActionOrThrow({ kind: "task_update", args: { work_id: 7, patch: { status: "blocked", owner: null } } }))).toBe("update task #7: status → blocked, owner → none");
    expect(describeAction(parseActionOrThrow({ kind: "capture", args: { note: "n", filename: "a.md" } }))).toBe("capture a note as a.md");
  });
});

describe("the level is a ceiling", () => {
  it("an absent level is observe: nothing, so the axis is opt-in", () => {
    for (const record of [undefined, null, {}, { max_open_bundles: 2 } as never]) {
      const t = effectiveActions(record as never);
      expect(ACTION_KINDS.every((k) => t[k] === "deny"), JSON.stringify(record)).toBe(true);
      expect(admitsAnyAction(record as never)).toBe(false);
    }
  });

  it("ships the product defaults, dispatch human at every level", () => {
    expect(effectiveActions({ level: "observe" })).toEqual(ACTION_DEFAULTS.observe);
    expect(effectiveActions({ level: "propose" })).toEqual({ dispatch: "propose", task_update: "propose", comment: "propose", capture: "propose" });
    expect(effectiveActions({ level: "act_within_scope" })).toEqual({ dispatch: "propose", task_update: "allow", comment: "allow", capture: "allow" });
  });

  it("clamps a per-kind entry to the level — an `allow` below act_within_scope never becomes one", () => {
    // this is what makes "it only ever runs on its own at the top level"
    // arithmetic instead of a rule a second call site could forget
    expect(effectiveActions({ level: "propose", actions: { comment: "allow" } }).comment).toBe("propose");
    expect(effectiveActions({ level: "observe", actions: { comment: "allow", capture: "propose" } })).toEqual(ACTION_DEFAULTS.observe);
    // and narrowing works in every direction it should
    expect(effectiveActions({ level: "act_within_scope", actions: { comment: "deny" } }).comment).toBe("deny");
    expect(effectiveActions({ level: "act_within_scope", actions: { dispatch: "allow" } }).dispatch).toBe("allow");
    expect(admitsAnyAction({ level: "observe", actions: { comment: "allow" } })).toBe(false);
    expect(admitsAnyAction({ level: "propose" })).toBe(true);
  });

  it("modes and levels are ordered least → most, because the ranks are the index", () => {
    expect([...ACTION_MODES]).toEqual(["deny", "propose", "allow"]);
    expect([...AUTONOMY_LEVELS]).toEqual(["observe", "propose", "act_within_scope"]);
  });
});

describe("effectiveActionsDetailed — the same table, with why (C46/C47)", () => {
  it("is defaulted when the record names nothing: no `asked`, ceiling and mode line up with the level", () => {
    const t = effectiveActionsDetailed({ level: "propose" });
    for (const kind of ACTION_KINDS) {
      expect(t[kind], kind).toEqual({ mode: "propose", source: "defaulted", ceiling: "propose" });
      expect(t[kind].asked, kind).toBeUndefined();
    }
  });

  it("is set when the owner's own entry survives the ceiling unchanged", () => {
    const t = effectiveActionsDetailed({ level: "act_within_scope", actions: { comment: "propose" } });
    expect(t.comment).toEqual({ mode: "propose", source: "set", ceiling: "allow", asked: "propose" });
    // a sibling kind with no entry of its own is still defaulted
    expect(t.capture).toEqual({ mode: "allow", source: "defaulted", ceiling: "allow" });
  });

  it("is clamped when the owner's own entry is above the ceiling — the only source where `asked` disagrees with `mode`", () => {
    const t = effectiveActionsDetailed({ level: "propose", actions: { comment: "allow" } });
    expect(t.comment).toEqual({ mode: "propose", source: "clamped", ceiling: "propose", asked: "allow" });
    // observe's ceiling is deny, so any per-kind entry above deny is clamped
    const observed = effectiveActionsDetailed({ level: "observe", actions: { capture: "propose" } });
    expect(observed.capture).toEqual({ mode: "deny", source: "clamped", ceiling: "deny", asked: "propose" });
  });

  it("`effectiveActions` is exactly the `.mode` projection of this — the two cannot drift apart", () => {
    for (const record of [
      undefined,
      null,
      {},
      { level: "propose" as const },
      { level: "act_within_scope" as const, actions: { dispatch: "allow" as const, comment: "deny" as const } },
      { level: "observe" as const, actions: { comment: "allow" as const, capture: "propose" as const } },
    ]) {
      const detailed = effectiveActionsDetailed(record);
      const projected = {} as Record<ActionKind, string>;
      for (const kind of ACTION_KINDS) projected[kind] = detailed[kind].mode;
      expect(effectiveActions(record), JSON.stringify(record)).toEqual(projected);
    }
  });
});

describe("autonomyWidenings — what the owner's hand is required for", () => {
  it("sees a level raise and every kind whose EFFECTIVE mode rises", () => {
    expect(autonomyWidenings({}, { level: "propose" })).toEqual([
      "level observe → propose",
      "actions.dispatch deny → propose",
      "actions.task_update deny → propose",
      "actions.comment deny → propose",
      "actions.capture deny → propose",
    ]);
    expect(autonomyWidenings({ level: "propose" }, { level: "act_within_scope", actions: { dispatch: "allow" } })).toEqual([
      "level propose → act_within_scope",
      "actions.dispatch propose → allow",
      "actions.task_update propose → allow",
      "actions.comment propose → allow",
      "actions.capture propose → allow",
    ]);
  });

  it("is empty for a narrowing, a no-op, or a raise the ceiling swallows", () => {
    expect(autonomyWidenings({ level: "act_within_scope" }, { level: "propose" })).toEqual([]);
    expect(autonomyWidenings({ level: "propose" }, { level: "propose" })).toEqual([]);
    expect(autonomyWidenings({ level: "act_within_scope" }, { level: "act_within_scope", actions: { comment: "deny" } })).toEqual([]);
    // an entry raised under a ceiling that refuses it changes nothing, so it
    // is not a widening — the test is on the EFFECTIVE table, not the record
    expect(autonomyWidenings({ level: "propose" }, { level: "propose", actions: { comment: "allow" } })).toEqual([]);
    // the §4.21 keys are not this function's business either way
    expect(autonomyWidenings({ max_open_bundles: 1 } as never, { max_open_bundles: 99 } as never)).toEqual([]);
  });
});

function parseActionOrThrow(input: unknown): Action {
  const r = parseAction(input);
  if (!r.ok) throw new Error(r.error);
  return r.action;
}

// A tiny guard that the four kinds and the four defaults never drift apart.
describe("the tables cover the enum", () => {
  it("every level has a default for every kind", () => {
    for (const level of AUTONOMY_LEVELS) {
      for (const kind of ACTION_KINDS) expect(ACTION_DEFAULTS[level][kind as ActionKind], `${level}.${kind}`).toBeDefined();
    }
  });
});
