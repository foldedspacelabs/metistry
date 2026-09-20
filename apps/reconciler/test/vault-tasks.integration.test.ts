// The task pass against the real (scratch) database (daily-flow-spec §1.5,
// ticket P1-4). Only Postgres can prove the identity rules — a field edit
// that keeps a key and a text edit that does not, `first_seen_on` surviving
// a re-walk, `done_on` dated once and never again, the duplicate link, the
// recurrence instance — because every one of them is an `ON CONFLICT`
// clause or a pass over the whole table. Skipped without a db.
import { randomUUID } from "node:crypto";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { addTaskDays, taskToday } from "@foldedspacelabs/metistry-core";
import { Committer } from "../src/committer.js";
import { Vault } from "../src/vault.js";
import { Indexer } from "../src/indexer.js";
import { tempRepo, type TempRepo } from "./helpers.js";
import { loadTestEnv } from "@foldedspacelabs/metistry-core/test-env";

const { hasDb } = loadTestEnv(new URL("../../../.env", import.meta.url)); // METISTRY_DB_* only (docs/ops/testing.md)

// TitleCase, because the fixture lives under `Areas/<marker>/` and the area
// a note derives from its own location has to be a real vault prefix
// (`validAreaPrefix`) — a lowercase marker would quietly make every
// `area` assertion in here null.
const MARKER = `Itest${randomUUID().replace(/-/g, "").slice(0, 8)}`;
const PREFIX = `Areas/${MARKER}/`;
const PLAN = "Journal/Plan/2026-09-20.md";

