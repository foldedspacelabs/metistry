// `.metistry/scheduled.yaml` — the schema F-4 freezes (design-build-plan
// §2.5). The acceptance is the plan's own example, verbatim; everything after
// it is what the file refuses, each refusal a line naming the field.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import {
  FIELD_ORIGINS,
  FIELD_ORIGIN_LABELS,
  MAX_TASK_CHARS,
  emptyScheduled,
  isAssignment,
  parseScheduled,
  validateScheduled,
  type ScheduledResult,
} from "../src/index.js";

/** design-build-plan.md §2.5's example, byte for byte (at cc5c75c) — the ticket's acceptance. */
const PLAN_EXAMPLE = `# .metistry/scheduled.yaml (F-4 freezes the schema)
routines:
  standup:
    schedule: { days: working_days, at: ["08:00"] }   # or days: [mon, tue, …]
    paused: false
    config: { template: Templates/Standup.md, skip_without_calendar_event: false }
  vendor-sweep:                       # a New Routine: an assignment, no product code
    actor: vendor-research
    task: "Summarise everything added to Areas/Finance since yesterday…"
    grants: { read: [Areas/Finance], write: [Journal/Digest/] }
    schedule: { days: [mon, tue, wed, thu, fri], at: ["07:00"] }
syncs:
  github-state:
    connection: github
    every: 15m                        # 5m | 15m | 1h | 6h
    raise: { review_requested: true, assigned: true }
`;

/** The error lines of a file that must be refused — and proof it is never applied. */
function refused(text: string): readonly string[] {
  const r: ScheduledResult = parseScheduled(text);
  expect(r.ok, `expected a refusal:\n${text}`).toBe(false);
  expect(r.value).toBeNull();
  return r.errors;
}

/** One routine entry, as a file. */
const routine = (name: string, body: string): string => `routines:\n  ${name}:\n${body.replace(/^/gm, "    ")}\n`;
/** One sync entry, as a file. */
const sync = (name: string, body: string): string => `syncs:\n  ${name}:\n${body.replace(/^/gm, "    ")}\n`;

describe("scheduled.yaml — the acceptance", () => {
  it("§2.5's example file validates, and parsing rewrites nothing", () => {
    const r = parseScheduled(PLAN_EXAMPLE);
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.value).toEqual(parseYaml(PLAN_EXAMPLE)); // no defaults, no transforms: a door can write back what it validated
    const routines = r.value?.routines ?? {};
    expect(isAssignment(routines["standup"]!)).toBe(false);
    expect(isAssignment(routines["vendor-sweep"]!)).toBe(true);
    expect(r.value?.syncs?.["github-state"]?.every).toBe("15m");
  });

  it("every scheduled.yaml example in docs/ops/scheduled.md validates", () => {
    const doc = readFileSync(new URL("../../../docs/ops/scheduled.md", import.meta.url), "utf8");
    const blocks = [...doc.matchAll(/```yaml\n(# \.metistry\/scheduled\.yaml[^\n]*\n[\s\S]*?)```/g)].map((m) => m[1]!);
    expect(blocks.length).toBeGreaterThan(0);
    for (const block of blocks) expect(parseScheduled(block).errors, block).toEqual([]);
    expect(blocks[0]).toBe(PLAN_EXAMPLE); // the doc opens with the plan's example, unedited
  });

  it("an absent or empty file is no changes; a syntax error or a duplicate key is a line, not a throw", () => {
    for (const text of ["", "\n", "# nothing changed yet\n", "{}\n"]) {
      expect(parseScheduled(text)).toEqual({ ok: true, value: text === "{}\n" ? {} : emptyScheduled, errors: [] });
    }
    expect(validateScheduled(undefined).ok).toBe(true);
    expect(refused("routines: [unclosed\n")[0]).toMatch(/^\(root\): /);
    expect(refused("routines:\n  standup: { paused: true }\n  standup: { paused: false }\n")[0]).toMatch(/^\(root\): .*unique/i);
  });
});

