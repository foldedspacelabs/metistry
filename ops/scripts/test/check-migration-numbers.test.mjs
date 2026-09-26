// ops/scripts/check-migration-numbers.mjs, three ways: its exports against a
// small hand-written table (what is reserved, what is refused), the script as a
// child process against a throwaway tree (what CI runs), and real git merges
// in a throwaway repo (the acceptance: two agents cannot pick the same number).
// Nothing here reads the environment or reaches a database.
//
// Run: node --test ops/scripts/test/

import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { checkMigrationNumbers, parseReservedTable, run } from "../check-migration-numbers.mjs";

const scriptSrc = fileURLToPath(new URL("../check-migration-numbers.mjs", import.meta.url));
const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));

/ 0001–0003 are history; 0004 and 0005 are reserved; 0006 is spare. */
const README = `# db/migrations

prose

## Reserved numbers

| # | File | What | Durability | Ticket |
| --- | --- | --- | --- | --- |
| 0004 | \`alpha.sql\` | a | durable | T1-1 |
| 0005 | \`beta.sql\` | b | derived | T1-2 |
| 0006 | — | spare | | |

## After
`;
const HISTORY = ["0001_init.sql", "0002_two.sql", "0003_three.sql"];

const rowsOf = (text) => {
  const { rows, errors } = parseReservedTable(text);
  assert.deepEqual(errors, []);
  return rows;
};
const check = (names, text = README) => checkMigrationNumbers(names, rowsOf(text));
const errorsOf = (text) => parseReservedTable(text).errors;

// ---- the table ------------------------------------------------------------------

test("the table parses to one row per number, with the full filename and the ticket", () => {
  assert.deepEqual(rowsOf(README), [
    { number: 4, file: "0004_alpha.sql", ticket: "T1-1", line: 9 },
    { number: 5, file: "0005_beta.sql", ticket: "T1-2", line: 10 },
    { number: 6, file: null, ticket: "", line: 11 },
  ]);
});

test("history, the reserved files present or not yet written: all pass", () => {
  assert.deepEqual(check(HISTORY), []);
  assert.deepEqual(check([...HISTORY, "0004_alpha.sql"]), []);
  assert.deepEqual(check([...HISTORY, "0004_alpha.sql", "0005_beta.sql"]), []);
});

// ---- the refusals (the ticket's Tests line) ---------------------------------------

test("an unreserved number fails — a number past the last row", () => {
  const problems = check([...HISTORY, "0007_gamma.sql"]);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /^db\/migrations\/0007_gamma\.sql: 0007 is not reserved — add its row to db\/migrations\/README\.md/);
});

test("an unreserved number fails — a spare row is not yet anyone's, until the PR claims it", () => {
  const problems = check([...HISTORY, "0006_gamma.sql"]);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /0006 is spare — claim it by writing "gamma\.sql" and your ticket into its row/);
  const claimed = README.replace("| 0006 | — | spare | | |", "| 0006 | `gamma.sql` | g | durable | T1-3 |");
  assert.deepEqual(check([...HISTORY, "0006_gamma.sql"], claimed), []);
});

test("another ticket's number fails — a reserved number admits exactly its own file", () => {
  const problems = check([...HISTORY, "0004_something_else.sql"]);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /0004_something_else\.sql: 0004 is reserved to 0004_alpha\.sql \(T1-1\)/);
});

test("two files on one number fail — in history and in the table", () => {
  // the 0023/0024 story: a second file written onto a number already shipped
  const inHistory = check([...HISTORY, "0003_vault_tasks.sql"]);
  assert.deepEqual(inHistory, ["db/migrations: 0003 has 2 files (0003_three.sql, 0003_vault_tasks.sql) — one number, one file"]);
  const inTable = check([...HISTORY, "0004_alpha.sql", "0004_other.sql"]);
  assert.equal(inTable.length, 2); // the stranger is refused, and the number is flagged as doubled
  assert.match(inTable.join("\n"), /0004 is reserved to 0004_alpha\.sql/);
  assert.match(inTable.join("\n"), /0004 has 2 files/);
});

