// What the verbs the owner sees most actually print (docs/ops/cli-style.md).
//
// Two halves, and the second is the one that matters:
//   - the plain rendering, asserted whole, for fabricated inputs — a
//     snapshot in the sense that the entire block is in the test, so a
//     change to any of it is visible in the diff rather than in a terminal;
//   - `--json`, which must be untouched by any of this: one document on
//     stdout, not one escape sequence in it, even with FORCE_COLOR set and
//     a terminal-shaped Ui configured.
//
// Every Ui here is built with an explicit env, so the icons are the same on
// a Mac with LANG set and in a container without one.
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { renderProviderTest } from "../src/compute.js";
import { renderConnectList } from "../src/connect.js";
import { renderDeploymentReport } from "../src/deployment-report.js";
import { renderDown } from "../src/service-control.js";
import { renderTable, type DoctorReport } from "../src/doctor.js";
import { main, renderHelp } from "../src/main.js";
import { updateSummary } from "../src/update.js";
import { StepFailed } from "../src/steps.js";
import { renderVersionInfo } from "../src/version.js";
import { createUi, strip } from "../src/ui.js";

const UTF8 = { LANG: "en_US.UTF-8" } as NodeJS.ProcessEnv;
/** A terminal: colour on, 100 columns, UTF-8. */
const term = createUi({ stream: { write: () => true, isTTY: true, columns: 100 }, env: UTF8 });
/** A pipe with a UTF-8 locale: no colour, glyphs still legible. */
const plain = createUi({ stream: { write: () => true, isTTY: false }, env: UTF8 });
/** A wide pipe: 100 columns, so the help's descriptions each fit on one line. */
const wide = createUi({ stream: { write: () => true, isTTY: false, columns: 100 }, env: UTF8 });
/** A terminal that cannot draw them: the ASCII set. */
const ascii = createUi({ stream: { write: () => true, isTTY: false }, env: { LANG: "C" } as NodeJS.ProcessEnv });

const REPORT: DoctorReport = {
  as_of: "2026-09-19T12:00:00.000Z",
  product_dir: "/opt/metistry",
  shape: "launchd",
  ok: false,
  rows: [
    { kind: "bridge", name: "brain", status: "ok", latency_ms: 4, probe: "GET /check" },
    { kind: "bridge", name: "eventkit", status: "absent", latency_ms: 0, probe: "GET /check", remediation: "not configured: set METISTRY_EK_URL" },
    { kind: "db", name: "db", status: "failed", latency_ms: 31, probe: "SELECT 1", remediation: "ECONNREFUSED — metistry start db" },
    { kind: "db", name: "migrations", status: "degraded", latency_ms: 2, probe: "schema_migrations", remediation: "1 migration(s) not applied (0002_b.sql)" },
  ],
};

describe("doctor: the plain table", () => {
  it("groups by kind, one icon and one word per status, the remediation underneath", () => {
    expect(renderTable(REPORT, plain)).toBe(
      [
        "/opt/metistry — shape launchd, 2026-09-19T12:00:00.000Z",
        "",
        "bridge",
        "  ✓ brain     ok           4ms",
        "  ○ eventkit  absent       0ms",
        "      → not configured: set METISTRY_EK_URL",
        "",
        "db",
        "  ✗ db          failed      31ms",
        "      → ECONNREFUSED — metistry start db",
        "  ⚠ migrations  degraded     2ms",
        "      → 1 migration(s) not applied (0002_b.sql)",
        "",
        "4 checks: 1 ok, 1 degraded, 1 failed, 1 absent — ✗ FAILED",
      ].join("\n"),
    );
  });

  it("a terminal gets the same text, coloured; a non-UTF-8 one gets [ok] [x] [!]", () => {
    expect(strip(renderTable(REPORT, term))).toBe(renderTable(REPORT, plain));
    const a = renderTable(REPORT, ascii);
    expect(a).toContain("[ok] brain");
    expect(a).toContain("[x]  db ");
    expect(a).toContain("[!]  migrations");
    expect(a).toContain("-> not configured");
    expect(a).not.toContain("✓");
  });

  it("an all-ok report says healthy and shows no remediation column at all", () => {
    const ok: DoctorReport = { ...REPORT, ok: true, rows: [{ kind: "bridge", name: "brain", status: "ok", latency_ms: 4, probe: "GET /check", remediation: "never shown on an ok row" }] };
    const text = renderTable(ok, plain);
    expect(text).toContain("1 checks: 1 ok, 0 degraded, 0 failed, 0 absent — ✓ healthy");
    expect(text).not.toContain("never shown");
  });
});

