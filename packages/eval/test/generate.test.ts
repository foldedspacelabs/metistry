// The complexity fixture generator (X-121; docs/ops/dynamic-router.md §7.2).
//
// OFFLINE throughout: the two models are fakes (`helpers/fake-generator-models.ts`)
// or a recording of them (`fixtures/generate/recording.jsonl`) replayed through
// the same `replayFetch` the confirmatory eval uses. No test dials a model, and
// every item below is SYNTHETIC ("synthetic simple item 3 …") — never an eval
// fixture. The eval's own fixtures are the owner's or the generator's at the
// owner's hand, and the shipped example stays empty (C11).
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { COMPLEXITY, COMPLEXITY_NAMES, complexityMessages } from "@foldedspacelabs/metistry-core";
import { FIXTURE_SET_BAR, loadComplexityFixtures, parseRecording, recordingFetch, replayFetch, wordCount, type RecordedResponse } from "../src/complexity.js";
import {
  ADJUDICATE_LABEL,
  GEN_ENV,
  GENERATE_DEFAULTS,
  GeneratorModelError,
  RUBRIC_PHRASES,
  RubricLeakError,
  assertNoRubric,
  assertNotClaude,
  assertTwoFamilies,
  chatJson,
  generateComplexityFixtures,
  generatorFromEnv,
  relabelPrompt,
  renderGenerateReport,
  rubricLeaks,
  shuffled,
  trapOf,
  writerPrompt,
  type GenerateResult,
} from "../src/generate.js";
import { main } from "../src/main.js";
import { FAKE_RELABELLER, FAKE_WRITER, fakeGeneratorFetch } from "./helpers/fake-generator-models.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const RECORDING = join(HERE, "fixtures", "generate", "recording.jsonl");
const CX = join(HERE, "fixtures", "complexity");

const CONFIG = { baseUrl: "https://fake.invalid/v1", writer: FAKE_WRITER, relabeller: FAKE_RELABELLER };
const fakeFetch = (): typeof fetch => fakeGeneratorFetch(FAKE_RELABELLER);

async function generate(over: Partial<Parameters<typeof generateComplexityFixtures>[0]> = {}): Promise<GenerateResult> {
  return generateComplexityFixtures({ config: CONFIG, fetchFn: fakeFetch(), ...over });
}

const capture = (stream: NodeJS.WriteStream): { text: () => string; restore: () => void } => {
  const chunks: string[] = [];
  const spy = vi.spyOn(stream, "write").mockImplementation((s: string | Uint8Array) => (chunks.push(String(s)), true));
  return { text: () => chunks.join(""), restore: () => spy.mockRestore() };
};

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

// ---- the rubric never reaches a prompt ------------------------------------------------------