// This suite takes the database, exactly as `indexer.integration.test.ts`
// does and for the same reason (docs/ops/testing.md, "Take the database"):
// `syncTasks` reads `vault_tasks` UNSCOPED to compute what vanished — it
// owns the table, invariant 1 — so a leftover row from anywhere else is not
// noise here, it is a row this suite would delete and then miscount.
// `apps/reconciler/vitest.config.ts` runs this package's files one at a
// time, which is what makes that safe.
describe.skipIf(!hasDb)("the vault's tasks are indexed from the walk (real db)", () => {
  let pool: pg.Pool;
  let repo: TempRepo;
  let indexer: Indexer;
  let today: string;

  const clean = async () => {
    // in the order the walk itself takes them — two orders on two paths is
    // how #207's deadlock happened
    await pool.query(`DELETE FROM vault_tasks`);
    await pool.query(`DELETE FROM vault_task_refs`);
    await pool.query(`DELETE FROM work WHERE title LIKE 'itest %'`);
    await pool.query(`DELETE FROM knowledge_links`);
    await pool.query(`DELETE FROM knowledge_files`);
    await pool.query(`DELETE FROM runs WHERE component = 'reconciler'`);
  };

  /** Every column of one row, dates as text — `date` through node-pg is a JS Date at the process's local midnight, which is a day's drift waiting to happen. */
  const taskAt = async (path: string, line: number) =>
    (
      await pool.query(
        `SELECT path, task_key, anchor, line_no, text, text_norm, checked, dropped, waiting,
                due::text AS due, scheduled_for::text AS scheduled_for, start_on::text AS start_on,
                done_on::text AS done_on, done_on_observed, priority, size, type, assigned, project, area,
                recur_rule, recur_next::text AS recur_next, recur_parent, source, ext_refs, work_id,
                duplicate_of, parse_warning, parsed_on::text AS parsed_on, first_seen_on::text AS first_seen_on
           FROM vault_tasks WHERE path = $1 AND line_no = $2`,
        [path, line],
      )
    ).rows[0];

  const keysIn = async (path: string) =>
    (await pool.query(`SELECT task_key FROM vault_tasks WHERE path = $1 ORDER BY line_no`, [path])).rows.map((r) => String(r.task_key));

  const write = async (rel: string, lines: string[]) => {
    const abs = join(repo.root, rel);
    await mkdir(abs.slice(0, abs.lastIndexOf("/")), { recursive: true });
    await writeFile(abs, `${lines.join("\n")}\n`);
  };

  beforeAll(async () => {
    pool = new pg.Pool({
      host: process.env.METISTRY_DB_HOST ?? "127.0.0.1",
      port: Number(process.env.METISTRY_DB_PORT ?? 5432),
      user: process.env.METISTRY_DB_USER ?? "metistry",
      database: process.env.METISTRY_TEST_DB_NAME ?? "metistry_test", // scratch db (ops/scripts/test-db.sh)
      password: process.env.METISTRY_DB_PASSWORD,
    });
    await clean();
    repo = await tempRepo(MARKER);
    const committer = new Committer(repo.git, { authorPrefix: "Metistry", authorEmail: "metistry@test" });
    const vault = new Vault(repo.root, repo.git, committer, { maxBytes: 65536 });
    indexer = new Indexer(pool, vault, committer, { commitExternalEdits: false });
    today = taskToday();
  });
  afterAll(async () => {
    await repo.cleanup();
    await clean();
    await pool.end();
  });

  it("parses every field of a task line into a row, and nothing that is not a task", async () => {
    await write("People/Jim Fallon.md", ["# Jim Fallon"]);
    await write(`${PREFIX}Tasks.md`, [
      "---", //                                                              1
      "title: Tasks", //                                                     2
      'area: "[[Areas/Work]]"', //                                           3
      "---", //                                                              4
      "# Tasks", //                                                          5
      "", //                                                                 6
      "- [ ] Draft the Q4 plan due 2026-09-30 p1 size l type planning +drey ^mt-7x2k9abc", // 7
      "- [ ] Send Jim the brand deck @[[Jim Fallon]] waiting do 2026-09-22 start 2026-09-21 linear:ABC-123 gh:o/r#4 work:418 source meeting:Journal/Meetings/2026-09-18-q4.md", // 8
      "- [x] Post the notes done 2026-09-19", //                             9
      "- [ ] Book the venue due nextweek", //                               10
      "- [ ] Ask @Jim about the pricing deck", //                           11
      "", //                                                                12
      "```", //                                                             13
      "- [ ] an example in a code fence is documentation", //                14
      "```", //                                                             15
    ]);
    const s = await indexer.reconcile("test");
    expect(s.tasks).toMatchObject({ files: 1, rows: 5, added: 5, removed: 0 });

    expect(await taskAt(`${PREFIX}Tasks.md`, 7)).toEqual({
      path: `${PREFIX}Tasks.md`,
      task_key: "mt-7x2k9abc", // §2.1: with an anchor, the key IS the anchor
      anchor: "mt-7x2k9abc",
      line_no: 7, // the line in the FILE, frontmatter counted
      text: "Draft the Q4 plan",
      text_norm: "draft the q4 plan",
      checked: false,
      dropped: false,
      waiting: false,
      due: "2026-09-30",
      scheduled_for: null,
      start_on: null,
      done_on: null,
      done_on_observed: false,
      priority: 1,
      size: "L",
      type: "planning",
      assigned: null,
      project: "drey",
      area: "Areas/Work", // the note's frontmatter wins over its location
      recur_rule: null,
      recur_next: null,
      recur_parent: null,
      source: null, // a hand-typed line has no provenance, and none is invented
      ext_refs: [],
      work_id: null,
      duplicate_of: null,
      parse_warning: null,
      parsed_on: today,
      first_seen_on: today,
    });

    const delegated = await taskAt(`${PREFIX}Tasks.md`, 8);
    expect(delegated).toMatchObject({
      task_key: expect.stringMatching(/^h:[0-9a-f]{64}:0$/),
      anchor: null,
      text: "Send Jim the brand deck",
      waiting: true,
      scheduled_for: "2026-09-22",
      start_on: "2026-09-21",
      assigned: "People/Jim Fallon.md", // resolved against the vault, not stored on the line
      ext_refs: ["linear:ABC-123", "gh:o/r#4"],
      work_id: "418", // bigint, and node-pg hands those back as text rather than lose precision
      source: "meeting:Journal/Meetings/2026-09-18-q4.md",
      parse_warning: null,
    });

    // an explicit `done` is the user's date and says so
    expect(await taskAt(`${PREFIX}Tasks.md`, 9)).toMatchObject({ checked: true, done_on: "2026-09-19", done_on_observed: false });
    // §1.4: a field Metistry cannot read is flagged, never guessed
    expect(await taskAt(`${PREFIX}Tasks.md`, 10)).toMatchObject({ due: null, parse_warning: expect.stringContaining("due nextweek") });
    // the trailing-run rule: `deck` is not a field, so `@Jim` never assigns
    expect(await taskAt(`${PREFIX}Tasks.md`, 11)).toMatchObject({ text: "Ask @Jim about the pricing deck", assigned: null });
    // a fenced block is documentation, not a todo list
    expect((await pool.query(`SELECT count(*)::int AS n FROM vault_tasks WHERE text LIKE '%code fence%'`)).rows[0].n).toBe(0);
    // and nothing in the walk's other fixtures invented a task
    expect((await pool.query(`SELECT count(*)::int AS n FROM vault_tasks`)).rows[0].n).toBe(5);
  });

  it("derives the project from a note's folder and the area from its own location", async () => {
    await write("Projects/Drey/Plan.md", ["- [ ] Ship the rebrand"]);
    await write(`${PREFIX}Loose.md`, ["- [ ] Sweep the yard"]);
    await indexer.reconcile("test");
    expect(await taskAt("Projects/Drey/Plan.md", 1)).toMatchObject({ project: "drey", area: "Projects/Drey" });
    expect(await taskAt(`${PREFIX}Loose.md`, 1)).toMatchObject({ project: null, area: `Areas/${MARKER}` });
  });

  it("a field edit keeps the key and `first_seen_on`; a text edit mints a new key and starts the clock again", async () => {
    await pool.query(`UPDATE vault_tasks SET first_seen_on = '2026-01-05' WHERE path = $1`, [`${PREFIX}Loose.md`]);
    const before = (await keysIn(`${PREFIX}Loose.md`))[0]!;

    await write(`${PREFIX}Loose.md`, ["- [ ] Sweep the yard due 2026-10-01 p2"]);
    await indexer.reconcile("test");
    const sameLine = await taskAt(`${PREFIX}Loose.md`, 1);
    expect(sameLine.task_key).toBe(before); // the fields moved; the identity did not
    expect(sameLine).toMatchObject({ due: "2026-10-01", priority: 2, first_seen_on: "2026-01-05" });

    await write(`${PREFIX}Loose.md`, ["- [ ] Sweep the yard and the porch due 2026-10-01 p2"]);
    await indexer.reconcile("test");
    const retyped = await taskAt(`${PREFIX}Loose.md`, 1);
    expect(retyped.task_key).not.toBe(before);
    expect(retyped).toMatchObject({ text: "Sweep the yard and the porch", first_seen_on: today }); // a new line, a new clock
    expect(await keysIn(`${PREFIX}Loose.md`)).toEqual([retyped.task_key]); // and the old row is gone
  });

  it("ticking a box dates it once — the first walk that sees `[x]`, and never again", async () => {
    await write(`${PREFIX}Done.md`, ["- [ ] Renew the licence"]);
    await indexer.reconcile("test");
    expect(await taskAt(`${PREFIX}Done.md`, 1)).toMatchObject({ checked: false, done_on: null, done_on_observed: false });

    await write(`${PREFIX}Done.md`, ["- [x] Renew the licence"]);
    await indexer.reconcile("test");
    expect(await taskAt(`${PREFIX}Done.md`, 1)).toMatchObject({ checked: true, done_on: today, done_on_observed: true });

    // a later walk must not re-date it: backdate the observation, edit the
    // note so the pass genuinely re-derives the row, and it stays put
    await pool.query(`UPDATE vault_tasks SET done_on = '2026-02-02' WHERE path = $1`, [`${PREFIX}Done.md`]);
    await write(`${PREFIX}Done.md`, ["- [x] Renew the licence", "", "a note about it"]);
    await indexer.reconcile("test");
    expect(await taskAt(`${PREFIX}Done.md`, 1)).toMatchObject({ done_on: "2026-02-02", done_on_observed: true });

    // and un-ticking it clears the observation rather than leaving a lie
    await write(`${PREFIX}Done.md`, ["- [ ] Renew the licence", "", "a note about it"]);
    await indexer.reconcile("test");
    expect(await taskAt(`${PREFIX}Done.md`, 1)).toMatchObject({ checked: false, done_on: null, done_on_observed: false });
  });

  it("two identical lines in one note are two rows, told apart by their ordinal", async () => {
    await write(`${PREFIX}Twice.md`, ["- [ ] Call the dentist", "- [ ] Call the dentist due 2026-10-02"]);
    await indexer.reconcile("test");
    const keys = await keysIn(`${PREFIX}Twice.md`);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toMatch(/:0$/);
    expect(keys[1]).toMatch(/:1$/);
    expect(keys[0]!.slice(0, -2)).toBe(keys[1]!.slice(0, -2)); // same text hash, different ordinal
    expect(await taskAt(`${PREFIX}Twice.md`, 2)).toMatchObject({ due: "2026-10-02" });
  });

  it("the same line in two notes is two rows, and the later-seen one points at the earlier", async () => {
    await write(`${PREFIX}A-first.md`, ["- [ ] Book the follow-up"]);
    await write(`${PREFIX}Z-second.md`, ["- [ ] Book the follow-up"]);
    await indexer.reconcile("test");

    // seen on the same day, byte order decides — the same answer on a macOS
    // cluster and a Linux one
    expect(await taskAt(`${PREFIX}A-first.md`, 1)).toMatchObject({ duplicate_of: null });
    const later = await taskAt(`${PREFIX}Z-second.md`, 1);
    expect(later.duplicate_of).toBe((await taskAt(`${PREFIX}A-first.md`, 1)).task_key);

    // …but `first_seen_on` decides first: age the other one and the pair flips
    await pool.query(`UPDATE vault_tasks SET first_seen_on = '2026-03-03' WHERE path = $1`, [`${PREFIX}Z-second.md`]);
    await indexer.reconcile("test");
    expect(await taskAt(`${PREFIX}Z-second.md`, 1)).toMatchObject({ duplicate_of: null });
    expect((await taskAt(`${PREFIX}A-first.md`, 1)).duplicate_of).toBe(later.task_key);

    // closing one settles the group: a duplicate is only a duplicate while both are open
    await write(`${PREFIX}A-first.md`, ["- [x] Book the follow-up"]);
    await indexer.reconcile("test");
    expect(await taskAt(`${PREFIX}A-first.md`, 1)).toMatchObject({ duplicate_of: null });
    expect(await taskAt(`${PREFIX}Z-second.md`, 1)).toMatchObject({ duplicate_of: null });
  });

  it("a machine file's rendered list is never a task, and its transclusion is still a reference", async () => {
    await write(PLAN, [
      "---",
      "source: plan-tomorrow",
      "---",
      "# Tomorrow",
      "",
      `- [ ] Draft the Q4 plan due 2026-09-30 p1 ^mt-7x2k9abc`,
      `![[${PREFIX}Tasks#^mt-7x2k9abc]]`,
    ]);
    await indexer.reconcile("test");
    expect((await pool.query(`SELECT count(*)::int AS n FROM vault_tasks WHERE path = $1`, [PLAN])).rows[0].n).toBe(0);
    expect((await pool.query(`SELECT from_path, to_path, anchor, kind FROM vault_task_refs WHERE from_path = $1`, [PLAN])).rows).toEqual([
      { from_path: PLAN, to_path: `${PREFIX}Tasks.md`, anchor: "mt-7x2k9abc", kind: "embed" },
    ]);
    // the one canonical row still belongs to the note the user typed it in
    expect((await pool.query(`SELECT path FROM vault_tasks WHERE anchor = 'mt-7x2k9abc'`)).rows).toEqual([{ path: `${PREFIX}Tasks.md` }]);
  });

  it("a `Templates/` file describes tasks and holds none", async () => {
    await write("Templates/Mine.md", ["---", "source: user", "---", "- [ ] {{ example }}", "- [ ] Water the plants every week"]);
    await indexer.reconcile("test");
    expect((await pool.query(`SELECT count(*)::int AS n FROM vault_tasks WHERE path LIKE 'Templates/%'`)).rows[0].n).toBe(0);
  });

  it("a `^mt-` reference in another note becomes a ref row, and goes when the reference does", async () => {
    await write(`${PREFIX}Notes.md`, [`Waiting on [[${PREFIX}Tasks#^mt-7x2k9abc]] before the review.`]);
    await indexer.reconcile("test");
    expect((await pool.query(`SELECT to_path, anchor, kind FROM vault_task_refs WHERE from_path = $1`, [`${PREFIX}Notes.md`])).rows).toEqual([
      { to_path: `${PREFIX}Tasks.md`, anchor: "mt-7x2k9abc", kind: "wikilink" },
    ]);

    await write(`${PREFIX}Notes.md`, ["Nothing to wait on now."]);
    await indexer.reconcile("test");
    expect((await pool.query(`SELECT count(*)::int AS n FROM vault_task_refs WHERE from_path = $1`, [`${PREFIX}Notes.md`])).rows[0].n).toBe(0);
  });

  it("a `work` row that names a human todo gets a ref row — and the work row is never touched", async () => {
    const ins = await pool.query(
      `INSERT INTO work (title, kind, status, meta) VALUES ('itest blocked', 'task', 'open', $1::jsonb) RETURNING id`,
      [JSON.stringify({ blocked_by: `vault:${PREFIX}Tasks.md#^mt-7x2k9abc` })],
    );
    const id = String(ins.rows[0].id);
    await indexer.reconcile("test");
    expect((await pool.query(`SELECT from_path, to_path, anchor, kind FROM vault_task_refs WHERE from_path = $1`, [`work:${id}`])).rows).toEqual([
      { from_path: `work:${id}`, to_path: `${PREFIX}Tasks.md`, anchor: "mt-7x2k9abc", kind: "blocked_by" },
    ]);
    // it surfaces and never gates: nothing about the row itself moved
    expect((await pool.query(`SELECT status, depends_on, meta FROM work WHERE id = $1`, [id])).rows[0]).toEqual({
      status: "open",
      depends_on: [],
      meta: { blocked_by: `vault:${PREFIX}Tasks.md#^mt-7x2k9abc` },
    });

    await pool.query(`DELETE FROM work WHERE id = $1`, [id]);
    await indexer.reconcile("test");
    expect((await pool.query(`SELECT count(*)::int AS n FROM vault_task_refs WHERE from_path = $1`, [`work:${id}`])).rows[0].n).toBe(0);
  });

  it("a recurrence rule is not a task, its instance points back at it, and closing one moves the rule on", async () => {
    await write(`${PREFIX}Routines.md`, ["- [ ] Water the plants every week"]);
    await indexer.reconcile("test");
    const rule = await taskAt(`${PREFIX}Routines.md`, 1);
    expect(rule).toMatchObject({ recur_rule: "every week", recur_next: today, recur_parent: null, text: "Water the plants" });

    await write(`${PREFIX}Daily.md`, ["- [ ] Water the plants source template:recurring"]);
    await indexer.reconcile("test");
    expect(await taskAt(`${PREFIX}Daily.md`, 1)).toMatchObject({ recur_parent: rule.task_key, source: "template:recurring", recur_rule: null });
    // still open: the rule keeps falling due, so §4's carry-over line can render
    expect(await taskAt(`${PREFIX}Routines.md`, 1)).toMatchObject({ recur_next: today });

    await write(`${PREFIX}Daily.md`, ["- [x] Water the plants source template:recurring"]);
    await indexer.reconcile("test");
    expect(await taskAt(`${PREFIX}Routines.md`, 1)).toMatchObject({ recur_next: addTaskDays(today, 7) });
  });

  it("a deleted note takes its rows with it", async () => {
    await unlink(join(repo.root, `${PREFIX}Twice.md`));
    const s = await indexer.reconcile("test");
    expect(s.tasks.removed).toBe(2);
    expect(await keysIn(`${PREFIX}Twice.md`)).toEqual([]);
  });

  it("rebuilds every row from the vault after both tables are emptied (invariant 1)", async () => {
    const before = (await pool.query(`SELECT path, task_key, text, due::text AS due, priority FROM vault_tasks ORDER BY path COLLATE "C", line_no`)).rows;
    const refsBefore = (await pool.query(`SELECT from_path, to_path, anchor, kind FROM vault_task_refs ORDER BY from_path COLLATE "C", anchor`)).rows;
    expect(before.length).toBeGreaterThan(5);

    await pool.query(`DELETE FROM vault_task_refs`);
    await pool.query(`DELETE FROM vault_tasks`);
    const s = await indexer.reconcile("test"); // not one note changed; the tables did
    expect(s.tasks.added).toBe(before.length);

    expect((await pool.query(`SELECT path, task_key, text, due::text AS due, priority FROM vault_tasks ORDER BY path COLLATE "C", line_no`)).rows).toEqual(before);
    expect((await pool.query(`SELECT from_path, to_path, anchor, kind FROM vault_task_refs ORDER BY from_path COLLATE "C", anchor`)).rows).toEqual(refsBefore);
  });
});