describe("scheduled.yaml — the closed schedule shape, in the file", () => {
  it("refuses `every` outside the closed set — on a routine's schedule and on a sync", () => {
    for (const every of ["10m", "30m", "1d", "2h", "15M", '"*/15 * * * *"', "15"]) {
      const shown = JSON.stringify(parseYaml(`x: ${every}`).x);
      expect(refused(routine("inbox-sort", `schedule: { every: ${every} }`)), every).toEqual([
        `routines.inbox-sort.schedule.every: every must be one of 5m, 15m, 1h, 6h — ${shown} is not (the set is closed)`,
      ]);
      expect(refused(sync("github-state", `connection: github\nevery: ${every}`)), every).toEqual([
        `syncs.github-state.every: every must be one of 5m, 15m, 1h, 6h — ${shown} is not (the set is closed)`,
      ]);
    }
  });

  it("refuses a cron string: cron is accepted only in a product manifest, and only for one release", () => {
    expect(refused(routine("standup", `schedule: "0 8 * * 1-5"`))[0]).toMatch(
      /^routines\.standup\.schedule: a schedule is \{days, at, tz\?\} or \{every: 5m\|15m\|1h\|6h\} — a cron string is accepted only in a product manifest/,
    );
  });

  it("refuses a malformed time of day, with the path to the one that is wrong", () => {
    expect(refused(routine("standup", `schedule: { days: working_days, at: ["08:00", "8:30"] }`))).toEqual([
      `routines.standup.schedule.at.1: at times are HH:MM, 24-hour, two-digit hours ("08:00", "23:00")`,
    ]);
    expect(refused(routine("standup", `schedule: { days: weekdays, at: ["08:00"] }`))[0]).toMatch(/^routines\.standup\.schedule\.days: /);
    expect(refused(routine("standup", `schedule: { days: working_days, at: ["08:00"], tz: "+01:00" }`))[0]).toMatch(/^routines\.standup\.schedule\.tz: /);
  });
});

describe("scheduled.yaml — routines", () => {
  it("an override may change any one field and leave the rest to the manifest", () => {
    for (const body of ["paused: true", `schedule: { every: 1h }`, "config: { retention_days: 30, areas: [Areas/Finance], learn: true }", "{}"]) {
      const text = body === "{}" ? "routines:\n  knowledge-fold: {}\n" : routine("knowledge-fold", body);
      expect(parseScheduled(text).errors, body).toEqual([]);
    }
  });

  it("refuses an override key it does not know, a config key that is not snake_case, and a config value that is not flat", () => {
    expect(refused(routine("standup", `scheduel: { every: 1h }`))).toEqual([`routines.standup: Unrecognized key: "scheduel"`]);
    expect(refused(routine("standup", `config: { skipWithoutEvent: true }`))).toEqual([
      "routines.standup.config.skipWithoutEvent: a key is lowercase snake_case, as the manifest declares it",
    ]);
    expect(refused(routine("standup", `config: { template: { path: Templates/Standup.md } }`))).toEqual([
      "routines.standup.config.template: a config value is a string, a number, true/false, or a list of those",
    ]);
    expect(refused(routine("standup", `paused: "yes"`))[0]).toMatch(/^routines\.standup\.paused: /);
    expect(refused("routines:\n  standup:\n")[0]).toMatch(/^routines\.standup: a routine entry is a map/);
  });

  it("refuses a routine name that is not a manifest name", () => {
    for (const name of ["Standup", "standup_draft", "__proto__", "9am"]) {
      expect(refused(routine(name, "paused: true"))[0], name).toMatch(/a routine or sync name is lowercase kebab-case/);
    }
  });

  it("a New Routine needs an actor, a task and a schedule — it has no default to fall back on", () => {
    const base = { actor: "actor: vendor-research", task: `task: "Sweep Areas/Finance"`, schedule: `schedule: { days: [mon], at: ["07:00"] }` };
    expect(parseScheduled(routine("sweep", Object.values(base).join("\n"))).errors).toEqual([]);
    expect(refused(routine("sweep", [base.actor, base.task].join("\n")))[0]).toMatch(/^routines\.sweep\.schedule: required — a schedule is/);
    expect(refused(routine("sweep", [base.actor, base.schedule].join("\n")))[0]).toMatch(/^routines\.sweep\.task: /);
    expect(refused(routine("sweep", [base.task, base.schedule].join("\n")))[0]).toMatch(/^routines\.sweep\.actor: /);
  });

  it("refuses an actor that is not an agent id, an empty task, and a task past the ceiling", () => {
    const schedule = `schedule: { every: 6h }`;
    expect(refused(routine("sweep", `actor: Vendor Research\ntask: go\n${schedule}`))).toEqual([
      "routines.sweep.actor: actor is an agent id — lowercase kebab-case, at most 40 characters",
    ]);
    expect(refused(routine("sweep", `actor: vendor-research\ntask: "   "\n${schedule}`))).toEqual([
      "routines.sweep.task: a task says what to do — it cannot be empty",
    ]);
    expect(refused(routine("sweep", `actor: vendor-research\ntask: "${"x".repeat(MAX_TASK_CHARS + 1)}"\n${schedule}`))).toEqual([
      `routines.sweep.task: a task is at most ${MAX_TASK_CHARS} characters — more than that belongs in the actor's definition`,
    ]);
  });

  it("refuses config on a New Routine — config is a manifest's, and an assignment has none", () => {
    expect(refused(routine("sweep", `actor: vendor-research\ntask: go\nschedule: { every: 6h }\nconfig: { template: Templates/X.md }`))).toEqual([
      "routines.sweep.config: a New Routine has no config — config is declared by a routine's manifest, and an assignment has none",
    ]);
  });

  it("per-run grants are vault prefixes an agent may hold — never the machinery, Artifacts/, or a traversal", () => {
    const ok = (grants: string) => parseScheduled(routine("sweep", `actor: a\ntask: go\nschedule: { every: 6h }\ngrants: ${grants}`));
    expect(ok("{ read: [Areas/Finance, Areas/Finance/], write: [Journal/Digest/] }").errors).toEqual([]);
    expect(ok("{}").errors).toEqual([]);
    for (const bad of [".metistry/queries", "Artifacts/Reports", "Areas/../Me", "areas/finance", "/Areas/Finance", "Areas//Finance", ""]) {
      const r = ok(`{ read: ["${bad}"] }`);
      expect(r.ok, bad).toBe(false);
      expect(r.errors, bad).toEqual([
        "routines.sweep.grants.read.0: a grant is a TitleCase vault prefix an agent may hold (e.g. Areas/Finance) — never .metistry/, Artifacts/ or a traversal",
      ]);
    }
    expect(ok("{ read: [Areas/Finance], admin: [Areas] }").errors).toEqual([`routines.sweep.grants: Unrecognized key: "admin"`]);
  });
});

