// **The refusal catalogue.** Every `(code, reason, message, needs)` a door can
// answer with, in one committed file, so changing what a refusal SAYS is a
// reviewable diff in `access.golden.json` rather than a string edited inside a
// handler where nobody looks (§4: "one golden file of every (reason, needs)
// pair" — one of the two artefacts the research document calls the most
// valuable of the exercise).
//
// It is also the proof of what each phase changed. Every entry carries
// `before`: the code and message that door returned at `origin/main`
// (c00034b), with the `file:line` it was read off. The test asserts `may()`
// produces it BYTE FOR BYTE — except where a `changed` sentence says an
// approved change happened and why. So a refusal's wording moving is never a
// silent diff: it is either a failure here, or a paragraph somebody wrote.
//
// Adding a door means adding a case here. That is deliberate: a refusal with
// no golden entry is a refusal nobody reviewed.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { REASONS, formatRefusal, may, type Decision, type Principal, type Refusal, type Resource, type Tell, type Verb } from "../src/index.js";

const GOLDEN = new URL("./access.golden.json", import.meta.url);

interface GoldenEntry {
  id: string;
  door: string;
  who: string;
  verb: Verb;
  resource: Resource;
  code: string;
  reason: string;
  /** `refuse` says the one sentence this reason says; `hide` is the door's own answer for "there is nothing here" (§3.1). */
  tell: Tell;
  message: string;
  needs?: unknown;
  expose?: unknown;
  /**
   * The ONE kind of entry whose `before` is not held byte for byte: a
   * deliberate, approved behaviour change, with the sentence saying why. P2
   * has exactly one (a crew's `uses`, §2.2), and the count is asserted below
   * so a second one cannot arrive quietly as a third field on an entry.
   */
  changed?: string;
  /** What this door answered before P1, and where it was read off origin/main. A `null` code on a `changed` entry means the refusal did not come from a door at all. */
  before: { code: string | null; message: string | null; at: string };
}

// --- the principals the cases are asked of --------------------------------
//
// Deliberately concrete rather than generated: a golden file whose inputs are
// computed is a golden file whose diff nobody can read.

const owner: Principal = {
  id: "owner",
  role: "owner",
  scope: { tier: "areas", areas: null, queries: true, projects: null },
  source: "registry",
};

const assistant: Principal = {
  id: "assistant",
  role: "assistant",
  scope: { tier: "areas", areas: ["/"], queries: false, projects: null, autonomy: { level: "propose" } },
  source: "environment",
};

/**
 * The assistant on an instance that NARROWED `METISTRY_ASSISTANT_AREAS` off
 * its `["/"]` default — the only instance on which the writer's own scope
 * check can refuse anything (§2.4).
 */
const narrowed: Principal = {
  id: "assistant",
  role: "assistant",
  scope: { tier: "areas", areas: ["Areas/Health"], queries: false, projects: null, autonomy: { level: "propose" } },
  source: "environment",
};

/** An external agent with a real area grant and one project. */
const agent: Principal = {
  id: "scout",
  role: "agent",
  scope: { tier: "areas", areas: ["Areas/Health"], queries: false, projects: ["alpha"], autonomy: { level: "observe" } },
  source: "registry",
};

/** Tier `index`: may be told a page exists anywhere, may read none of them. */
const browser: Principal = {
  id: "browser",
  role: "agent",
  scope: { tier: "index", areas: [], queries: false, projects: [] },
  source: "registry",
};

/** No grant at all — not a narrower one. */
const ungranted: Principal = {
  id: "stranger",
  role: "agent",
  scope: { tier: "none", areas: [], queries: false, projects: [] },
  source: "registry",
};

/**
 * A crew mid-run (P2): the registry's third stored `kind` is now its own
 * role, so the scope is its manifest's `scope:`, the toolset is its
 * manifest's `uses:`, and the bearer behind it was minted for this run and
 * is burned after it.
 */
