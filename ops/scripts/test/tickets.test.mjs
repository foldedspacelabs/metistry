// ops/scripts/tickets.mjs — the ticket files generated from the approved spec
// (docs/product/design-build-plan.md §3.6). Exercised two ways: the repo's own
// plan and ticket files must check clean (what CI actually needs), and the
// graph validator against small hand-written plans (what counts as broken).
//
// Run: node --test ops/scripts/test/

import { test } from "node:test";
import assert from "node:assert/strict";
import { check, criticalPath, idsIn, parsePlan, validate } from "../tickets.mjs";

const plan = (tickets, waves, heavy = "") => `
### 3.2 Waves, ticket by ticket

| Wave | Tickets |
| --- | --- |
${waves.map(([w, ids]) => `| ${w} | ${ids} |`).join("\n")}

### 3.3 The tickets

#### T1 — Data

${tickets.join("\n\n")}

### 3.4 Owner

### 3.6 Economics

   *Design-heavy* regardless of size: ${heavy || "none"}.

## 4. Questions
`;

const t = (id, size, wave, deps = "") => `**${id} · Title ${id}** · ${size} · ${wave} · deps${deps ? ` ${deps}` : ""} —\n*Spec:* §2.9 things.\n*Files:* a.\n*Tests:* b.\n*Accept:* c.`;

test("the repo's plan and generated ticket files check clean", () => {
  assert.deepEqual(check(), []);
});

test("a range expands only to tickets that exist, including split ones", () => {
  const known = new Set(["T6-1a", "T6-1b", "T6-2", "T6-3"]);
  assert.deepEqual(idsIn("T6-1…T6-3", known), ["T6-1a", "T6-1b", "T6-2", "T6-3"]);
});

test("a dependency on a later wave is a problem", () => {
  const p = parsePlan(plan([t("T1-1", "S", "W1", "T1-2"), t("T1-2", "S", "W2")], [["W1", "T1-1"], ["W2", "T1-2"]]));
  assert.match(validate(p).problems.join("\n"), /depends on T1-2, which lands later/);
});

test("a cycle is a problem", () => {
  const p = parsePlan(plan([t("T1-1", "S", "W1", "T1-2"), t("T1-2", "S", "W1", "T1-1")], [["W1", "T1-1, T1-2"]]));
  assert.match(validate(p).problems.join("\n"), /cycle/);
});

test("a ticket in no wave, or in two, is a problem", () => {
  const none = parsePlan(plan([t("T1-1", "S", "W1"), t("T1-2", "S", "W1")], [["W1", "T1-1"]]));
  assert.match(validate(none).problems.join("\n"), /T1-2 is in no wave/);
  const two = parsePlan(plan([t("T1-1", "S", "W1")], [["W1", "T1-1"], ["W2", "T1-1"]]));
  assert.match(validate(two).problems.join("\n"), /in both W1 and W2/);
});

test("the critical path follows the longest chain of agent-days", () => {
  const p = parsePlan(plan([t("T1-1", "L", "W1"), t("T1-2", "M", "W1", "T1-1"), t("T1-3", "S", "W1")], [["W1", "T1-1, T1-2, T1-3"]]));
  assert.deepEqual(criticalPath(p.tickets), { days: 7.5, path: ["T1-1", "T1-2"] });
});

test("design-heavy tickets are read from the plan", () => {
  const p = parsePlan(plan([t("T1-1", "S", "W1"), t("T1-2", "S", "W1")], [["W1", "T1-1, T1-2"]], "T1-2 (why)"));
  assert.deepEqual([...p.heavy], ["T1-2"]);
});