describe("the prompts carry the class names and the structural rules only", () => {
  it("no writer prompt and no relabel prompt contains a frozen rubric phrase, a live class description or the planner's wording", () => {
    const prompts: string[] = [];
    for (const label of COMPLEXITY_NAMES) {
      const p = writerPrompt({ label, count: 56, longMin: 8, shortMin: 8, d08: 8 });
      prompts.push(p.system, p.user);
    }
    const r = relabelPrompt(["synthetic one", "synthetic two"]);
    prompts.push(r.system, r.user);
    for (const text of prompts) expect(rubricLeaks(text)).toEqual([]);
    // the names ARE there — that is all the models are told
    for (const label of COMPLEXITY_NAMES) {
      expect(writerPrompt({ label, count: 1 }).user).toContain(`"${label}"`);
      expect(r.system).toContain(`"${label}"`);
    }
    expect(writerPrompt({ label: "simple", count: 1 }).system).toMatch(/no definitions are given/);
  });

  it("the frozen list is taken from §2 and the planner — each phrase is a live description's or the live prompt's, so the freeze still matches what it froze", () => {
    const live = [...COMPLEXITY.map((c) => c.description), complexityMessages("x", { now: new Date(0) })[0]!.content, ...["says", "best_fits", "names"].map((p) => complexityMessages("x", { phrasing: p as "says", now: new Date(0) })[0]!.content)].join("\n").toLowerCase();
    for (const phrase of RUBRIC_PHRASES) expect(live, phrase).toContain(phrase.toLowerCase());
  });

  it("detects a leak of each kind — a frozen phrase, a live description verbatim, the planner's question — and the guard throws", () => {
    expect(rubricLeaks("please weigh these: Weighing   Options")).toEqual(["weighing options"]);
    for (const c of COMPLEXITY) expect(rubricLeaks(`prefix ${c.description} suffix`)).not.toEqual([]);
    expect(rubricLeaks(complexityMessages("x", { now: new Date(0) })[0]!.content).length).toBeGreaterThan(3);
    expect(() => assertNoRubric("fine", "it asks for one small thing")).toThrow(RubricLeakError);
    expect(() => assertNoRubric("fine", "also fine")).not.toThrow();
  });

  it("a leaking request is refused BEFORE fetch — nothing is dialled", async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: "{}" } }] }), { status: 200 })) as unknown as typeof fetch;
    const opts = { baseUrl: "https://fake.invalid/v1", model: FAKE_WRITER, fetchFn, temperature: 0, schemaName: "x", schema: {} };
    await expect(chatJson(opts, `the classes: ${COMPLEXITY[2].description}`, "write")).rejects.toBeInstanceOf(RubricLeakError);
    await expect(chatJson(opts, "fine", "Answer with one letter and nothing else.")).rejects.toBeInstanceOf(RubricLeakError);
    expect(fetchFn).not.toHaveBeenCalled();
    // the relabel batch's user message is the writer's items quoted back — data, so a message that happens to say "weighing options" does not abort the batch
    await expect(chatJson({ ...opts, userIsData: true }, "fine", '1. "I am weighing options for the trip"')).resolves.toEqual({});
  });

  it("the D08 rule the writer IS told is §7.2's structural one, not §2's description", () => {
    const p = writerPrompt({ label: "demanding", count: 10, d08: 3 });
    expect(p.user).toContain("terse, operational replanning under several constraints");
    expect(rubricLeaks(p.user)).toEqual([]);
  });
});

// ---- the two models, and the refusals ----------------------------------------------------------

describe("two non-Claude models from two families", () => {
  it("refuses a Claude model in either role, under any spelling", () => {
    for (const id of ["anthropic/claude-sonnet-5", "Claude-Haiku", "claude", "anthropic/something"]) {
      expect(() => assertNotClaude(id, "writer")).toThrow(GeneratorModelError);
      expect(() => assertNotClaude(id, "relabeller")).toThrow(/C11/);
    }
    expect(() => assertNotClaude("google/gemini-3-flash", "writer")).not.toThrow();
    expect(() => assertNotClaude("", "writer")).toThrow(GEN_ENV.MODEL);
  });

  it("refuses a relabeller from the writer's family — one family is not a second opinion", () => {
    expect(() => assertTwoFamilies("google/gemma-4", "google/gemini-3-pro")).toThrow(GeneratorModelError);
    expect(() => assertTwoFamilies("gemma4:e4b", "google/gemini-3-pro")).toThrow(/same family/);
    expect(() => assertTwoFamilies("google/gemma-4", "qwen/qwen-4")).not.toThrow();
  });

  it("reads the environment, names every variable it misses, and relaxes only the base URL and key under replay", () => {
    expect(() => generatorFromEnv({})).toThrow(GEN_ENV.RELABEL_MODEL);
    const two = { [GEN_ENV.MODEL]: FAKE_WRITER, [GEN_ENV.RELABEL_MODEL]: FAKE_RELABELLER };
    expect(() => generatorFromEnv(two)).toThrow(GEN_ENV.BASE_URL);
    expect(generatorFromEnv(two, { replay: true })).toEqual({ writer: FAKE_WRITER, relabeller: FAKE_RELABELLER });
    expect(generatorFromEnv({ ...two, [GEN_ENV.BASE_URL]: "https://openrouter.ai/api/v1", [GEN_ENV.API_KEY]: "k" })).toEqual({ baseUrl: "https://openrouter.ai/api/v1", apiKey: "k", writer: FAKE_WRITER, relabeller: FAKE_RELABELLER });
    expect(() => generatorFromEnv({ ...two, [GEN_ENV.MODEL]: "anthropic/claude-sonnet-5" }, { replay: true })).toThrow(GeneratorModelError);
    expect(() => generatorFromEnv({ ...two, [GEN_ENV.RELABEL_MODEL]: "google/gemini-3-pro" }, { replay: true })).toThrow(/same family/);
  });

  it("the run itself refuses the same things, so a caller cannot route around the environment check", async () => {
    await expect(generate({ config: { ...CONFIG, writer: "anthropic/claude-opus-5" } })).rejects.toBeInstanceOf(GeneratorModelError);
    await expect(generate({ config: { ...CONFIG, relabeller: "google/gemini-3-pro" } })).rejects.toThrow(/same family/);
    await expect(generate({ config: { writer: FAKE_WRITER, relabeller: FAKE_RELABELLER } })).rejects.toThrow(GEN_ENV.BASE_URL);
  });
});

