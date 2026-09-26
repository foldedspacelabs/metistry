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

// ---------------------------------------------------------------------------
// The four check states (C10)
// ---------------------------------------------------------------------------

const status = lifted<{
  checkRowHtml: (c: Record<string, unknown>) => string;
  checksSummary: (checks: { status: string }[]) => string;
}>(["CHECK_STATES", "CHECK_WORD", "checkRowHtml", "checksSummary"], "{ checkRowHtml, checksSummary }");

const check = (s: string, name = "github-state") => ({ name, status: s, latency_ms: 12, probe: "listed 1 open PR" });
/** The state span: its class and its word. */
const stateOf = (html: string) => {
  const m = /<span class="([^"]*)">([^<·]*) · /.exec(html);
  return { cls: m?.[1], word: m?.[2]?.trim() };
};
/** The declarations of a top-level rule in style.css, e.g. `.degraded { … }`. */
const ruleOf = (selector: string) => new RegExp(`^${selector.replace(/[.[\]]/g, "\\$&")}\\s*\\{([^}]*)\\}`, "m").exec(CSS)?.[1] ?? "";

describe("the status list keeps the four states apart (C10)", () => {
  it("`degraded` and `absent` render distinctly — class, word and ink — and neither as `failed`", () => {
    const degraded = stateOf(status.checkRowHtml(check("degraded")));
    const absent = stateOf(status.checkRowHtml(check("absent")));
    expect(degraded).toEqual({ cls: "degraded", word: "degraded" });
    expect(absent).toEqual({ cls: "absent", word: "not configured" });
    expect(ruleOf(".degraded")).toContain("var(--mt-color-degraded)");
    expect(ruleOf(".absent")).toContain("var(--mt-color-absent)");
    expect(ruleOf(".degraded")).not.toBe(ruleOf(".absent"));
    for (const s of ["degraded", "absent"]) expect(status.checkRowHtml(check(s))).not.toContain("failed");
  });

  it("keeps ok and failed as they were", () => {
    expect(stateOf(status.checkRowHtml(check("ok")))).toEqual({ cls: "ok", word: "ok" });
    expect(stateOf(status.checkRowHtml(check("failed")))).toEqual({ cls: "failed", word: "failed" });
    expect(ruleOf(".failed")).toContain("var(--mt-color-failed)");
  });

  it("shows a word outside the contract as it came, in the neutral ink — never guessed to be a failure", () => {
    expect(stateOf(status.checkRowHtml(check("checking")))).toEqual({ cls: "absent", word: "checking" });
  });

  it("escapes the component name as well as the probe", () => {
    const html = status.checkRowHtml({ ...check("ok", "<img src=x onerror=alert(1)>"), probe: "<b>x</b>" });
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<b>");
  });

  it("answers before it is read: a summary line in the same words", () => {
    const checks = [...Array(9).fill("ok"), "degraded", "absent", "absent"].map((s) => ({ status: s }));
    expect(status.checksSummary(checks)).toBe("9 ok · 1 degraded · 2 not configured");
    expect(status.checksSummary([{ status: "ok" }, { status: "ok" }, { status: "ok" }])).toBe("all 3 healthy");
    expect(status.checksSummary([{ status: "ok" }, { status: "failed" }])).toBe("1 ok · 1 failed");
    expect(status.checksSummary([])).toBe("no checks reported");
  });

  it("no longer collapses the states in the source", () => {
    expect(SRC).not.toContain('c.status === "ok" ? "ok" : "failed"');
  });
});

// ---------------------------------------------------------------------------
// Tokens: quiet fills (C6) and the serif stack (C35)
// ---------------------------------------------------------------------------

describe("fills and faces are tokens", () => {
  it("paints no fill of its own: every tint is a declared *-quiet token (C6)", () => {
    expect(CSS).not.toContain("color-mix(");
    const quiet = [...CSS.matchAll(/var\((--mt-color-[a-z-]+-quiet)\)/g)].map((m) => m[1]!);
    expect(quiet.length).toBeGreaterThan(0);
    for (const t of new Set(quiet)) expect(TOKENS_CSS, `${t} is not in tokens.css`).toContain(`${t}:`);
  });

  it("sets agent prose in tokens.json's serif stack, never ui-serif (C32, C35)", () => {
    const stack = TOKENS.type.$meta.serif.split(" — ")[0]!.trim();
    const m = /font-family: var\(--mt-font-serif, ([^)]*)\);/.exec(CSS);
    expect(m?.[1]).toBe(stack);
    expect(CSS).not.toMatch(/font-family:[^;]*ui-serif/);
    expect(CSS).toMatch(/#messages li\.out, \.agent-prose \{/);
  });

  it("marks only a body an agent wrote as agent prose", () => {
    const bodyClass = lifted<(c: unknown) => string>(["bodyClass"], "bodyClass");
    expect(bodyClass({ author_kind: "agent" })).toBe("body agent-prose");
    expect(bodyClass({ author_kind: "user" })).toBe("body");
    expect(bodyClass(undefined)).toBe("body");
  });
});

// ---------------------------------------------------------------------------
// 12-hour clock times
// ---------------------------------------------------------------------------

describe("clock times are 12-hour with AM/PM on every device", () => {
  const { clockTime, dateTime } = lifted<{ clockTime: (t: unknown) => string; dateTime: (t: unknown) => string }>(
    ["clockTime", "dateTime"],
    "{ clockTime, dateTime }",
  );
  const at = (h: number, m: number) => new Date(2026, 8, 26, h, m); // local time, so the test holds in any TZ

  it("pins the clock whatever the locale", () => {
    expect(clockTime(at(13, 2))).toBe("1:02 PM");
    expect(clockTime(at(9, 4))).toBe("9:04 AM");
    expect(clockTime(at(0, 5))).toBe("12:05 AM");
    expect(clockTime(at(12, 0))).toBe("12:00 PM");
    expect(clockTime(at(23, 59).toISOString())).toBe("11:59 PM");
    expect(dateTime(at(13, 2))).toMatch(/, 1:02 PM$/);
  });

  it("says nothing rather than Invalid Date", () => {
    expect(clockTime("not a time")).toBe("");
    expect(dateTime(undefined)).toBe("");
  });

  it("leaves no timestamp to the locale's clock", () => {
    expect(SRC).not.toMatch(/\.toLocaleString\(|\.toLocaleTimeString\(/);
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