describe("version", () => {
  it("two aligned columns, the provenance dimmed beside the number", () => {
    const info = { cli_version: "0.9.0", product_version: "0.9.0", lock: { version: "0.9.0", channel: "git" as const }, runtime_pack: { version: "0.9.0", commit: "91ca417cabc", built_at: "2026-09-18T02:41:56Z" } };
    expect(renderVersionInfo(info, plain)).toBe(
      ["cli           0.9.0", "product       0.9.0", "lock          0.9.0 (git)", "runtime pack  0.9.0 (commit 91ca417, built 2026-09-18T02:41:56Z)"].join("\n"),
    );
    expect(strip(renderVersionInfo(info, term))).toBe(renderVersionInfo(info, plain));
  });
});

describe("deployment", () => {
  it("the shape and the power policy, then a table with a header rule; running is ● / ○, and n/a where it is not knowable", () => {
    expect(
      renderDeploymentReport(
        {
          shape: "launchd",
          from: ".metistry/deployment.yaml",
          keep_awake: "always",
          keep_awake_setting: { enabled: true, sleep_on_battery: false, sleep_lid_closed: true },
          services: [
            { name: "db", shape: "launchd", enabled: true, running: true },
            { name: "console", shape: "launchd", enabled: true, running: false },
            { name: "reconciler", shape: "launchd", enabled: false },
          ],
        },
        plain,
      ),
    ).toBe(
      [
        "shape       launchd  (from .metistry/deployment.yaml)",
        "keep_awake  always",
        "",
        "service     shape    enabled  running",
        "──────────  ───────  ───────  ───────",
        "db          launchd  yes      ● yes",
        "console     launchd  yes      ○ no",
        "reconciler  launchd  no       ○ n/a",
      ].join("\n"),
    );
  });
});

describe("down", () => {
  it("what was stopped, then what looking afterwards found, then the tally", () => {
    expect(
      renderDown(
        {
          ok: true,
          shape: "launchd",
          commands: [],
          results: [
            { service: "supervisor", action: "stop", ok: true, detail: "booted out" },
            { service: "db", action: "stop", ok: false, detail: "exit 3" },
          ],
          confirmations: [
            { name: "com.foldedspacelabs.metistry", stopped: true, detail: "not loaded" },
            { name: "compose", stopped: false, detail: "1 container still up" },
          ],
        },
        plain,
      ),
    ).toBe(
      [
        "service     action  ok        detail",
        "──────────  ──────  ────────  ──────────",
        "supervisor  stop    ✓ ok      booted out",
        "db          stop    ✗ FAILED  exit 3",
        "",
        "2 service(s): 1 ok, 1 failed",
        "",
        "confirmed by looking",
        "  ✓ gone      com.foldedspacelabs.metistry  not loaded",
        "  ✗ STILL UP  compose                       1 container still up",
        "",
        "1/2 confirmed stopped (shape launchd)",
      ].join("\n"),
    );
  });
});

describe("connect --list", () => {
  const listed = {
    console_url: "http://127.0.0.1:8080",
    tools: [
      { tool: "cursor" as const, display_name: "Cursor", agent: "registered" as const, token: "keychain" as const, config: "~/.cursor/mcp.json → mcpServers.metistry" },
      { tool: "devin" as const, display_name: "Devin", agent: "pending" as const, token: "n/a" as const, config: "paste at Customize -> MCPs" },
    ],
  };

  it("one row per tool, the agent and token words coloured from the shared vocabulary", () => {
    const text = renderConnectList(listed, plain);
    expect(text.split("\n").slice(0, 5)).toEqual([
      "console  http://127.0.0.1:8080",
      "",
      "tool    agent         token       config",
      "──────  ────────────  ──────────  ────────────────────────────────────────",
      "cursor  ✓ registered  ✓ keychain  ~/.cursor/mcp.json → mcpServers.metistry",
    ]);
    expect(text).toContain("⚠ pending"); // pending is amber, not green: its token authenticates nothing yet
    expect(text).toContain("awaiting your approval");
  });
});

