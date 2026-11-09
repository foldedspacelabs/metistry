// Reading `.metistry/connections/<name>.yaml` (plan §2.6, F-3's schema).
//
// A connection file is judged in three steps, and the verdict is one of the
// three statuses doctor already speaks:
//
//   failed  the file does not validate (core's `connectionFileSchema`), does
//           not match its provider's connection-type manifest
//           (`connectionIssues`), or breaks one of the rules below;
//   absent  it names a provider no registry unit provides — the connection
//           turns absent, naming the missing unit, and nothing is deleted
//           (§2.7's edge case);
//   ok      it may be dialled, as far as the file can say. Whether its
//           secrets have items and its variables are set is the caller's to
//           add (`describe.ts`), because only the caller can ask the
//           Keychain.
//
// Never fatal, like every registry: one bad file is one failed entry, and
// every other connection still loads. A YAML error is reported by its code
// and line only — never the parser's snippet of the source, which would echo
// a value pasted into the wrong place into whatever shows the error.
//
// **The rules this module adds to the frozen schema**, each a refusal with a
// sentence, because the schema permits them and the egress door would only
// catch some of them later, one call at a time:
//
//   * a literal that looks like a key, anywhere a value is typed — a
//     connection file holds NAMES; the value is a secret (T4-4's heuristic,
//     core's `looksLikeKey`, applied to the text outside `{{ … }}`);
//   * a `{{ secret.x }}` in a URL or its query — a URL lands in logs and
//     histories (guardedFetch refuses it at egress as `secret_in_url`; this
//     refuses the file);
//   * a `{{ secret.x }}` on a command line or in a working directory — every
//     process on the Mac can read another's argv; a secret goes in `env:`,
//     given to that command only;
//   * a `{{ secret.x }}` in a path reach, which has nowhere to send one;
//   * an Authorization header beside an auth shortcut that writes one;
//   * and what a builtin provider refuses for its own connections
//     (`builtinIssues` — CalDAV's, T4-13; IMAP's, T4-15).

import { lstat, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseDocument } from "yaml";
import {
  CUSTOM_PROVIDER,
  connectionIssues,
  looksLikeKey,
  validateConnectionFile,
  type ConnectionFile,
  type ConnectionTypeManifest,
  type Registry,
  type RegistryUnit,
} from "@foldedspacelabs/metistry-core";
import { CALDAV_MODULE, caldavConnectionIssues } from "./caldav.js";
import { GOOGLE_CALENDAR_MODULE, googleCalendarConnectionIssues } from "./google-calendar.js";
import { IMAP_MODULE, imapConnectionIssues } from "./imap.js";

/** `github.yaml` → `github`. A connection's file is named for it, like a registry unit's directory. */
export const CONNECTION_FILE_RE = /^([a-z][a-z0-9-]*)\.ya?ml$/;

/** The three verdicts a file can have — doctor's words (`check.ts`), minus `degraded`, which only a dial can say. */
export const CONNECTION_STATUSES = ["ok", "failed", "absent"] as const;
export type ConnectionStatus = (typeof CONNECTION_STATUSES)[number];

/** One connection file and what became of it. */
export interface ConnectionEntry {
  /** the connection's name — the file's stem */
  name: string;
  /** where the file is */
  path: string;
  /** the parsed file, when it validates; null when it does not */
  connection: ConnectionFile | null;
  /** its provider's connection-type unit; null for `custom`, for an uninstalled provider, and for a file that does not validate */
  provider: RegistryUnit<ConnectionTypeManifest> | null;
  status: ConnectionStatus;
  /** why it is not `ok`, one sentence each — names, never values */
  issues: string[];
}

/** A `{{ … }}` reference, any namespace — removed before the key-shape test, so `Bearer {{ secret.x }}` is not mistaken for a key. */
const ANY_REF = /\{\{[^{}]*\}\}/g;
const SECRET_REF = /\{\{\s*secret\.[^{}]*\}\}/;

type Where = "url" | "query" | "header" | "command" | "cwd" | "env" | "path" | "config" | "auth" | "description";

