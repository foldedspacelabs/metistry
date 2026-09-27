// `metistry templates check` — the verb that answers "will the next run like
// the template I just edited?" (daily-flow-spec §6.5). Built on a real
// `metistry init` output rather than a fixture, so the six seeded templates
// are the ones under test: if one of them stops reading, this fails.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { init } from "../src/init.js";
import { main } from "../src/main.js";
import { renderTemplatesCheck, templatesCheck, TEMPLATE_SOURCES } from "../src/templates.js";
import { createUi } from "../src/ui.js";

const seedDir = fileURLToPath(new URL("../../../seed/", import.meta.url));
const fresh = () => mkdtemp(join(tmpdir(), "metistry-templates-"));
/** an explicit, empty --product-dir: this suite runs inside the real checkout and must not read ITS .env */
const noCheckout = () => mkdtemp(join(tmpdir(), "metistry-templates-no-checkout-"));
const ui = createUi({ env: { NO_COLOR: "1" } });

async function instance(): Promise<string> {
  const dir = join(await fresh(), "instance");
  await init({ dir, seedDir, version: "1.0.0" });
  return dir;
}

describe("templatesCheck", () => {
  it("reads every template `metistry init` stamps, and finds no error in any of them", async () => {
    const report = await templatesCheck({ instanceDir: await instance() });
    expect(report.absent).toBeNull();
    expect(report.checked).toBe(7);
    expect(report.errors).toBe(0);
    expect(report.templates.map((t) => t.path).sort()).toEqual([
      "Templates/Brief.md",
      "Templates/Daily.md",
      "Templates/Fold.md",
      "Templates/Meeting.md",
      "Templates/Plan.md",
      "Templates/Standup.md",
      "Templates/Weekly.md",
    ]);
  });

  it("knows which routine renders which seeded template, because `prose`'s legality turns on it", () => {
    expect(TEMPLATE_SOURCES["Plan.md"]).toBe("plan-tomorrow");
    expect(TEMPLATE_SOURCES["Fold.md"]).toBe("knowledge-fold");
    expect(TEMPLATE_SOURCES["Brief.md"]).toBe("morning-brief");
    expect(TEMPLATE_SOURCES["Daily.md"]).toBe("user");
  });

  it("names the line of every directive that does not read", async () => {
    const dir = await instance();
    await writeFile(
      join(dir, "Templates", "Broken.md"),
      '---\nsource: user\n---\n# Broken\n\n{{ nope }}\n{{ tasks where: "due soonish" }}\n{{ section "A" }}\n',
    );
    const report = await templatesCheck({ instanceDir: dir, file: "Broken.md" });
    expect(report.checked).toBe(1);
    expect(report.errors).toBe(3);
    expect(report.templates[0]?.findings.map((f) => f.line)).toEqual([6, 7, 8]);
    expect(report.templates[0]?.findings[0]?.message).toContain("unknown directive `nope`");
  });

  it("calls `prose` in the plan an ERROR — the routine that renders it may not write that file (§6.3)", async () => {
    const dir = await instance();
    await writeFile(join(dir, "Templates", "Plan.md"), '---\nsource: user\n---\n# Plan\n\n{{ prose "summarise today" }}\n');
    const report = await templatesCheck({ instanceDir: dir, file: "Plan.md" });
    expect(report.errors).toBe(1);
    expect(report.templates[0]?.findings[0]?.message).toContain("only available in the fold's, the Morning Brief's and the Standup's templates");
  });

  it("C103: the Morning Brief's and the Standup's `prose` is legal — a note, never an error", async () => {
    const dir = await instance();
    await writeFile(join(dir, "Templates", "Standup.md"), '---\nsource: user\n---\n# Standup\n\n{{ prose "say what is blocked" }}\n');
    for (const file of ["Brief.md", "Standup.md"]) {
      const report = await templatesCheck({ instanceDir: dir, file });
      expect(report.errors, file).toBe(0);
      expect(report.templates[0]?.source, file).toBe(file === "Brief.md" ? "morning-brief" : "standup");
      expect(report.templates[0]?.findings.filter((f) => f.message.includes("prose")).every((f) => f.severity === "note"), file).toBe(true);
    }
  });

  it("calls the same directive a note in the fold's own template", async () => {
    const report = await templatesCheck({ instanceDir: await instance(), file: "Fold.md" });
    expect(report.errors).toBe(0);
    expect(report.notes).toBeGreaterThan(0);
    expect(report.templates[0]?.findings.every((f) => f.severity === "note")).toBe(true);
  });

  it("reports a vault with no Templates/ as absent, not as a failure", async () => {
    const dir = await instance();
    await rm(join(dir, "Templates"), { recursive: true });
    const report = await templatesCheck({ instanceDir: dir });
    expect(report.absent).toContain("does not exist");
    expect(report.errors).toBe(0);
    expect(renderTemplatesCheck(report, ui)).toContain("n/a");
  });

  it("says so when the file named is not there", async () => {
    const report = await templatesCheck({ instanceDir: await instance(), file: "Nope.md" });
    expect(report.absent).toBe("no such template: Nope.md");
  });
});