// ---- the run: write, relabel blind, resolve --------------------------------------------------------

describe("the run against the fake models", () => {
  it("an item the two models label differently is never kept under one label alone; every D08-class item lands in the pile", async () => {
    const r = await generate();
    const byText = new Map(r.items.map((i) => [i.text, i]));
    for (const f of r.kept) {
      const item = byText.get(f.text)!;
      expect(item.d08).toBe(false);
      expect(f.label).toBe(item.writer);
      if (item.relabel !== item.writer) {
        expect(item.relabel).not.toBeNull();
        expect(f.accept).toEqual([item.relabel]);
        expect(f.notes).toContain(`relabeller: ${item.relabel}`);
      } else expect(f.accept).toBeUndefined();
    }
    const d08 = r.items.filter((i) => i.d08);
    expect(d08.length).toBe(GENERATE_DEFAULTS.d08);
    for (const i of d08) {
      const row = r.pile.find((p) => p.text === i.text)!;
      expect(row).toMatchObject({ label: ADJUDICATE_LABEL, source: "generated", d08: true });
      expect(row.notes).toMatch(/§7\.2 has the owner label each/);
    }
    // the opposite-class and unanswered disagreements are the rest of the pile; none is kept, none dropped (the pile had room)
    const hard = r.items.filter((i) => !i.d08 && (i.relabel === null || Math.abs(COMPLEXITY_NAMES.indexOf(i.relabel) - COMPLEXITY_NAMES.indexOf(i.writer)) === 2));
    expect(hard.length).toBeGreaterThan(0);
    for (const i of hard) expect(r.pile.some((p) => p.text === i.text)).toBe(true);
    expect(r.pile).toHaveLength(GENERATE_DEFAULTS.d08 + hard.length);
    expect(r.pile.length).toBeLessThanOrEqual(GENERATE_DEFAULTS.maxAdjudicate);
    expect(r.dropped).toEqual([]);
    expect(r.stats.dispositions).toEqual({ kept: r.kept.length - r.stats.dispositions.accepted, accepted: r.stats.dispositions.accepted, pile: r.pile.length, dropped: 0 });
    expect(r.stats.duplicates_dropped).toBe(1);
  });

  it("a pile past its cap DROPS the overflow — counted, kept under no label — and D08-class rows always fit", async () => {
    const r = await generate({ maxAdjudicate: 0 });
    expect(r.pile).toHaveLength(GENERATE_DEFAULTS.d08);
    expect(r.pile.every((p) => p.d08)).toBe(true);
    expect(r.dropped.length).toBeGreaterThan(0);
    for (const d of r.dropped) expect(r.kept.some((f) => f.text === d.text)).toBe(false);
    expect(r.stats.dispositions.dropped).toBe(r.dropped.length);
    expect(r.stats.pending.some((p) => /exceed the pile's cap/.test(p))).toBe(true);
  });

  it("every kept row is a valid fixture marked source: generated, with its trap read off its own words; every pile row is REFUSED by the loader", async () => {
    const r = await generate();
    const kept = loadComplexityFixtures(r.kept.map((f) => JSON.stringify(f)).join("\n"), "generated");
    expect(kept.issues).toEqual([]);
    expect(kept.fixtures).toHaveLength(r.kept.length);
    for (const f of kept.fixtures) {
      expect(f.source).toBe("generated");
      expect(f.trap).toBe(trapOf(f.label, f.text));
      if (f.label === "simple" && wordCount(f.text) > 40) expect(f.trap).toBe("long_simple");
      if (f.label === "demanding" && wordCount(f.text) <= 8) expect(f.trap).toBe("short_demanding");
      if (f.label === "moderate") expect(f.trap).toBeUndefined();
    }
    const pile = loadComplexityFixtures(r.pile.map((p) => JSON.stringify(p)).join("\n"), "adjudicate");
    expect(pile.fixtures).toEqual([]);
    expect(pile.issues).toHaveLength(r.pile.length);
    expect(pile.issues[0]!.message).toMatch(/label/);
    // the ids are unique across both files
    const ids = [...r.kept, ...r.pile].map((x) => x.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("computes the length-against-label correlation and the §7.2 counts on the kept rows, with D08 pending on the owner", async () => {
    const r = await generate();
    const s = r.stats;
    expect(s.length_r).not.toBeNull();
    expect(Math.abs(s.length_r!)).toBeLessThan(FIXTURE_SET_BAR.max_abs_length_r);
    for (const c of COMPLEXITY_NAMES) expect(s.kept_by_class[c]).toBeGreaterThanOrEqual(FIXTURE_SET_BAR.min_per_class);
    expect(s.long_simple / s.kept_by_class.simple).toBeGreaterThanOrEqual(FIXTURE_SET_BAR.trap_share);
    expect(s.short_demanding / s.kept_by_class.demanding).toBeGreaterThanOrEqual(FIXTURE_SET_BAR.trap_share);
    expect(s.fixture_set.d08).toBe(0);
    expect(s.fixture_set.qualifies).toBe(false); // D08 waits on the owner
    expect(s.pile_d08).toBe(GENERATE_DEFAULTS.d08);
    expect(s.ok).toBe(true);
    expect(s.agreement).toBeGreaterThan(0.8);
    expect(s.unanswered).toBe(3);
    expect(s.confusion.simple.demanding + s.confusion.demanding.simple).toBeGreaterThan(0);
    const report = renderGenerateReport(r, { at: new Date(0), fixturesPath: "f.jsonl", pilePath: "p.jsonl" });
    expect(report).toContain("PENDING (8 in the pile)");
    expect(report).toContain("| dropped — pile full | 0 |");
    expect(report).toMatch(/\*\*OK — /);
  });

  it("too few items per class is NOT OK, said plainly", async () => {
    const r = await generate({ perClass: 20, d08: 5 });
    expect(r.stats.ok).toBe(false);
    expect(renderGenerateReport(r, { fixturesPath: "f", pilePath: "p" })).toMatch(/\*\*NOT OK — /);
  });

  it("the shuffle is seeded, so the relabeller's batches are the same on a replay", () => {
    const xs = Array.from({ length: 50 }, (_, i) => i);
    expect(shuffled(xs, 1)).toEqual(shuffled(xs, 1));
    expect(shuffled(xs, 1)).not.toEqual(shuffled(xs, 2));
    expect([...shuffled(xs, 7)].sort((a, b) => a - b)).toEqual(xs);
  });
});

// ---- record, then replay: the same run, no network -------------------------------------------------

describe("--record and --replay", () => {
  it("a run replayed from its own recording produces the same files, uses the whole recording and never touches fetch", async () => {
    const calls: RecordedResponse[] = [];
    const recorded = await generate({ fetchFn: recordingFetch(fakeFetch(), (c) => calls.push(c)) });
    expect(calls.length).toBe(3 + Math.ceil(recorded.items.length / GENERATE_DEFAULTS.relabelBatch));
    const replay = replayFetch(calls);
    const net = vi.spyOn(globalThis, "fetch");
    const replayed = await generate({ fetchFn: replay.fetchFn });
    expect(net).not.toHaveBeenCalled();
    expect(replay.unused()).toBe(0);
    expect(replayed.kept).toEqual(recorded.kept);
    expect(replayed.pile).toEqual(recorded.pile);
    expect(replayed.stats).toEqual(recorded.stats);
  });

  it("the checked-in recording is the fake models' — replaying it reproduces the fake run exactly", async () => {
    const fromRecording = await generate({ fetchFn: replayFetch(parseRecording(readFileSync(RECORDING, "utf8"), RECORDING)).fetchFn });
    const live = await generate();
    expect(fromRecording.kept).toEqual(live.kept);
    expect(fromRecording.pile).toEqual(live.pile);
  });
});

// ---- the command, end to end, offline -----------------------------------------------------------------

describe("metistry-eval generate-complexity, end to end on the recording", () => {
  const env = (): void => {
    vi.stubEnv(GEN_ENV.MODEL, FAKE_WRITER);
    vi.stubEnv(GEN_ENV.RELABEL_MODEL, FAKE_RELABELLER);
    vi.stubEnv(GEN_ENV.BASE_URL, "");
    vi.stubEnv(GEN_ENV.API_KEY, "");
  };

  it("writes the generated file, the pile and the stats report under --instance, and exits 0 when only the adjudication is left", async () => {
    env();
    const dir = mkdtempSync(join(tmpdir(), "metistry-eval-gen-"));
    const out = capture(process.stdout);
    const net = vi.spyOn(globalThis, "fetch");
    let code: number;
    try {
      code = await main(["generate-complexity", "--instance", dir, "--replay", RECORDING, "--out", join(dir, "stats.md")]);
    } finally {
      out.restore();
    }
    expect(net).not.toHaveBeenCalled();
    expect(code).toBe(0);
    const gen = join(dir, ".metistry", "eval", "complexity.generated.jsonl");
    const pile = join(dir, ".metistry", "eval", "adjudicate.jsonl");
    const loaded = loadComplexityFixtures(readFileSync(gen, "utf8"), gen);
    expect(loaded.issues).toEqual([]);
    expect(loaded.fixtures.length).toBeGreaterThanOrEqual(150);
    expect(loaded.fixtures.every((f) => f.source === "generated")).toBe(true);
    expect(readFileSync(gen, "utf8").split("\n")[0]).toMatch(/^# GENERATED by metistry-eval generate-complexity/);
    const pileLoaded = loadComplexityFixtures(readFileSync(pile, "utf8"), pile);
    expect(pileLoaded.fixtures).toEqual([]);
    expect(pileLoaded.issues.length).toBe(17);
    expect(readFileSync(join(dir, "stats.md"), "utf8")).toContain("replayed from a recording");
    expect(out.text()).toContain("to adjudicate → ");
    expect(out.text()).toContain("writer  simple    asked 56, wrote 56");
    expect(existsSync(join(dir, ".metistry", "eval", "complexity.jsonl"))).toBe(false); // the owner's file is never written
  });

  it("refuses to overwrite an existing generated file without --force — the owner may have adjudicated into it", async () => {
    env();
    const dir = mkdtempSync(join(tmpdir(), "metistry-eval-gen-"));
    const gen = join(dir, "complexity.generated.jsonl");
    writeFileSync(gen, '{"text":"synthetic kept by the owner","label":"demanding","source":"generated"}\n');
    const err = capture(process.stderr);
    try {
      expect(await main(["generate-complexity", "--fixtures", gen, "--replay", RECORDING, "--json", "--out", join(dir, "s.json")])).toBe(1);
    } finally {
      err.restore();
    }
    expect(err.text()).toMatch(/--force/);
    expect(readFileSync(gen, "utf8")).toContain("synthetic kept by the owner");
    const out = capture(process.stdout);
    try {
      expect(await main(["generate-complexity", "--fixtures", gen, "--replay", RECORDING, "--force", "--json", "--out", join(dir, "s.json")])).toBe(0);
    } finally {
      out.restore();
    }
    expect(readFileSync(gen, "utf8")).not.toContain("synthetic kept by the owner");
    expect(JSON.parse(readFileSync(join(dir, "s.json"), "utf8")).stats.ok).toBe(true);
  });

  it("refuses a Claude model, a one-family pair and a missing base URL from the command line, exit 3, before anything is written", async () => {
    const dir = mkdtempSync(join(tmpdir(), "metistry-eval-gen-"));
    const gen = join(dir, "complexity.generated.jsonl");
    const cases: Array<[Record<string, string>, RegExp, string[]]> = [
      [{ [GEN_ENV.MODEL]: "anthropic/claude-sonnet-5", [GEN_ENV.RELABEL_MODEL]: FAKE_RELABELLER }, /C11/, ["--replay", RECORDING]],
      [{ [GEN_ENV.MODEL]: FAKE_WRITER, [GEN_ENV.RELABEL_MODEL]: "google/gemini-3-pro" }, /same family/, ["--replay", RECORDING]],
      [{ [GEN_ENV.MODEL]: FAKE_WRITER, [GEN_ENV.RELABEL_MODEL]: FAKE_RELABELLER }, /METISTRY_EVAL_GEN_BASE_URL/, []],
    ];
    for (const [vars, why, extra] of cases) {
      vi.unstubAllEnvs();
      for (const k of Object.values(GEN_ENV)) vi.stubEnv(k, "");
      for (const [k, v] of Object.entries(vars)) vi.stubEnv(k, v);
      const err = capture(process.stderr);
      const net = vi.spyOn(globalThis, "fetch");
      try {
        expect(await main(["generate-complexity", "--fixtures", gen, ...extra])).toBe(3);
      } finally {
        err.restore();
      }
      expect(net).not.toHaveBeenCalled();
      expect(err.text()).toMatch(why);
      expect(existsSync(gen)).toBe(false);
    }
  });
});

// ---- the eval reads the two sets apart --------------------------------------------------------------

describe("metistry-eval complexity, on an instance with owner-written AND generated fixtures", () => {
  it("reads both files under --instance and holds them to the bar separately — never blended", async () => {
    const dir = mkdtempSync(join(tmpdir(), "metistry-eval-split-"));
    const evalDir = join(dir, ".metistry", "eval");
    mkdirSync(evalDir, { recursive: true });
    // the synthetic items the complexity recording answers, split by source: the owner's four simple + four moderate, four generated demanding
    const lines = readFileSync(join(CX, "items.jsonl"), "utf8").split("\n").filter((l) => l.startsWith("{"));
    const owner = lines.filter((l) => /"id":"[sm]/.test(l));
    const generated = lines.filter((l) => /"id":"d/.test(l)).map((l) => JSON.stringify({ ...(JSON.parse(l) as object), source: "generated" }));
    writeFileSync(join(evalDir, "complexity.jsonl"), `${owner.join("\n")}\n`);
    writeFileSync(join(evalDir, "complexity.generated.jsonl"), `${generated.join("\n")}\n`);
    writeFileSync(join(dir, ".metistry", "compute.yaml"), readFileSync(join(CX, "compute.yaml"), "utf8"));
    const out = capture(process.stdout);
    const net = vi.spyOn(globalThis, "fetch");
    let code: number;
    try {
      code = await main(["complexity", "--instance", dir, "--replay", join(CX, "recording.jsonl"), "--out", join(dir, "report.md")]);
    } finally {
      out.restore();
    }
    expect(net).not.toHaveBeenCalled();
    expect(code).toBe(1); // twelve synthetic items qualify nowhere
    const report = readFileSync(join(dir, "report.md"), "utf8");
    expect(report).toContain("12 item(s) — 8 owner-labelled, 4 generated, each scored twice");
    expect(report).toContain("## Owner-written and generated fixtures, held to the bar separately");
    expect(report).toContain("### owner — 8 item(s)");
    expect(report).toContain("### generated — 4 item(s)");
    expect(report).toMatch(/NOT A QUALIFYING RUN — neither set meets §7\.2's requirements on its own, and the two are never blended: owner NOT QUALIFYING \(no result\) \(8\) · generated NOT QUALIFYING \(no result\) \(4\)/);
    expect(out.text()).toMatch(/gen demanding/);
    expect(out.text()).toMatch(/own simple/);
  });

  it("says which file is missing when neither exists under --instance", async () => {
    const dir = mkdtempSync(join(tmpdir(), "metistry-eval-split-"));
    const err = capture(process.stderr);
    try {
      expect(await main(["complexity", "--instance", dir, "--compute", join(CX, "compute.yaml")])).toBe(1);
    } finally {
      err.restore();
    }
    expect(err.text()).toMatch(/neither complexity\.jsonl .* nor complexity\.generated\.jsonl/);
  });
});