/** Every string in a connection file a person typed, with its path and what kind of place it is. */
export function typedValues(c: ConnectionFile): { path: string; where: Where; value: string }[] {
  const out: { path: string; where: Where; value: string }[] = [];
  const add = (path: string, where: Where, value: string | undefined) => {
    if (value !== undefined) out.push({ path, where, value });
  };
  add("description", "description", c.description);
  const { http, command, path, imap } = c.reach;
  if (imap) {
    add("reach.imap.host", "url", imap.host);
    add("reach.imap.username", "auth", imap.username);
  }
  if (http) {
    add("reach.http.url", "url", http.url);
    for (const [k, v] of Object.entries(http.query)) add(`reach.http.query.${k}`, "query", v);
    for (const [k, v] of Object.entries(http.headers)) add(`reach.http.headers.${k}`, "header", v);
    if (http.auth.scheme === "basic") add("reach.http.auth.username", "auth", http.auth.username);
  }
  if (command) {
    add("reach.command.command", "command", command.command);
    command.args.forEach((a, i) => add(`reach.command.args.${i}`, "command", a));
    add("reach.command.cwd", "cwd", command.cwd);
    for (const [k, v] of Object.entries(command.env)) add(`reach.command.env.${k}`, "env", v);
  }
  if (path) {
    add("reach.path.path", "path", path.path);
    path.include.forEach((p, i) => add(`reach.path.include.${i}`, "path", p));
    path.skip.forEach((p, i) => add(`reach.path.skip.${i}`, "path", p));
  }
  for (const [k, v] of Object.entries(c.config)) {
    if (typeof v === "string") add(`config.${k}`, "config", v);
    else for (const [part, s] of Object.entries(v)) add(`config.${k}.${part}`, "config", s as string | undefined);
  }
  return out;
}

const NO_SECRET_HERE: Partial<Record<Where, string>> = {
  url: "a secret goes in a header, never the URL — a URL lands in logs and histories",
  query: "a secret goes in a header, never the URL's query — a URL lands in logs and histories",
  command: "a secret on a command line is readable by every process on this Mac — put it in env:, where it is given to this command only",
  cwd: "a working directory carries no secret",
  description: "a description is shown to everyone who can see the connection — it carries no secret",
  path: "a path reach has nowhere to send a secret",
};

/**
 * The rules this package adds to the frozen schema (module doc). Empty =
 * none broken. Every message names the field and the reason, never a value.
 */
export function connectionFileRules(c: ConnectionFile): string[] {
  const issues: string[] = [];
  for (const { path, where, value } of typedValues(c)) {
    const why = NO_SECRET_HERE[where];
    if (why && SECRET_REF.test(value)) issues.push(`${path}: ${why}`);
    if (looksLikeKey(value.replace(ANY_REF, " "))) {
      issues.push(`${path}: this looks like a key — a connection file holds names, never values. Store it as a secret (\`metistry secrets set <name>\`, the value on stdin) and write {{ secret.<name> }} here`);
    }
  }
  const http = c.reach.http;
  if (http) {
    const written = http.auth.scheme === "bearer" || http.auth.scheme === "basic" || http.auth.scheme === "oauth" ? "authorization" : http.auth.scheme === "api_key" ? http.auth.header.toLowerCase() : undefined;
    if (written && Object.keys(http.headers).some((h) => h.toLowerCase() === written)) {
      issues.push(`reach.http.headers: the ${http.auth.scheme} auth shortcut writes the ${written} header itself — remove one of the two`);
    }
  }
  return issues;
}

/**
 * The rules a builtin provider adds for its own connections — refused at
 * the file, before anything is dialled or written (CalDAV: a Google address,
 * a known service pointed elsewhere, a sign-in that is not an app password;
 * `caldav.ts`. Google Calendar: anywhere but the Calendar API, a sign-in
 * that is not Google's; `google-calendar.ts`).
 */
function builtinIssues(c: ConnectionFile, unit: RegistryUnit<ConnectionTypeManifest>): string[] {
  const impl = unit.manifest.implementation;
  if (impl.kind !== "builtin") return [];
  if (impl.module === CALDAV_MODULE) return caldavConnectionIssues(c, unit.name);
  if (impl.module === IMAP_MODULE) return imapConnectionIssues(c, unit.name);
  if (impl.module === GOOGLE_CALENDAR_MODULE) return googleCalendarConnectionIssues(c, unit.name);
  return [];
}

