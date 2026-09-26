#!/usr/bin/env node
// Migration numbers are reserved (plan §2.9, ticket F-6).
//
// Parallel tickets that each take "the next free number" collide — 0024 was
// written as 0023 and found 0023 taken — and a collision is worse than a
// failed build: two files on one number both apply, in an order nobody chose.
// So db/migrations/README.md holds a table that reserves each number to one
// file, and this check holds every migration file to it:
//
//   * below the table's first row is HISTORY: every number from 0001 up has
//     exactly one file and there are no gaps, so there is nothing free to take;
//   * from the first row up, a file's number must have a row, the row must name
//     a file (a spare `—` row is not yet anyone's), and the file must be that
//     one, exactly;
//   * no number has two files, and every name is lowercase `NNNN_snake.sql`.
//
// Two agents cannot pick the same number: a reserved number admits one file
// name, and claiming a spare (or appending a row) edits one line of the
// README, so the second PR to claim it conflicts and cannot merge.
//
// The table is read from the README, not from the plan: the plan is a design
// document and will be superseded; the README lives next to the files.
//
//   node ops/scripts/check-migration-numbers.mjs   exit 1 with one line per problem
//
// No dependency: node's fs and path only.

import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const DIR = "db/migrations";
export const README = `${DIR}/README.md`;

/** The section that holds the table. */
const HEADING = /^##\s+Reserved numbers\s*$/;
/** A migration file: four digits, an underscore, lowercase snake case. */
const MIGRATION = /^(\d{4})_([a-z0-9][a-z0-9_]*)\.sql$/;
/** A `File` cell: the name after the number. */
const FILE_CELL = /^[a-z0-9][a-z0-9_]*\.sql$/;
/** A `File` or `Ticket` cell that says "nothing". */
const EMPTY = new Set(["", "—", "–", "-"]);

const pad = (n) => String(n).padStart(4, "0");
const unquote = (s) => s.replace(/^`(.*)`$/, "$1").trim();

/** One markdown table line → trimmed cells. `\|` is a literal pipe, not a cell break. */
function cells(line) {
  const inner = line.trim().replace(/^\|/, "").replace(/(?<!\\)\|$/, "");
  return inner.split(/(?<!\\)\|/).map((c) => c.trim());
}

/**
 * Read the reserved table out of the README's text.
 * @returns {{ rows: { number: number, file: string | null, ticket: string, line: number }[], errors: string[] }}
 *   `file` is the full filename (`0026_work_description.sql`), or null for a spare row.
 */
