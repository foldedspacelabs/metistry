// The roster `agents_delegate` advertises (H8, 2026-09-17). The assistant used
// to see crew NAMES only, so choosing between them was guesswork the registry
// corrected by refusal; the manifest already carries a `description`, and this
// is that sentence arriving where the choice is made.
//
// Two properties, both of them limits:
//   - a description reaches the `crew` field's description verbatim (modulo
//     whitespace) — the tool definition, not a prompt line, so it travels with
//     the tool to whatever model is assigned;
//   - the roster is CAPPED. It is spent out of the same definition-token
//     budget PoC-17 measured (test/artifacts.integration.test.ts asserts the
//     whole eager surface against it), so a long description is trimmed and a
//     large registry is summarised rather than listed.
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { crewRoster, registerCrewTools, type CrewDispatcher, type CrewSummary } from "../src/index.js";

const dispatcherOf = (crews: CrewSummary[]): CrewDispatcher => ({
  dispatch: async () => ({ ok: false, code: "not_available" }),
  crews: () => crews,
});

/** What the brain's `reg` does, reduced to the one thing this asks about: the registered `crew` field's description. */
function crewFieldDescription(dispatcher: CrewDispatcher | undefined): string {
  let description = "";
  registerCrewTools(
    (_name, _toolDescription, inputSchema) => {
      description = (inputSchema as { crew: z.ZodType }).crew.description ?? "";
    },
    dispatcher,
    { id: "assistant", kind: "internal", grants: { tier: "all", areas: [] }, projects: [] },
  );
  return description;
}

describe("the crew roster in the tool definition", () => {
  it("a manifest's description reaches the tool's `crew` field, next to the name it belongs to", () => {
    const d = crewFieldDescription(
      dispatcherOf([
        { name: "researcher", description: "Reads the granted notes and reports what it finds" },
        { name: "librarian", description: "Files and re-links pages after a fold" },
      ]),
    );
    expect(d).toContain("researcher — Reads the granted notes and reports what it finds");
    expect(d).toContain("librarian — Files and re-links pages after a fold");
    expect(d).toContain("agents/<area>/<name>.md"); // the field still says what it IS
  });

  it("a crew with no description is still listed by name — dispatch needs the name, choosing needs the sentence", () => {
    expect(crewRoster([{ name: "quiet" }])).toBe(" Registered: quiet.");
    expect(crewRoster([{ name: "quiet", description: "   " }])).toBe(" Registered: quiet.");
  });

  it("a long description is trimmed and a large registry is summarised — the definition budget is not the registry's to spend", () => {
    const long = crewRoster([{ name: "verbose", description: "x".repeat(400) }]);
    expect(long.length).toBeLessThan(160);
    expect(long).toContain("…");
    const many = crewRoster(Array.from({ length: 23 }, (_, i) => ({ name: `crew-${i}` })));
    expect(many).toContain("; and 3 more.");
    expect(many).not.toContain("crew-20");
  });

  it("no dispatcher: the field says what it is and advertises nothing, because there is nothing to advertise", () => {
    const d = crewFieldDescription(undefined);
    expect(d).toContain("agents/<area>/<name>.md");
    expect(d).not.toContain("Registered");
    expect(crewRoster([])).toContain("None are registered");
  });
});