describe("compute providers test", () => {
  it("the verdict, then the listing and the completion as two aligned sub-rows", () => {
    expect(
      renderProviderTest(
        {
          name: "lmstudio",
          ok: true,
          listingOk: true,
          url: "http://127.0.0.1:1234/v1",
          models: ["qwen3-8b", "gemma-3-12b"],
          detail: "200, 2 models",
          completion: { ok: true, model: "qwen3-8b", reason: "assignment", detail: "1 token in 240ms" },
        },
        plain,
      ),
    ).toBe(["✓ lmstudio  listing ok — 200, 2 models", "    models      qwen3-8b, gemma-3-12b", "    completion  ok qwen3-8b (chosen: assignment) — 1 token in 240ms"].join("\n"));
  });

  it("a listing that worked under a completion that did not is still ✗, and says how to override", () => {
    const text = renderProviderTest(
      {
        name: "openrouter",
        ok: false,
        listingOk: true,
        url: "https://openrouter.ai/api/v1",
        models: ["a", "b"],
        detail: "200, 447 models",
        completion: { ok: false, model: "anthropic/claude-sonnet-5", reason: "shortlist", detail: "HTTP 404" },
      },
      plain,
    );
    expect(text.split("\n")[0]).toBe("✗ openrouter  listing ok — 200, 447 models");
    // …and the sub-row wraps under its own column rather than off the edge
    expect(text.split("\n").slice(2)).toEqual([
      "    completion  FAILED anthropic/claude-sonnet-5 (chosen: shortlist) — HTTP 404",
      "                — override with --model <id>",
    ]);
  });

  it("a failure keeps the word FAILED and adds the icon", () => {
    const text = renderProviderTest({ name: "openai", ok: false, listingOk: false, url: "https://api.openai.com/v1", models: [], detail: "401 unauthorized" }, plain);
    expect(text).toBe("✗ openai  listing FAILED — 401 unauthorized");
  });
});

describe("update's closing summary", () => {
  it("one line: did it land, on what, and what moved", () => {
    const base = { ui: plain, dryRun: false, code: 0, source: "git" as const, version: "0.9.0", restarted: ["com.foldedspacelabs.metistry"] };
    expect(updateSummary({ ...base, migrations: { applied: ["0007_x.sql"] } })).toBe("✓ update ok — git 0.9.0, 1 migration(s) applied, 1 job(s) kickstarted");
    expect(updateSummary({ ...base, dryRun: true, restarted: [] })).toBe("○ dry run — git 0.9.0, nothing was changed");
    expect(updateSummary({ ...base, code: 1, restarted: [] })).toBe("⚠ updated, and doctor is not happy — git 0.9.0, no migrations, nothing kickstarted");
  });

  // "nothing kickstarted" reads as "nothing needed it"; the 0.12.0 → 0.14.0
  // run printed it after its restart step aborted with three jobs owed
  it("an interrupted or unreached restart is said to be exactly that", () => {
    const base = { ui: plain, dryRun: false, code: 1, source: "release" as const, version: "0.14.0", migrations: { applied: ["0026_a.sql"] }, failure: new StepFailed("compose failed") };
    expect(updateSummary({ ...base, restarted: [], restart: { reached: false, completed: false, owed: [] } })).toBe(
      "✗ update failed — release 0.14.0, 1 migration(s) applied, nothing restarted — the update stopped before its restart step",
    );
    expect(updateSummary({ ...base, restarted: ["a"], restart: { reached: true, completed: false, owed: ["a", "b"] } })).toBe(
      "✗ update failed — release 0.14.0, 1 migration(s) applied, restart interrupted — kickstarted a; NOT kickstarted (code changed): b",
    );
    expect(updateSummary({ ...base, restarted: [], restart: { reached: true, completed: false, owed: [] } })).toBe("✗ update failed — release 0.14.0, 1 migration(s) applied, restart interrupted — none kickstarted");
  });

  it("what was left undone makes the verdict \"incomplete\" and is named", () => {
    const s = updateSummary({
      ui: plain,
      dryRun: false,
      code: 1,
      source: "release",
      version: "0.14.0",
      restarted: ["com.foldedspacelabs.metistry"],
      restart: { reached: true, completed: true, owed: ["com.foldedspacelabs.metistry"] },
      deferred: [{ what: "METISTRY_BRIDGE_TOKEN_RECONCILER_USER", why: "not minted", fix: ["metistry secrets mint METISTRY_BRIDGE_TOKEN_RECONCILER_USER"] }],
    });
    expect(s).toBe("✗ update incomplete — release 0.14.0, no migrations, 1 job(s) kickstarted, not done: METISTRY_BRIDGE_TOKEN_RECONCILER_USER (the commands are above)");
  });
});