export function parseReservedTable(text) {
  const lines = text.split("\n");
  const errors = [];
  const rows = [];
  const at = (i) => `${README}:${i + 1}`;

  const start = lines.findIndex((l) => HEADING.test(l));
  if (start === -1) return { rows, errors: [`${README}: no "## Reserved numbers" section — the reserved table lives there`] };
  let end = lines.findIndex((l, i) => i > start && /^#{1,2}\s/.test(l));
  if (end === -1) end = lines.length;

  const first = lines.findIndex((l, i) => i > start && i < end && l.trimStart().startsWith("|"));
  if (first === -1) return { rows, errors: [`${at(start)}: "## Reserved numbers" has no table`] };
  let last = first;
  while (last + 1 < end && lines[last + 1].trimStart().startsWith("|")) last++;
  const stray = lines.findIndex((l, i) => i > last && i < end && l.trimStart().startsWith("|"));
  if (stray !== -1) errors.push(`${at(stray)}: a second table in "## Reserved numbers" — the check reads one; put every row in the first`);

  const header = cells(lines[first]);
  const col = { number: header.indexOf("#"), file: header.indexOf("File"), ticket: header.indexOf("Ticket") };
  const missing = Object.entries({ "#": col.number, File: col.file, Ticket: col.ticket }).filter(([, i]) => i === -1).map(([n]) => `"${n}"`);
  if (missing.length) return { rows, errors: [...errors, `${at(first)}: the reserved table has no ${missing.join(", ")} column — its header must name #, File and Ticket`] };
  if (first + 1 > last || !cells(lines[first + 1]).every((c) => /^:?-+:?$/.test(c))) {
    return { rows, errors: [...errors, `${at(first + 1)}: the reserved table's second line must be its |---| separator`] };
  }

  for (let i = first + 2; i <= last; i++) {
    const c = cells(lines[i]);
    const numberCell = unquote(c[col.number] ?? "");
    const fileCell = unquote(c[col.file] ?? "");
    const ticket = unquote(c[col.ticket] ?? "");
    if (!/^\d{4}$/.test(numberCell) || Number(numberCell) === 0) {
      errors.push(`${at(i)}: "${numberCell}" is not a migration number — four digits, from 0001`);
      continue;
    }
    const number = Number(numberCell);
    const prev = rows.at(-1);
    if (prev && number <= prev.number) {
      errors.push(`${at(i)}: ${pad(number)} comes after ${pad(prev.number)} — rows are in ascending order, each number once`);
      continue;
    }
    let file = null;
    if (!EMPTY.has(fileCell)) {
      if (/^\d{4}_/.test(fileCell)) {
        errors.push(`${at(i)}: write "${fileCell.replace(/^\d{4}_/, "")}" — the File column is the name after the number`);
        continue;
      }
      if (!FILE_CELL.test(fileCell)) {
        errors.push(`${at(i)}: "${fileCell}" is not a migration name — lowercase snake_case ending .sql`);
        continue;
      }
      file = `${pad(number)}_${fileCell}`;
      if (EMPTY.has(ticket)) errors.push(`${at(i)}: ${pad(number)} reserves ${file} for no ticket — a reservation names its ticket`);
    } else if (!EMPTY.has(ticket)) {
      errors.push(`${at(i)}: ${pad(number)} names ${ticket} but no file — a reservation names its file`);
    }
    rows.push({ number, file, ticket, line: i + 1 });
  }
  if (!rows.length && !errors.length) errors.push(`${at(first)}: the reserved table has no rows`);
  return { rows, errors };
}

/**
 * Hold the migration files to the reserved table.
 * @param {string[]} names every `*.sql` name in db/migrations
 * @param {{ number: number, file: string | null, ticket: string }[]} rows from parseReservedTable
 * @returns {string[]} one line per problem; empty when every number is reserved
 */
export function checkMigrationNumbers(names, rows) {
  const problems = [];
  if (!rows.length) return [`${README}: no reserved rows to check against`];
  const floor = rows[0].number;
  const byNumber = new Map(rows.map((r) => [r.number, r]));
  const taken = new Map();

  for (const name of [...names].sort()) {
    const m = MIGRATION.exec(name);
    if (!m || Number(m[1]) === 0) {
      problems.push(`${DIR}/${name}: not a migration name — NNNN_snake_case.sql, lowercase, from 0001`);
      continue;
    }
    const n = Number(m[1]);
    taken.set(n, [...(taken.get(n) ?? []), name]);
    if (n < floor) continue; // history: the gap and duplicate checks below cover it
    const row = byNumber.get(n);
    if (!row) {
      problems.push(`${DIR}/${name}: ${pad(n)} is not reserved — add its row to ${README} in this PR (see "Numbers are reserved")`);
    } else if (!row.file) {
      problems.push(`${DIR}/${name}: ${pad(n)} is spare — claim it by writing "${m[2]}.sql" and your ticket into its row in ${README}, in this PR`);
    } else if (row.file !== name) {
      problems.push(`${DIR}/${name}: ${pad(n)} is reserved to ${row.file} (${row.ticket}) — take your own ticket's number, or claim a spare`);
    }
  }

  for (const [n, files] of [...taken].sort(([a], [b]) => a - b)) {
    if (files.length > 1) problems.push(`${DIR}: ${pad(n)} has ${files.length} files (${files.join(", ")}) — one number, one file`);
  }
  for (let n = 1; n < floor; n++) {
    if (!taken.has(n)) problems.push(`${DIR}: ${pad(n)} has no file — history below the reserved table (0001–${pad(floor - 1)}) has no gaps; a shipped migration is never deleted or renumbered`);
  }
  return problems;
}

/** Everything the CLI prints, for a checkout rooted at `root`. */
export function run(root) {
  const readmePath = join(root, README);
  if (!existsSync(readmePath)) return { ok: false, lines: [`${README}: missing — it holds the reserved table`] };
  const { rows, errors } = parseReservedTable(readFileSync(readmePath, "utf8"));
  const dir = join(root, DIR);
  const names = readdirSync(dir).filter((f) => /\.sql$/i.test(f) && statSync(join(dir, f)).isFile());
  const problems = [...errors, ...checkMigrationNumbers(names, rows)];
  if (problems.length) return { ok: false, lines: [...problems, "", `migration numbers: ${problems.length} problem(s) — ${README} says how a number is reserved`] };
  const reserved = rows.filter((r) => r.file);
  const present = reserved.filter((r) => names.includes(r.file)).length;
  return {
    ok: true,
    lines: [`migration numbers: ok — ${names.length} files; 0001–${pad(rows[0].number - 1)} history, ${pad(rows[0].number)}–${pad(rows.at(-1).number)} in the table (${reserved.length} reserved, ${present} of them written; ${rows.length - reserved.length} spare)`],
  };
}

function main() {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const { ok, lines } = run(root);
  (ok ? console.log : console.error)(lines.join("\n"));
  process.exit(ok ? 0 : 1);
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) main();
