// `metistry templates check` — daily-flow-spec §6.5's answer to "I edited the
// template, will the next run like it?"
//
// A template is the user's file (D12, §6.1): they edit it in Obsidian, and
// the next run reads whatever is there. That is the right semantics and it
// leaves one gap — between the edit and 19:00 there is nothing that says
// whether the directive they typed reads. This verb is that, and it is
// deliberately the cheap half of the engine: `validateTemplate` touches no
// database, no calendar and no vault, so this answers on a laptop with
// nothing running.
//
// The engine lives in `packages/core` (`template.ts`), because the routines
// and the future Obsidian plugin validate the same way from the same code —
// a second validator would be a second grammar within a year.

import { readdir, readFile, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import {
  FOLD_SOURCE,
  TEMPLATES_DIR,
  USER_SOURCE,
  validateTemplate,
  type TemplateFinding,
} from "@foldedspacelabs/metistry-core";
import type { Ui } from "./ui.js";

/**
 * Who renders which seeded template (§5.1's one-writer table and §7's
 * routines). It matters for exactly one check: `prose` is legal only where
 * the assistant owns the output (§6.3.3, D14), so a `{{ prose }}` in
 * `Plan.md` is an ERROR here rather than a note — found at the keyboard
 * instead of in tomorrow's plan.
 *
 * A template not named here has no known writer, so `prose` in it is reported
 * as a note: the check declines to guess who will render a file it has never
 * seen.
 */
export const TEMPLATE_SOURCES: Readonly<Record<string, string>> = Object.freeze({
  "Daily.md": USER_SOURCE,
  "Meeting.md": USER_SOURCE,
  "Weekly.md": USER_SOURCE,
  "Plan.md": "plan-tomorrow",
  "Standup.md": "standup-draft",
  "Fold.md": FOLD_SOURCE,
});

export interface TemplatesCheckOptions {
  instanceDir: string;
  /** One file instead of the whole folder: absolute, instance-relative or cwd-relative. */
  file?: string | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  /** Test seam: the date relative tokens in a `where:` resolve against. */
  now?: Date | undefined;
}

export interface TemplateCheckResult {
  /** Instance-relative where it can be (`Templates/Plan.md`), so the line reads the way Obsidian names the file. */
  path: string;
  /** The writer this template renders for, when one is known — `prose`'s legality turns on it. */
  source: string | null;
  ok: boolean;
  errors: number;
  notes: number;
  findings: TemplateFinding[];
}

export interface TemplatesCheckReport {
  dir: string;
  /** Set when there is no `Templates/` at all: absent, which is a fact and not a failure. */
  absent: string | null;
  checked: number;
  errors: number;
  notes: number;
  templates: TemplateCheckResult[];
}

/** Where the given `--file` actually is: as typed, inside the instance, or inside its `Templates/`. */
async function resolveFile(instanceDir: string, file: string): Promise<string | null> {
  const candidates = isAbsolute(file)
    ? [file]
    : [resolve(process.cwd(), file), join(instanceDir, file), join(instanceDir, TEMPLATES_DIR, file)];
  for (const candidate of candidates) {
    try {
      if ((await stat(candidate)).isFile()) return candidate;
    } catch {
      // next candidate — a path that is not there is not an error yet
    }
  }
  return null;
}

async function checkOne(instanceDir: string, file: string, opts: TemplatesCheckOptions): Promise<TemplateCheckResult> {
  const rel = relative(instanceDir, file);
  const path = rel.startsWith("..") ? file : rel;
  const name = path.split("/").at(-1) ?? path;
  const source = TEMPLATE_SOURCES[name] ?? null;
  const text = await readFile(file, "utf8");
  const result = validateTemplate(text, {
    ...(source !== null ? { source } : {}),
    ...(opts.now !== undefined ? { now: opts.now } : {}),
    ...(opts.env !== undefined ? { env: opts.env } : {}),
  });
  const errors = result.findings.filter((f) => f.severity === "error").length;
  return { path, source, ok: result.ok, errors, notes: result.findings.length - errors, findings: result.findings };
}

/**
 * Validate every `Templates/*.md` in the instance, or the one file named.
 * Never throws for a template that does not read — that is what the findings
 * are — and never throws for a missing folder either: a vault with no
 * `Templates/` is an install `metistry init` has not stamped, which is a fact
 * to report, not a crash.
 */
export async function templatesCheck(opts: TemplatesCheckOptions): Promise<TemplatesCheckReport> {
  const dir = join(opts.instanceDir, TEMPLATES_DIR);
  const empty: TemplatesCheckReport = { dir, absent: null, checked: 0, errors: 0, notes: 0, templates: [] };

  let files: string[];
  if (opts.file !== undefined) {
    const found = await resolveFile(opts.instanceDir, opts.file);
    if (found === null) return { ...empty, absent: `no such template: ${opts.file}` };
    files = [found];
  } else {
    let names: string[];
    try {
      names = (await readdir(dir)).filter((f) => f.endsWith(".md")).sort();
    } catch {
      return { ...empty, absent: `${dir} does not exist — \`metistry init\` stamps six templates there (docs/product/daily-flow-spec.md §6.1)` };
    }
    if (names.length === 0) return { ...empty, absent: `${dir} holds no templates` };
    files = names.map((n) => join(dir, n));
  }

  const templates: TemplateCheckResult[] = [];
  for (const file of files) templates.push(await checkOne(opts.instanceDir, file, opts));
  return {
    dir,
    absent: null,
    checked: templates.length,
    errors: templates.reduce((n, t) => n + t.errors, 0),
    notes: templates.reduce((n, t) => n + t.notes, 0),
    templates,
  };
}

/** The status word for one template, from the closed vocabulary (docs/ops/cli-style.md rule 5). */
const wordFor = (t: TemplateCheckResult): string => (t.errors > 0 ? "failed" : t.notes > 0 ? "degraded" : "ok");

/**
 * One line per template, then its findings indented under it — `line:
 * message`, the same shape a compiler prints, because the number is the point:
 * it is the line Obsidian shows.
 */
export function renderTemplatesCheck(report: TemplatesCheckReport, ui: Ui): string {
  if (report.absent !== null) return `${ui.status("n/a")}  ${report.absent}`;

  const out: string[] = [ui.heading(report.dir), ""];
  for (const t of report.templates) {
    const word = wordFor(t);
    const summary = t.errors > 0
      ? `${t.errors} ${t.errors === 1 ? "error" : "errors"}`
      : t.notes > 0
        ? `${t.notes} ${t.notes === 1 ? "note" : "notes"}`
        : "reads";
    out.push(`  ${ui.status(word)}  ${t.path}  ${ui.dim(summary)}`);
    for (const f of t.findings) {
      const mark = f.severity === "error" ? ui.paint("failed", "error") : ui.paint("degraded", "note");
      out.push(`        ${mark} ${ui.dim(`${t.path}:${f.line}`)}  ${f.message}`);
    }
  }
  out.push("");
  const counted = `${report.checked} ${report.checked === 1 ? "template" : "templates"}, ${report.errors} ${report.errors === 1 ? "error" : "errors"}, ${report.notes} ${report.notes === 1 ? "note" : "notes"}`;
  out.push(counted);
  if (report.errors > 0) {
    out.push(ui.note("a directive that does not read renders a visible note and the rest of the file still renders (§6.4) — nothing is silently dropped"));
  }
  return out.join("\n");
}