const crew: Principal = {
  id: "writer",
  role: "crew",
  scope: { tier: "areas", areas: ["Areas/Health"], queries: false, projects: ["alpha"] },
  source: { manifest: "agents/ops/writer.md" },
  uses: ["knowledge", "requests"],
};

/** The capture Shortcut: the plan's tier 0, capture-only. */
const captureTool: Principal = {
  id: "owner_token",
  role: "tool",
  scope: { tier: "none", areas: [], queries: false, projects: [] },
  source: "registry",
};

/**
 * An agent the owner has lent two connections (T4-8b): `github`, offered to
 * agents, and `work-jira`, which the owner has NOT offered — so the grant
 * alone reaches it no more than no grant would.
 */
const lent: Principal = {
  id: "scout",
  role: "agent",
  scope: { tier: "none", areas: [], queries: false, projects: [], connections: ["github", "work-jira"] },
  source: "registry",
};

const WHO: Record<string, Principal> = { owner, assistant, narrowed, agent, browser, crew, ungranted, lent, tool: captureTool };

describe("the refusal catalogue is the committed golden file", () => {
  const golden = JSON.parse(readFileSync(GOLDEN, "utf8")) as GoldenEntry[];

  it("has a case for every reason the enum declares", () => {
    const covered = new Set(golden.map((g) => g.reason));
    expect([...REASONS].filter((r) => !covered.has(r))).toEqual([]);
  });

  it("has no duplicate ids", () => {
    expect(new Set(golden.map((g) => g.id)).size).toBe(golden.length);
  });

  /**
   * Pinning the LIST, not the count, is what makes a change a decision
   * somebody writes down here. Three phases are in it:
   *
   * - **P2** changed one refusal: a crew calling outside `uses`.
   * - **P3** changed what fifteen refusals SAY — one sentence per reason,
   *   the facts substituted — without changing what any of them decides.
   *   Four of those fifteen are not wire changes at all: a hand-written
   *   "not granted" and an empty message are the same bytes once
   *   `errorEnvelope` supplies the canonical message for `forbidden`.
   * - **P4** changed what the OWNER gets, and only the owner: four entries,
   *   every one of them `who: "owner"`. The assertion below is the misuse
   *   test for that claim — if a P4 rule ever reaches an agent, a
   *   non-owner entry changes and this list stops matching.
   */
  it("records exactly the behaviour changes that were approved", () => {
    expect(golden.filter((g) => g.changed !== undefined).map((g) => g.id)).toEqual([
      "knowledge_search.tier_none",
      "knowledge_read.index_settled",
      "knowledge_read.not_a_vault_path",
      "knowledge_read.artifact",
      "knowledge_list.tier_none",
      "knowledge_list.prefix_outside",
      "knowledge_links.outside_areas",
      "knowledge_links.index_settled",
      "knowledge_grep.tier_index",
      "knowledge_grep.prefix_outside",
      "knowledge_write.not_the_writer",
      "knowledge_write.me_directory",
      "knowledge_write.user_journal",
      "queries_list.no_grant",
      "queries_run.no_grant",
      "tasks_create.not_a_member",
      "propose_action.no_room",
      "agents_delegate.not_the_assistant",
      "console_page.owner_artifact",
      "console_page.owner_machinery",
      "console_page.owner_secret",
      "console_page.owner_traversal",
      "crew_uses.outside_toolset",
    ]);
  });

  /**
   * **One wording per reason** (§2.5's five dialects, collapsed). Every
   * refusal that SPEAKS says the sentence its reason says; the facts in it
   * are substituted, the shape never is. The test that this is true is that
   * two refusals with the same reason and the same facts are the same
   * string — which is why `queries_list` and `queries_run` are here, and
   * why the two doors that give `scope_required` are.
   */
  it("gives one sentence per reason: the same facts come to the same words on every door", () => {
    const say = (id: string) => golden.find((g) => g.id === id)!.message;
    expect(say("queries_list.no_grant")).toBe(say("queries_run.no_grant"));
    expect(say("knowledge_read.index_settled")).toBe(say("knowledge_links.index_settled"));
    expect(say("knowledge_read.not_a_vault_path")).toBe(say("console_page.owner_machinery"));
    expect(say("knowledge_write.not_the_writer").replace("knowledge_write", "X")).toBe(say("agents_delegate.not_the_assistant").replace("agents_delegate", "X"));
  });

  /**
   * **A refusal that hides is not distinguishable from absence.** No
   * `needs`, no `expose`, and — through the one renderer — no `reason` on
   * the wire either. This is the property invariant 8 asks for in a type
   * rather than in a comment at fourteen call sites.
   */
  it("tells a hidden refusal nothing about itself", () => {
    for (const g of golden.filter((x) => x.tell === "hide")) {
      expect(g.needs ?? null, g.id).toBeNull();
      expect(g.expose ?? null, g.id).toBeNull();
      const envelope = formatRefusal(may(WHO[g.who]!, g.verb, g.resource));
      expect(Object.keys(envelope ?? {}), g.id).toEqual(["error"]);
    }
  });

  /**
   * P4's owner rule, stated where it is easiest to check: the owner is
   * refused nothing on any door, and the four entries that still answer
   * them are CLASSIFICATIONS — "this door has no page for that; here is the
   * one that does" — never a permission refusal and never a 404.
   */
  it("refuses the owner nothing, and classifies what this door does not serve", () => {
    // The two §2.6 found. Both are now `ok`.
    expect(may(owner, "read", { kind: "query", door: "console_query", name: "knowledge_pages", exposure: "route" }).ok).toBe(true);
    expect(may(owner, "read", { kind: "knowledge", door: "console_page", path: "Areas/Finance/tax.md" }).ok).toBe(true);
    // `isUserOwnedPath`'s refusal is stated for every principal but the
    // owner — it is theirs to begin with, so `may` never even reaches
    // `mayKnowledge` for them (the short-circuit above).
    expect(may(owner, "write", { kind: "knowledge", door: "write", path: "Me/profile.md" }).ok).toBe(true);
    expect(may(owner, "write", { kind: "knowledge", door: "write", path: "Journal/2026-09-21.md" }).ok).toBe(true);
    for (const g of golden.filter((x) => x.who === "owner")) {
      expect({ id: g.id, code: g.code, reason: g.reason }, g.id).toEqual({ id: g.id, code: "invalid_request", reason: "not_knowledge" });
      expect(g.tell, g.id).toBe("refuse");
    }
  });

  for (const g of golden) {
    it(`${g.id}: ${g.door} refuses ${g.who} with ${g.reason}`, () => {
      const d: Decision = may(WHO[g.who]!, g.verb, g.resource);
      expect(d.ok, `${g.id} must refuse`).toBe(false);
      const r = d as Refusal;
      // the golden file, byte for byte
      expect({ code: r.code, reason: r.reason, tell: r.tell, message: r.message }).toEqual({ code: g.code, reason: g.reason, tell: g.tell, message: g.message });
      expect(r.needs ?? null).toEqual(g.needs ?? null);
      expect(r.expose ?? null).toEqual(g.expose ?? null);
      // and what the door said BEFORE, from origin/main — except for the
      // entries that carry a `changed` sentence, which is where an approved
      // behaviour change is recorded rather than asserted away.
      if (g.changed === undefined) {
        expect(r.code, `${g.id} code changed (${g.before.at})`).toBe(g.before.code);
        expect(r.message === "" ? null : r.message, `${g.id} message changed (${g.before.at})`).toBe(g.before.message);
      } else {
        expect(`${r.code}:${r.message}`, `${g.id} is recorded as CHANGED but still answers what it did at ${g.before.at}`).not.toBe(`${g.before.code}:${g.before.message}`);
      }
    });
  }
});
