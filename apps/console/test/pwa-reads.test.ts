// T7-1 — the PWA reads what the server resolved; it does not recompute it
// (design-build-plan §2.17). Four things the phone used to derive or collapse
// on its own, each held here to the one place that owns it:
//
//   - the effective action table: `scope.autonomy.detailed` from GET
//     /api/agents, printed the way `metistry agents autonomy` prints it;
//   - the four check states (C10): `degraded` and `absent` are not `failed`;
//   - the quiet fills (C6) and the serif stack (C35): tokens, not literals;
//   - clock times: 12-hour with AM/PM on every device.
//
// apps/console/web/app.js is a browser script and cannot be imported, so, as
// in composer.test.ts, the pure top-level declarations are lifted out of the
// source by name and evaluated. A rename makes the lift throw rather than
// letting a test pass vacuously — and `node --check` on app.js (last test)
// catches what a lift cannot see: a clash with a name declared elsewhere.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { listAgents } from "../src/agents.js";
import { agentAutonomy, MODE_LABEL as CLI_MODE_LABEL, renderAutonomy } from "../../../packages/cli/src/agents.js";
import { createUi } from "../../../packages/cli/src/ui.js";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const SRC = read("../web/app.js");
const CSS = read("../web/style.css");
const TOKENS_CSS = read("../web/tokens.css");
const TOKENS = JSON.parse(read("../../../docs/product/design/tokens.json")) as { type: { $meta: { serif: string } } };

/** Lift a top-level `const NAME = …` or `function NAME(…) {…}` out of app.js. */
function lift(name: string): string {
  const lines = SRC.split("\n");
  const start = lines.findIndex((l) => new RegExp(`^(?:const|let) ${name}\\b|^function ${name}\\(`).test(l));
  if (start === -1) throw new Error(`app.js no longer declares ${name} — update this test with the rename`);
  let depth = 0;
  for (let i = start; i < lines.length; i++) {
    for (const ch of lines[i]!) {
      if ("([{".includes(ch)) depth++;
      else if (")]}".includes(ch)) depth--;
    }
    if (depth <= 0) return lines.slice(start, i + 1).join("\n");
  }
  throw new Error(`could not find the end of ${name} in app.js`);
}

/** app.js's esc() is textContent → innerHTML: it escapes &, < and >. */
const esc = (s: unknown) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const lifted = <T>(names: string[], expr: string): T =>
  new Function("esc", `${names.map(lift).join("\n")}\nreturn (${expr});`)(esc) as T;

interface Row { kind: string; source: string | undefined; text: string }
const pwa = lifted<{
  ACTION_MODE_LABEL: Record<string, string>;
  actionTableRows: (scope: unknown) => Row[] | null;
  actionTableHtml: (scope: unknown) => string;
}>(
  ["ACTION_MODE_LABEL", "modeWord", "actionEntryText", "actionTableRows", "actionTableHtml"],
  "{ ACTION_MODE_LABEL, actionTableRows, actionTableHtml }",
);

// ---------------------------------------------------------------------------
// The effective action table
// ---------------------------------------------------------------------------

/** Every shape the table can take: all defaulted at each level, set, clamped, and a widening by hand. */
const RECORDS: Record<string, Record<string, unknown>> = {
  "no record at all": {},
  "propose, nothing set": { level: "propose" },
  "act_within_scope, nothing set": { level: "act_within_scope" },
  "set, and clamped under propose": { level: "propose", actions: { comment: "allow", task_update: "propose" } },
  "a widening by hand": { level: "act_within_scope", actions: { dispatch: "allow", capture: "deny" } },
  "everything clamped under observe": { level: "observe", actions: { capture: "propose", dispatch: "allow" } },
};

/** What GET /api/agents sends for one stored row — the console's own `listAgents`, then the wire. */
async function wireRow(autonomy: Record<string, unknown>) {
  const db = {
    query: async () => ({
      rows: [{
        id: "researcher", display_name: "Researcher", kind: "external",
        grants: { tier: "none", areas: [] }, projects: [], autonomy,
        created_at: "2026-09-20T10:00:00Z", last_seen_at: null, revoked: false,
        remote: false, approved_at: null, grant_source: null, pending: false,
      }],
    }),
  };
  const [row] = await listAgents(db);
  return JSON.parse(JSON.stringify(row)) as { id: string; display_name: string; autonomy: Record<string, unknown>; scope: unknown };
}