test("history has no free number — a gap below the table fails, so a deleted migration is caught", () => {
  assert.deepEqual(check(["0001_init.sql", "0003_three.sql"]), [
    "db/migrations: 0002 has no file — history below the reserved table (0001–0003) has no gaps; a shipped migration is never deleted or renumbered",
  ]);
});

test("a malformed name fails — casing, separators, 0000", () => {
  for (const bad of ["0004_Alpha.sql", "0004-alpha.sql", "004_alpha.sql", "0000_zero.sql", "0004_alpha.SQL"]) {
    const problems = check([...HISTORY, bad]);
    assert.ok(problems.some((p) => p.startsWith(`db/migrations/${bad}: not a migration name`)), `${bad}: ${problems.join(" / ")}`);
  }
});

test("a table the check cannot trust fails closed", () => {
  assert.match(errorsOf("# nothing here\n").join(), /no "## Reserved numbers" section/);
  assert.match(errorsOf("## Reserved numbers\n\nprose only\n").join(), /has no table/);
  assert.match(errorsOf(README.replace("| # | File |", "| No | File |")).join(), /no "#" column/);
  assert.match(errorsOf(README.replace("| 0005 |", "| 0003 |")).join(), /0003 comes after 0004 — rows are in ascending order/);
  assert.match(errorsOf(README.replace("| 0005 |", "| 0004 |")).join(), /0004 comes after 0004/);
  assert.match(errorsOf(README.replace("`beta.sql`", "`0005_beta.sql`")).join(), /write "beta\.sql" — the File column is the name after the number/);
  assert.match(errorsOf(README.replace("`beta.sql`", "`Beta.sql`")).join(), /"Beta\.sql" is not a migration name/);
  assert.match(errorsOf(README.replace("| derived | T1-2 |", "| derived | |")).join(), /0005 reserves 0005_beta\.sql for no ticket/);
  assert.match(errorsOf(README.replace("| 0006 | — | spare | | |", "| 0006 | — | spare | | T1-9 |")).join(), /0006 names T1-9 but no file/);
  assert.match(errorsOf(README.replace("## After", "| 0007 | `x.sql` | x | durable | T1-4 |\n\n## After").replace("| 0006 | — | spare | | |", "| 0006 | — | spare | | |\n")).join(), /a second table/);
  assert.deepEqual(checkMigrationNumbers(HISTORY, []), ["db/migrations/README.md: no reserved rows to check against"]);
});

// ---- the repo itself ---------------------------------------------------------------

test("this checkout's migrations are all on reserved numbers", () => {
  const { ok, lines } = run(repoRoot);
  assert.ok(ok, lines.join("\n"));
  assert.match(lines[0], /^migration numbers: ok — \d+ files; 0001–0025 history, 0026–\d{4} in the table/);
});

// ---- the script, as CI runs it ----------------------------------------------------------

/ A throwaway checkout: the script where its own ROOT resolves, a README, some migrations. */
function fixtureRoot(files, readme = README) {
  const root = mkdtempSync(join(tmpdir(), "migration-numbers-"));
  mkdirSync(join(root, "ops/scripts"), { recursive: true });
  mkdirSync(join(root, "db/migrations"), { recursive: true });
  cpSync(scriptSrc, join(root, "ops/scripts/check-migration-numbers.mjs"));
  if (readme !== null) writeFileSync(join(root, "db/migrations/README.md"), readme);
  for (const f of files) writeFileSync(join(root, "db/migrations", f), "select 1;\n");
  return root;
}
const cli = (root) => spawnSync(process.execPath, [join(root, "ops/scripts/check-migration-numbers.mjs")], { encoding: "utf8", env: { PATH: process.env.PATH } });

test("CLI: clean tree exits 0 and says what it checked", () => {
  const r = cli(fixtureRoot([...HISTORY, "0004_alpha.sql"]));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "migration numbers: ok — 4 files; 0001–0003 history, 0004–0006 in the table (2 reserved, 1 of them written; 1 spare)\n");
});

