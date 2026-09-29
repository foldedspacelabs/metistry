#!/usr/bin/env node
// One file per ticket, generated from the approved spec
// (docs/product/design-build-plan.md §3.3), so an implement agent reads one page
// instead of the whole plan (§3.6 "Execution economics").
//
//   node ops/scripts/tickets.mjs           write docs/product/tickets/**
//   node ops/scripts/tickets.mjs --check   fail if the graph is invalid or a
//                                          ticket file has drifted from the plan
//
// What it writes:
//   docs/product/tickets/<track>/<id>.md   one ticket: frontmatter + the spec text
//   docs/product/tickets/schedule.json     waves, dependencies, sizes, models, the
//                                          critical path
//   docs/product/tickets/waves.md          the wave checklist the coordinator ticks
//
// A ticket is in exactly one wave of §3.2's table, or in its *Candidates* row:
// a follow-up the plan specifies but nobody has scheduled yet. A candidate has
// a file (`wave: candidate`) and a list of its own in waves.md; it counts in
// no wave's total and on no critical path, and no scheduled ticket may depend
// on one.
//
// The plan is the source of the ticket TEXT; the ticket file is the source of its
// STATUS. `status:` and `pr:` are the only lines an agent edits, and a rewrite
// preserves them, so regenerating never loses progress.
//
// No dependency: node's fs and path only.

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const PLAN = "docs/product/design-build-plan.md";
export const OUT = "docs/product/tickets";

/** Agent-days per size (§3.3). */
export const DAYS = { S: 1, M: 2.5, L: 5 };
/** The model per size (§3.6); design-heavy tickets are raised to Opus, high effort. */
const MODEL = { S: { model: "sonnet", effort: "default" }, M: { model: "opus", effort: "default" }, L: { model: "opus", effort: "high" } };
const HEAVY = { model: "opus", effort: "high" };
export const STATUSES = ["todo", "in-progress", "in-review", "merged", "blocked"];

const TICKET_HEAD = /^\*\*((?:F|T\d+|X)-\d+[ab]?) · (.+?)\*\* · (S|M|L)(?: · (W\d))?(?: · deps(.*?))? —\s*(.*)$/s;
const ID = /\b(?:F|T\d+|X)-\d+[ab]?\b/g;

/** Expand `F-1…F-8` and plain ids in a piece of text into a list of ids. */
export function idsIn(text, known) {
  const out = [];
  const re = /((?:F|T\d+|X)-\d+[ab]?)(?:…((?:F|T\d+|X)-\d+))?/g;
  let m;
  while ((m = re.exec(text))) {
    const [, a, b] = m;
    if (!b) {
      out.push(a);
      continue;
    }
    const prefix = a.replace(/-\d+[ab]?$/, "");
    const lo = Number(a.split("-")[1].replace(/[ab]$/, ""));
    const hi = Number(b.split("-")[1]);
    for (let i = lo; i <= hi; i++) {
      const id = `${prefix}-${i}`;
      if (!known || known.has(id)) out.push(id);
      else {
        if (known.has(`${id}a`)) out.push(`${id}a`);
        if (known.has(`${id}b`)) out.push(`${id}b`);
      }
    }
  }
  return out;
}

function section(text, start, end) {
  const a = text.indexOf(start);
  if (a === -1) throw new Error(`the plan has no "${start}"`);
  const b = text.indexOf(end, a + start.length);
  if (b === -1) throw new Error(`the plan has no "${end}" after "${start}"`);
  return text.slice(a, b);
}

/** The track a ticket belongs to: F, T1…T10, X. */
export const trackOf = (id) => id.replace(/-\d+[ab]?$/, "");