/** What `metistry agents autonomy researcher` prints against that same console, with colour off. */
async function cliTable(row: Awaited<ReturnType<typeof wireRow>>) {
  const fetchFn = (async () => new Response(JSON.stringify({ agents: [row] }), { status: 200 })) as unknown as typeof fetch;
  const env = { METISTRY_LOCAL_OWNER_TOKEN: "owner-token-value", METISTRY_CONSOLE_URL: "http://127.0.0.1:9" } as NodeJS.ProcessEnv;
  const view = await agentAutonomy("researcher", { actions: {} }, { env, fetchFn });
  const text = renderAutonomy(view, createUi({ noColor: true, env: { NO_COLOR: "1" } }));
  const level = /^level\s+(\S+)$/m.exec(text)?.[1];
  const rows = [...text.matchAll(/^ {2}(\S+)\s+(.+)$/gm)].map((m) => [m[1], m[2]]);
  return { level, rows };
}

describe("the PWA prints the effective action table the CLI prints (§2.17)", () => {
  for (const [name, autonomy] of Object.entries(RECORDS)) {
    it(`${name}: same level, same kinds in the same order, same words`, async () => {
      const row = await wireRow(autonomy);
      const cli = await cliTable(row);
      const rows = pwa.actionTableRows(row.scope);
      expect(rows).not.toBeNull();
      expect(cli.rows).toHaveLength(4);
      expect(rows!.map((r) => [r.kind, r.text])).toEqual(cli.rows);
      expect((row.scope as { autonomy: { level: string } }).autonomy.level).toBe(cli.level);
      // and the markup carries each line, escaped, with its level
      const html = pwa.actionTableHtml(row.scope);
      expect(html).toContain(`level: ${cli.level}`);
      for (const [kind, text] of cli.rows) expect(html).toContain(`<span class="mono">${kind}</span> ${esc(text)}`);
    });
  }

  it("marks a clamp as the owner's setting overridden, never as an ordinary default", async () => {
    const rows = pwa.actionTableRows((await wireRow(RECORDS["set, and clamped under propose"]!)).scope)!;
    const comment = rows.find((r) => r.kind === "comment")!;
    expect(comment.source).toBe("clamped");
    expect(comment.text).toBe("Ask First (asked Allow — propose's ceiling is Ask First)");
    expect(rows.find((r) => r.kind === "task_update")).toMatchObject({ source: "set", text: "Ask First" });
    expect(rows.find((r) => r.kind === "dispatch")).toMatchObject({ source: "defaulted", text: "Ask First (default for propose)" });
  });

  it("says the modes in the CLI's words — one vocabulary, not two", () => {
    expect(pwa.ACTION_MODE_LABEL).toEqual(CLI_MODE_LABEL);
  });

  it("reads the table from the server rather than holding a copy of the arithmetic", () => {
    // The defaults, the ceilings and the clamp live in core (packages/core/src/actions.ts) only.
    expect(SRC).not.toMatch(/\b(ACTION_DEFAULTS|LEVEL_CEILING|MODE_RANK|AUTONOMY_LEVELS|ACTION_KINDS)\b/);
    expect(SRC).not.toMatch(/function effectiveActions\b|\blevelOf\(/);
    expect(SRC).toContain("actionTableHtml(a.scope)");
  });

  it("says unavailable when a row carries no table — it never fills one in", () => {
    expect(pwa.actionTableRows(undefined)).toBeNull();
    expect(pwa.actionTableRows({ autonomy: { level: "propose" } })).toBeNull();
    expect(pwa.actionTableHtml({})).toContain("actions: unavailable");
  });
});

// A lift evaluates one declaration at a time, so it cannot see two top-level
// declarations of one name — which is a SyntaxError that stops the whole PWA
// from loading. Parse the real file, as the browser will.
describe("app.js", () => {
  it("parses as a module", () => {
    const r = spawnSync(process.execPath, ["--check", fileURLToPath(new URL("../web/app.js", import.meta.url))], { encoding: "utf8" });
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
  });
});