describe("scheduled.yaml — syncs", () => {
  it("a sync names its connection, and has a cadence, never a time of day", () => {
    expect(parseScheduled(sync("github-state", "connection: github\npaused: true")).errors).toEqual([]);
    expect(refused(sync("github-state", "every: 15m"))[0]).toMatch(/^syncs\.github-state\.connection: /);
    expect(refused(sync("github-state", `connection: github\nschedule: { days: working_days, at: ["08:00"] }`))).toEqual([
      `syncs.github-state: Unrecognized key: "schedule"`,
    ]);
    expect(refused(sync("github-state", "connection: GitHub"))).toEqual(["syncs.github-state.connection: connection is a connection's name — lowercase kebab-case"]);
  });

  it("raise toggles are snake_case rule names, each true or false", () => {
    expect(refused(sync("github-state", "connection: github\nraise: { reviewRequested: true }"))).toEqual([
      "syncs.github-state.raise.reviewRequested: a key is lowercase snake_case, as the manifest declares it",
    ]);
    expect(refused(sync("github-state", "connection: github\nraise: { assigned: sometimes }"))).toEqual([
      "syncs.github-state.raise.assigned: a raise rule is true or false",
    ]);
  });
});

describe("scheduled.yaml — the file", () => {
  it("refuses a top-level key it does not know", () => {
    expect(refused("timers:\n  standup: { every: 1h }\n")).toEqual([`(root): Unrecognized key: "timers"`]);
  });

  it("reports every problem at once, each naming its field", () => {
    const errors = refused(`${routine("standup", "schedule: { every: 10m }\npaused: maybe")}${sync("github-state", "connection: github\nevery: 1d")}`);
    expect(errors).toHaveLength(3);
    expect(errors.map((e) => e.split(":")[0])).toEqual(["routines.standup.schedule.every", "routines.standup.paused", "syncs.github-state.every"]);
  });
});

describe("field origins", () => {
  it("are the three layers, labelled with §2.5's words", () => {
    expect(FIELD_ORIGINS).toEqual(["default", "profile", "yours"]);
    expect(FIELD_ORIGINS.map((o) => FIELD_ORIGIN_LABELS[o])).toEqual(["default", "from your profile", "yours"]);
  });
});