test("CLI: an unreserved number exits 1 with one line per problem", () => {
  const r = cli(fixtureRoot([...HISTORY, "0006_gamma.sql", "0009_delta.sql"]));
  assert.equal(r.status, 1);
  assert.equal(r.stdout, "");
  assert.match(r.stderr, /0006_gamma\.sql: 0006 is spare/);
  assert.match(r.stderr, /0009_delta\.sql: 0009 is not reserved/);
  assert.match(r.stderr, /migration numbers: 2 problem\(s\)/);
});

test("CLI: no README exits 1 — no table is not the same as everything reserved", () => {
  const r = cli(fixtureRoot(HISTORY, null));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /db\/migrations\/README\.md: missing/);
});

// ---- acceptance: two agents cannot pick the same number ----------------------------------

/ git with no inherited config: no global hooks, signing or templates reach the throwaway repo. */
function git(cwd, ...args) {
  return spawnSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main", ...args], {
    cwd,
    encoding: "utf8",
    env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", HOME: cwd },
  });
}
function mustGit(cwd, ...args) {
  const r = git(cwd, ...args);
  assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
  return r;
}

/ Each agent branches from main, writes its migration and claims the row in its own PR; each PR is green alone. */
function twoAgents(claimA, claimB) {
  const root = fixtureRoot(HISTORY);
  mustGit(root, "init", "-q");
  mustGit(root, "add", "-A");
  mustGit(root, "commit", "-qm", "base");
  for (const [branch, claim] of [["agent-a", claimA], ["agent-b", claimB]]) {
    mustGit(root, "checkout", "-qb", branch, "main");
    writeFileSync(join(root, "db/migrations/README.md"), claim.readme);
    writeFileSync(join(root, "db/migrations", claim.file), `-- ${branch}\nselect 1;\n`);
    assert.equal(cli(root).status, 0, `${branch} alone should pass: ${cli(root).stderr}`);
    mustGit(root, "add", "-A");
    mustGit(root, "commit", "-qm", branch);
  }
  mustGit(root, "checkout", "-q", "main");
  mustGit(root, "merge", "-q", "--no-edit", "agent-a");
  return { root, second: git(root, "merge", "--no-edit", "agent-b") };
}
const claim = (row, file) => ({ readme: README.replace("| 0006 | — | spare | | |", row), file });
const append = (row, file) => ({ readme: README.replace("| 0006 | — | spare | | |", `| 0006 | — | spare | | |\n${row}`), file });

test("acceptance: two PRs claiming the same spare — the second cannot merge", () => {
  const { second } = twoAgents(
    claim("| 0006 | `gamma.sql` | g | durable | T1-3 |", "0006_gamma.sql"),
    claim("| 0006 | `delta.sql` | d | durable | T1-4 |", "0006_delta.sql"),
  );
  assert.notEqual(second.status, 0);
  assert.match(second.stdout, /CONFLICT \(content\): Merge conflict in db\/migrations\/README\.md/);
});

test("acceptance: two PRs appending the same new number — the second cannot merge", () => {
  const { second } = twoAgents(
    append("| 0007 | `gamma.sql` | g | durable | T1-3 |", "0007_gamma.sql"),
    append("| 0007 | `delta.sql` | d | durable | T1-4 |", "0007_delta.sql"),
  );
  assert.notEqual(second.status, 0);
  assert.match(second.stdout, /CONFLICT \(content\): Merge conflict in db\/migrations\/README\.md/);
});

test("acceptance: a PR that skips the README is refused by the check, whatever merges first", () => {
  // Agent B writes onto the number A reserved, without touching the table. Its
  // own PR runs the check against the table on its branch, and fails there.
  const root = fixtureRoot([...HISTORY, "0004_somebody_elses.sql"]);
  const r = cli(root);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /0004 is reserved to 0004_alpha\.sql \(T1-1\)/);
});