/** One validated input, judged. Pure: the registry is the caller's, already loaded. */
export function judgeConnection(name: string, path: string, input: unknown, types: Registry<ConnectionTypeManifest> | undefined): ConnectionEntry {
  const base = { name, path, connection: null, provider: null } as const;
  const v = validateConnectionFile(input);
  if (!v.ok) return { ...base, status: "failed", issues: v.errors };
  const c = v.connection;
  if (c.name !== name) {
    return { ...base, status: "failed", issues: [`the file is ${name}.yaml but says name: ${c.name} — a connection file is named for its connection`] };
  }
  const rules = connectionFileRules(c);
  if (rules.length > 0) return { ...base, connection: c, status: "failed", issues: rules };
  if (c.provider === CUSTOM_PROVIDER) return { ...base, connection: c, status: "ok", issues: [] };
  const unit = types?.get(c.provider);
  if (!unit) {
    return {
      ...base,
      connection: c,
      status: "absent",
      issues: [...connectionIssues(c, undefined).map((s) => `${s} (\`metistry extensions list\` shows the connection types this instance has)`)],
    };
  }
  const issues = [...connectionIssues(c, unit.manifest), ...builtinIssues(c, unit)];
  return { ...base, connection: c, provider: unit, status: issues.length > 0 ? "failed" : "ok", issues };
}

/** Parse one file's text. A YAML error names its code and line — never the source. */
export function parseConnectionText(text: string): { ok: true; input: unknown } | { ok: false; issue: string } {
  const doc = parseDocument(text);
  const bad = doc.errors[0];
  if (bad) return { ok: false, issue: `not valid YAML — ${bad.code}${bad.linePos?.[0] ? ` at line ${bad.linePos[0].line}` : ""}` };
  const input = doc.toJS() as unknown;
  if (input === null || input === undefined) return { ok: false, issue: "the file is empty" };
  return { ok: true, input };
}

/**
 * Every connection file in `dir`, judged, sorted by name. A missing
 * directory is no connections. Only `<name>.yaml` / `.yml` files are
 * connections; anything else in the directory is left alone. A symbolic link
 * is not followed — a connection lives in the tree it is read from — and two
 * files for one name (`x.yaml` and `x.yml`) are both refused rather than one
 * silently winning.
 */
export async function readConnections(dir: string, types: Registry<ConnectionTypeManifest> | undefined): Promise<ConnectionEntry[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const byName = new Map<string, ConnectionEntry[]>();
  const push = (e: ConnectionEntry) => byName.set(e.name, [...(byName.get(e.name) ?? []), e]);
  for (const file of names.sort()) {
    if (!/\.ya?ml$/.test(file)) continue;
    const path = join(dir, file);
    const stem = file.replace(/\.ya?ml$/, "");
    const failed = (issue: string): ConnectionEntry => ({ name: stem, path, connection: null, provider: null, status: "failed", issues: [issue] });
    if (!CONNECTION_FILE_RE.test(file)) {
      push(failed(`${file}: a connection file is named <name>.yaml, the name lowercase kebab-case`));
      continue;
    }
    const st = await lstat(path).catch(() => undefined);
    if (!st || !st.isFile()) {
      push(failed(st?.isSymbolicLink() ? "a symbolic link is not followed — a connection file lives in .metistry/connections/ itself" : "not a regular file"));
      continue;
    }
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch (err) {
      push(failed(`could not be read (${err instanceof Error && "code" in err ? String((err as NodeJS.ErrnoException).code) : "error"})`));
      continue;
    }
    const parsed = parseConnectionText(text);
    push(parsed.ok ? judgeConnection(stem, path, parsed.input, types) : failed(parsed.issue));
  }
  const out: ConnectionEntry[] = [];
  for (const [name, entries] of [...byName].sort(([a], [b]) => a.localeCompare(b))) {
    if (entries.length === 1) {
      out.push(entries[0]!);
      continue;
    }
    const files = entries.map((e) => e.path.slice(e.path.lastIndexOf("/") + 1)).join(" and ");
    out.push({ name, path: entries[0]!.path, connection: null, provider: null, status: "failed", issues: [`two files for one connection (${files}) — remove one`] });
  }
  return out;
}