describe("renderTemplatesCheck", () => {
  it("prints one line per template and `path:line  message` under the ones with findings", async () => {
    const dir = await instance();
    await writeFile(join(dir, "Templates", "Broken.md"), "---\nsource: user\n---\n{{ nope }}\n");
    const text = renderTemplatesCheck(await templatesCheck({ instanceDir: dir }), ui);
    expect(text).toContain("Templates/Broken.md");
    expect(text).toContain("Templates/Broken.md:4");
    expect(text).toContain("unknown directive `nope`");
    expect(text).toContain("8 templates, 1 error");
  });
});

describe("metistry templates check", () => {
  const run = async (argv: string[], dir: string) => {
    const lines: string[] = [];
    const errs: string[] = [];
    const code = await main([...argv, "--instance", dir, "--product-dir", await noCheckout()], {
      out: (s) => lines.push(s),
      err: (s) => errs.push(s),
    });
    return { code, out: lines.join("\n"), err: errs.join("\n") };
  };

  it("exits 0 on a vault whose templates read", async () => {
    const r = await run(["templates", "check"], await instance());
    expect(r.code).toBe(0);
    expect(r.out).toContain("7 templates, 0 errors");
  });

  it("exits 1 when a template has an error, and names it", async () => {
    const dir = await instance();
    await writeFile(join(dir, "Templates", "Daily.md"), "---\nsource: user\n---\n{{ tasks where: \"drop table\" }}\n");
    const r = await run(["templates", "check"], dir);
    expect(r.code).toBe(1);
    expect(r.out).toContain("Templates/Daily.md:4");
  });

  it("checks one file when asked", async () => {
    const r = await run(["templates", "check", "Plan.md"], await instance());
    expect(r.code).toBe(0);
    expect(r.out).toContain("1 template, 0 errors");
  });

  it("--json is the same report as a document", async () => {
    const r = await run(["templates", "check", "--json"], await instance());
    const report = JSON.parse(r.out) as { checked: number; errors: number; templates: { path: string; source: string | null }[] };
    expect(report.checked).toBe(7);
    expect(report.errors).toBe(0);
    expect(report.templates.find((t) => t.path === "Templates/Fold.md")?.source).toBe("knowledge-fold");
  });

  it("refuses a subcommand it does not have, with a usage line", async () => {
    const r = await run(["templates", "render"], await instance());
    expect(r.code).toBe(2);
    expect(r.err).toContain("usage: metistry templates check");
  });

  it("is in the help", async () => {
    const lines: string[] = [];
    await main(["--help"], { out: (s) => lines.push(s) });
    expect(lines.join("\n")).toContain("templates check");
  });
});