/** Parse the plan into tickets, the wave table and the design-heavy list. */
export function parsePlan(text) {
  const body = section(text, "### 3.3 The tickets", "### 3.4");
  const paragraphs = body.split(/\n\s*\n/);
  const tickets = new Map();
  const preambles = new Map(); // track heading text -> preamble paragraphs
  let trackHeading = null;
  let current = null;
  for (const para of paragraphs) {
    const p = para.trim();
    if (!p) continue;
    if (p.startsWith("#### ")) {
      trackHeading = p.slice(5).trim();
      preambles.set(trackHeading, []);
      current = null;
      continue;
    }
    const head = TICKET_HEAD.exec(p);
    if (head) {
      const [, id, title, size, wave, deps, rest] = head;
      if (tickets.has(id)) throw new Error(`ticket ${id} appears twice in the plan`);
      current = { id, title: title.trim(), size, headerWave: wave ?? null, depsText: deps ?? "", text: rest.trim(), heading: trackHeading };
      tickets.set(id, current);
      continue;
    }
    if (current) current.text += `\n\n${p}`;
    else if (trackHeading) preambles.get(trackHeading).push(p);
  }
  const known = new Set(tickets.keys());
  for (const t of tickets.values()) t.deps = [...new Set(idsIn(t.depsText, known))];

  // the wave table (§3.2) is authoritative for waves
  const waveTable = section(text, "### 3.2 Waves, ticket by ticket", "### 3.3");
  const waves = new Map();
  const candidates = [];
  for (const line of waveTable.split("\n")) {
    const m = /^\| (W\d) \| (.*) \|$/.exec(line);
    if (m) waves.set(m[1], [...new Set(idsIn(m[2], known))]);
    const c = /^\| Candidates \| (.*) \|$/.exec(line);
    if (c) candidates.push(...idsIn(c[1], known));
  }

  // design-heavy (§3.6)
  const econ = section(text, "### 3.6", "\n## ");
  const heavyLine = econ.slice(econ.indexOf("*Design-heavy*"));
  const heavy = new Set(idsIn(heavyLine.split("\n\n")[0], known));

  return { tickets, preambles, waves, candidates: [...new Set(candidates)], heavy };
}

/** Every problem with the graph, as sentences. Empty = valid. */
export function validate({ tickets, waves, candidates = [] }) {
  const problems = [];
  const waveOf = new Map();
  const candidate = new Set(candidates);
  for (const [w, ids] of waves) {
    for (const id of ids) {
      if (!tickets.has(id)) problems.push(`${w} lists ${id}, which is not a ticket`);
      else if (waveOf.has(id)) problems.push(`${id} is in both ${waveOf.get(id)} and ${w}`);
      else waveOf.set(id, w);
    }
  }
  for (const id of candidate) {
    if (!tickets.has(id)) problems.push(`Candidates lists ${id}, which is not a ticket`);
    else if (waveOf.has(id)) problems.push(`${id} is in ${waveOf.get(id)} and also a candidate`);
  }
  const n = (w) => Number(w.slice(1));
  for (const t of tickets.values()) {
    const w = waveOf.get(t.id);
    if (!w && !candidate.has(t.id)) problems.push(`${t.id} is in no wave`);
    if (candidate.has(t.id) && t.headerWave) problems.push(`${t.id} is a candidate but its heading says ${t.headerWave}`);
    if (w) for (const d of t.deps) if (candidate.has(d)) problems.push(`${t.id} (${w}) depends on ${d}, which is only a candidate`);
    const expected = t.headerWave ?? (t.id.startsWith("F-") ? "W0" : null);
    if (w && expected && expected !== w) problems.push(`${t.id} says ${expected} but the wave table puts it in ${w}`);
    for (const d of t.deps) {
      if (!tickets.has(d)) problems.push(`${t.id} depends on ${d}, which is not a ticket`);
      else if (w && waveOf.get(d) && n(waveOf.get(d)) > n(w)) problems.push(`${t.id} (${w}) depends on ${d}, which lands later (${waveOf.get(d)})`);
    }
  }
  // cycles
  const state = new Map();
  const visit = (id, stack) => {
    if (state.get(id) === "done") return;
    if (state.get(id) === "open") {
      problems.push(`a dependency cycle: ${[...stack, id].join(" → ")}`);
      return;
    }
    state.set(id, "open");
    for (const d of tickets.get(id)?.deps ?? []) if (tickets.has(d)) visit(d, [...stack, id]);
    state.set(id, "done");
  };
  for (const id of tickets.keys()) visit(id, []);
  return { problems, waveOf };
}

/** The longest chain of agent-days through the dependency graph. */
export function criticalPath(tickets) {
  const memo = new Map();
  const via = new Map();
  const finish = (id) => {
    if (memo.has(id)) return memo.get(id);
    const t = tickets.get(id);
    let start = 0;
    for (const d of t.deps) {
      if (!tickets.has(d)) continue;
      const f = finish(d);
      if (f > start) {
        start = f;
        via.set(id, d);
      }
    }
    const f = start + DAYS[t.size];
    memo.set(id, f);
    return f;
  };
  let best = null;
  let days = 0;
  for (const id of tickets.keys()) {
    const f = finish(id);
    if (f > days) {
      days = f;
      best = id;
    }
  }
  const path = [];
  for (let c = best; c; c = via.get(c)) path.unshift(c);
  return { days, path };
}

const fileOf = (id) => join(OUT, trackOf(id).toLowerCase(), `${id.toLowerCase()}.md`);

function frontmatter(existing) {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(existing ?? "");
  const out = {};
  if (!m) return out;
  for (const line of m[1].split("\n")) {
    const kv = /^(\w+):\s*(.*)$/.exec(line);
    if (kv) out[kv[1]] = kv[2];
  }
  return out;
}