describe("--help", () => {
  it("opens with the verbs grouped and aligned, then the full reference", () => {
    const text = renderHelp(wide);
    const lines = text.split("\n");
    expect(lines[0]).toBe("metistry — Metistry command line");
    expect(text).toContain("\ninstall\n  init <dir>");
    expect(text).toContain("\nevery day\n  doctor ");
    // aligned: every verb in a group starts at the same column, every
    // description too
    const group = lines.slice(lines.indexOf("every day") + 1, lines.indexOf("every day") + 6);
    const descriptionColumn = group.map((l) => /^ {2}\S.*?( {2,})\S/.exec(l)).map((m) => (m ? m.index + m[0].length : -1));
    expect(new Set(descriptionColumn)).toHaveLength(1); // one column for every description in a group
    expect(text).toContain("reference — every verb, every flag");
    expect(text).toContain("  metistry init <dir> [--name <assistant name>]"); // the reference is unabridged
    expect(text.split("\n").every((l) => !l.includes(""))).toBe(true);
  });

  it("every verb in the overview is a verb the CLI answers", async () => {
    const out: string[] = [];
    const err: string[] = [];
    // an unknown command exits 2 and says so; a known one never does
    for (const verb of ["doctor", "version", "deployment", "connect", "update", "migrate-layout"]) {
      out.length = 0;
      err.length = 0;
      await main([verb, "--help"], { out: (s) => out.push(s), err: (s) => err.push(s) });
      expect(err.join("\n")).not.toContain(`unknown command: ${verb}`);
    }
  });
});

// ---- the contract --json keeps ------------------------------------------

async function checkout(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "metistry-output-"));
  await mkdir(join(root, "db", "migrations"), { recursive: true });
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "metistry", version: "1.2.3" }));
  await mkdir(join(root, "seed"), { recursive: true });
  await writeFile(join(root, "seed", "identity.yaml"), "name: Seed\n");
  return root;
}

describe("--json is never touched by any of this", () => {
  afterEach(() => {
    delete process.env.FORCE_COLOR;
  });

  it("version --json: one document, no escape sequence, even with FORCE_COLOR set", async () => {
    process.env.FORCE_COLOR = "3";
    const productDir = await checkout();
    const out: string[] = [];
    expect(await main(["version", "--json", "--product-dir", productDir], { out: (s) => out.push(s) })).toBe(0);
    expect(out).toHaveLength(1);
    expect(out[0]).not.toContain("");
    expect(JSON.parse(out[0]!)).toMatchObject({ product_version: "1.2.3" });
  });

  it("doctor --json: the report object, no escape sequence, and the exit code unchanged", async () => {
    process.env.FORCE_COLOR = "3";
    const productDir = await checkout();
    const deps = { env: {} as NodeJS.ProcessEnv, db: null, platform: "linux" as const, exec: (async () => ({ code: 127, stdout: "", stderr: "" })) as never };
    const out: string[] = [];
    const code = await main(["doctor", "--json", "--product-dir", productDir], { out: (s) => out.push(s), doctorDeps: deps });
    expect(out).toHaveLength(1);
    expect(out[0]).not.toContain("");
    const report = JSON.parse(out[0]!) as DoctorReport;
    expect(report.ok).toBe(code === 0);
    expect(report.rows.every((r) => ["ok", "degraded", "failed", "absent"].includes(r.status))).toBe(true);

    // …and the plain rendering of the SAME report carries no colour either,
    // because the suite's stdout is not a terminal (FORCE_COLOR is the one
    // thing that would override that, so it goes first)
    delete process.env.FORCE_COLOR;
    const plainOut: string[] = [];
    await main(["doctor", "--product-dir", productDir], { out: (s) => plainOut.push(s), doctorDeps: deps });
    expect(plainOut.join("\n")).not.toContain("");
  });

  it("--no-color flattens a forced-colour terminal", async () => {
    process.env.FORCE_COLOR = "3";
    const productDir = await checkout();
    const out: string[] = [];
    await main(["version", "--no-color", "--product-dir", productDir], { out: (s) => out.push(s) });
    expect(out.join("\n")).not.toContain("");
    expect(out.join("\n")).toContain("1.2.3");
  });
});
