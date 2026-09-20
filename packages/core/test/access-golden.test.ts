// **The refusal catalogue.** Every `(code, reason, message, needs)` a door can
// answer with, in one committed file, so changing what a refusal SAYS is a
// reviewable diff in `access.golden.json` rather than a string edited inside a
// handler where nobody looks (§4: "one golden file of every (reason, needs)
// pair" — one of the two artefacts the research document calls the most
// valuable of the exercise).
//
// It is also P1's proof of no behaviour change. Every entry carries `before`:
// the code and message that door returned at `origin/main` (c00034b), with the
// `file:line` it was read off. The test asserts `may()` produces it BYTE FOR
// BYTE. If a refusal's wording moves, this fails and the diff says exactly
// which sentence a caller — or a model — will now read.
//
// Adding a door means adding a case here. That is deliberate: a refusal with
// no golden entry is a refusal nobody reviewed.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { REASONS, may, type Decision, type Principal, type Refusal, type Resource, type Verb } from "../src/index.js";

const GOLDEN = new URL("./access.golden.json", import.meta.url);

interface GoldenEntry {
  id: string;
  door: string;
  who: string;
  verb: Verb;
  resource: Resource;
  code: string;
  reason: string;
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

const WHO: Record<string, Principal> = { owner, assistant, narrowed, agent, browser, crew, ungranted, tool: captureTool };

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
   * P2 changed exactly one refusal (§4's table: "a crew calling outside
   * `uses` gets `forbidden` where it previously got the client's 'not in
   * this run's tool list'"). Pinning the LIST, not the count, is what makes
   * a second change a decision somebody writes down here.
   */
  it("records exactly the behaviour changes that were approved", () => {
    expect(golden.filter((g) => g.changed !== undefined).map((g) => g.id)).toEqual(["crew_uses.outside_toolset"]);
  });

  for (const g of golden) {
    it(`${g.id}: ${g.door} refuses ${g.who} with ${g.reason}`, () => {
      const d: Decision = may(WHO[g.who]!, g.verb, g.resource);
      expect(d.ok, `${g.id} must refuse`).toBe(false);
      const r = d as Refusal;
      // the golden file, byte for byte
      expect({ code: r.code, reason: r.reason, message: r.message }).toEqual({ code: g.code, reason: g.reason, message: g.message });
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