/** Render one ticket file. `keep` carries the status and pr of the file on disk. */
export function renderTicket(t, { wave, model, preamble, keep }) {
  const sections = [...new Set(([t.text, ...preamble].join("\n").match(/§2\.\d+/g) ?? []))];
  const status = STATUSES.includes(keep?.status) ? keep.status : "todo";
  const pr = keep?.pr && keep.pr !== "" ? keep.pr : "null";
  const lines = [
    "---",
    `id: ${t.id}`,
    `title: ${JSON.stringify(t.title)}`,
    `track: ${trackOf(t.id)}`,
    `wave: ${wave}`,
    `size: ${t.size}`,
    `days: ${DAYS[t.size]}`,
    `model: ${model.model}`,
    `effort: ${model.effort}`,
    `deps: [${t.deps.join(", ")}]`,
    `status: ${status}`,
    `pr: ${pr}`,
    "---",
    "",
    `# ${t.id} · ${t.title}`,
    "",
    `Generated from \`${PLAN}\` §3.3 by \`ops/scripts/tickets.mjs\` — edit the plan, not this file; only \`status:\` and \`pr:\` are yours.`,
    "",
    `**Read first:** \`docs/ops/agent-brief.md\`${sections.length ? `, then ${sections.join(", ")} of \`${PLAN}\`` : ""}.`,
    `**Run as:** ${model.model}, ${model.effort === "high" ? "high effort" : "default effort"} · **Size:** ${t.size} (${DAYS[t.size]} agent-days) · **Wave:** ${wave === "candidate" ? "none yet (a W4 candidate)" : wave} · **Depends on:** ${t.deps.length ? t.deps.join(", ") : "nothing"}`,
    "",
  ];
  if (preamble.length) lines.push("## Rules for this track", "", ...preamble.flatMap((p) => [p, ""]));
  lines.push("## The ticket", "", t.text, "");
  return lines.join("\n");
}

/** Everything the generator would write, keyed by repo-relative path. */
export function build(root = ROOT) {
  const plan = parsePlan(readFileSync(join(root, PLAN), "utf8"));
  const { problems, waveOf } = validate(plan);
  const candidate = new Set(plan.candidates);
  const files = new Map();
  const schedule = { generated_from: PLAN, waves: {}, tickets: {}, totals: {}, critical_path: null };
  for (const t of plan.tickets.values()) {
    const wave = waveOf.get(t.id) ?? (candidate.has(t.id) ? "candidate" : (t.headerWave ?? "W?"));
    const model = plan.heavy.has(t.id) ? HEAVY : MODEL[t.size];
    const path = fileOf(t.id);
    const existing = existsSync(join(root, path)) ? readFileSync(join(root, path), "utf8") : null;
    const keep = frontmatter(existing);
    files.set(path, renderTicket(t, { wave, model, preamble: plan.preambles.get(t.heading) ?? [], keep }));
    schedule.tickets[t.id] = { title: t.title, track: trackOf(t.id), wave, size: t.size, days: DAYS[t.size], model: model.model, effort: model.effort, deps: t.deps, file: path, status: STATUSES.includes(keep.status) ? keep.status : "todo" };
  }
  let total = 0;
  for (const [w, ids] of plan.waves) {
    const days = ids.reduce((s, id) => s + (plan.tickets.has(id) ? DAYS[plan.tickets.get(id).size] : 0), 0);
    schedule.waves[w] = { tickets: ids, count: ids.length, agent_days: days };
    total += days;
  }
  const scheduled = new Map([...plan.tickets].filter(([id]) => !candidate.has(id)));
  const candidateDays = plan.candidates.reduce((s, id) => s + (plan.tickets.has(id) ? DAYS[plan.tickets.get(id).size] : 0), 0);
  schedule.candidates = { tickets: plan.candidates, count: plan.candidates.length, agent_days: candidateDays };
  schedule.totals = { tickets: scheduled.size, agent_days: total, waves: plan.waves.size, candidates: plan.candidates.length };
  schedule.critical_path = criticalPath(scheduled);
  files.set(join(OUT, "schedule.json"), `${JSON.stringify(schedule, null, 2)}\n`);

  const check = [
    "# The wave schedule — a checklist",
    "",
    `Generated from \`${PLAN}\` by \`ops/scripts/tickets.mjs\`. A ticket is ticked when its file says \`status: merged\`; the coordinator ticks each checkpoint (§3.1) by hand below the generated list.`,
    "",
    `**${schedule.totals.tickets} tickets · ${schedule.totals.waves} waves · ≈ ${total} agent-days · critical path ${schedule.critical_path.days} agent-days** (${schedule.critical_path.path.join(" → ")})`,
    "",
  ];
  const line = (id) => {
    const t = schedule.tickets[id];
    return `- [${t.status === "merged" ? "x" : " "}] [${id}](${relative(OUT, t.file)}) · ${t.title} · ${t.size} · ${t.model}${t.effort === "high" ? " high" : ""}${t.deps.length ? ` · after ${t.deps.join(", ")}` : ""}${t.status !== "todo" && t.status !== "merged" ? ` · **${t.status}**` : ""}`;
  };
  for (const [w, ids] of plan.waves) {
    check.push(`## ${w} — ${schedule.waves[w].count} tickets, ${schedule.waves[w].agent_days} agent-days`, "");
    const known = ids.filter((id) => schedule.tickets[id]);
    for (const id of known) check.push(line(id));
    // A wave under way names what its checkpoint still waits on.
    const open = known.filter((id) => schedule.tickets[id].status !== "merged");
    const waiting = open.length && open.length < known.length ? ` · waiting on ${open.map((id) => `${id} (${schedule.tickets[id].status})`).join(", ")}` : "";
    check.push("", `- [ ] **${w} checkpoint** — merged, main green, scratch-instance upgrade, conformance test, Mac smoke, release${waiting}`, "");
  }
  if (plan.candidates.length) {
    check.push(
      `## W4 candidates — ${schedule.candidates.count} tickets, ${candidateDays} agent-days, no wave yet`,
      "",
      "Follow-ups specified in the plan (§3.2's *Candidates* row) that nobody has scheduled. The owner assigns each one a wave at a checkpoint; until then none is dispatched.",
      "",
      ...plan.candidates.filter((id) => schedule.tickets[id]).map(line),
      "",
    );
  }
  files.set(join(OUT, "waves.md"), check.join("\n"));
  return { files, problems, schedule };
}

/** Ticket files on disk that the plan no longer has. */
function strays(root, files) {
  const dir = join(root, OUT);
  if (!existsSync(dir)) return [];
  const out = [];
  for (const track of readdirSync(dir, { withFileTypes: true })) {
    if (!track.isDirectory()) continue;
    for (const f of readdirSync(join(dir, track.name))) {
      const p = join(OUT, track.name, f);
      if (f.endsWith(".md") && !files.has(p)) out.push(p);
    }
  }
  return out;
}

/** `--check`: the graph is valid and every file matches what would be written (status and pr aside). */
export function check(root = ROOT) {
  const { files, problems } = build(root);
  const drift = [];
  const strip = (s) => s.replace(/^status: .*$/m, "").replace(/^pr: .*$/m, "").replace(/^- \[[ x]\]/gm, "- [ ]").replace(/ · \*\*(?:in-progress|in-review|blocked)\*\*/g, "").replace(/ · waiting on .*$/gm, "").replace(/"status": "[a-z-]+"/g, "");
  for (const [path, content] of files) {
    const full = join(root, path);
    if (!existsSync(full)) drift.push(`${path} is missing — run: node ops/scripts/tickets.mjs`);
    else if (strip(readFileSync(full, "utf8")) !== strip(content)) drift.push(`${path} has drifted from the plan — run: node ops/scripts/tickets.mjs`);
  }
  for (const p of strays(root, files)) drift.push(`${p} is not a ticket in the plan — remove it`);
  return [...problems, ...drift];
}

function main() {
  if (process.argv.includes("--check")) {
    const problems = check();
    if (problems.length) {
      for (const p of problems) console.error(`tickets: ${p}`);
      process.exit(1);
    }
    const { schedule } = build();
    console.log(`tickets: ok (${schedule.totals.tickets} tickets${schedule.totals.candidates ? ` + ${schedule.totals.candidates} candidates` : ""}, ${schedule.totals.waves} waves, ≈ ${schedule.totals.agent_days} agent-days, critical path ${schedule.critical_path.days})`);
    return;
  }
  const { files, problems, schedule } = build();
  if (problems.length) {
    for (const p of problems) console.error(`tickets: ${p}`);
    process.exit(1);
  }
  for (const p of strays(ROOT, files)) rmSync(join(ROOT, p));
  for (const [path, content] of files) {
    mkdirSync(dirname(join(ROOT, path)), { recursive: true });
    writeFileSync(join(ROOT, path), content);
  }
  console.log(`tickets: wrote ${schedule.totals.tickets} tickets${schedule.totals.candidates ? ` + ${schedule.totals.candidates} candidates` : ""}, schedule.json and waves.md (${schedule.totals.waves} waves, ≈ ${schedule.totals.agent_days} agent-days, critical path ${schedule.critical_path.days})`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
