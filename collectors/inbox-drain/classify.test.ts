import { describe, expect, it } from "vitest";
import { classify, crashReport, frontmatter, suggestedWork } from "./run.js";

const base = { id: 1, path: "123-x.bin", mime: null, note: null, source: "http" };

describe("inbox-drain deterministic classifier", () => {
  it("bare urls", () => {
    expect(classify({ ...base, note: "https://example.com/a" }).kind).toBe("url");
  });
  it("action-verb todos", () => {
    expect(classify({ ...base, note: "remind me to renew the cert" }).kind).toBe("todo");
    expect(classify({ ...base, note: "buy milk" }).kind).toBe("todo");
  });
  it("images and documents by mime/extension", () => {
    expect(classify({ ...base, mime: "image/heic" }).kind).toBe("image");
    expect(classify({ ...base, path: "9-spec.pdf" }).kind).toBe("document");
  });
  it("defaults to note, records which rule fired", () => {
    const c = classify({ ...base, note: "an idea about routing" });
    expect(c.kind).toBe("note");
    expect(c.reason).toBeTruthy();
  });
  it("a url INSIDE prose is not promoted to url-kind (quoted-content lesson, PoC-14)", () => {
    expect(classify({ ...base, note: "sam sent https://x.com/y check later" }).kind).toBe("note");
  });
});

describe("frontmatter is authoritative for kind", () => {
  const note = [
    "---",
    'kind: "session"',
    'source: "claude-code"',
    'title: "Claude Code session — demo — 2026-09-08"',
    'session_id: "abc"',
    'idempotency_key: "claude-code:abc:0123456789abcdef"',
    "turns: 4",
    "---",
    "",
    "# Claude Code session — demo — 2026-09-08",
    "",
    "## Session",
    "",
    "- Turns: 4 user, 9 assistant",
  ].join("\n");

  it("classifies a session summary as kind session, titled from the frontmatter", () => {
    const c = classify({ ...base, note, path: "12-claude-code-session-20260908T100000Z-11111111.md" });
    expect(c.kind).toBe("session");
    expect(c.reason).toBe("frontmatter kind: session");
    expect(c.title).toBe("Claude Code session — demo — 2026-09-08");
  });

  it("reads scalars without a YAML dependency, and ignores a body that merely looks like frontmatter", () => {
    expect(frontmatter(note).session_id).toBe("abc");
    expect(frontmatter(note).turns).toBe("4");
    expect(frontmatter("no frontmatter here\n---\nkind: session\n---\n")).toEqual({});
  });

  it("a session summary is never refined by the FM tier (its reason is not the default)", () => {
    expect(classify({ ...base, note }).reason).not.toBe("default");
  });

  it("leaves every other kind to the rules — an unknown `kind:` is not a classification", () => {
    const other = ["---", 'kind: "decision"', 'title: "Ship the router"', "---", "", "we ship it next week"].join("\n");
    const c = classify({ ...base, note: other });
    expect(c.kind).toBe("note");
    expect(c.title).toBe("Ship the router");
  });
});

// ADOPT 2 (docs/research/2026-09-16-taskuary-review.md): the drain may
// SUGGEST a work row; it still creates nothing. Deterministic throughout —
// the Apple FM tier's `has_action` is deliberately not an input here, because
// a model must not be what puts an extra button under a proposal
// (invariant 4).
describe("suggestedWork — a capture that is asking for a task", () => {
  const fm = (lines: string[]) => ["---", ...lines, "---", ""].join("\n");

  const sw = (note: string, path = "1-x.md") => {
    const row = { ...base, note, path };
    return suggestedWork(row, classify(row));
  };

  it("takes the three cues: frontmatter kind, an explicit leading marker, and the existing todo verdict", () => {
    expect(sw(fm(['kind: "todo"', 'title: "renew the cert"']))?.title).toBe("renew the cert");
    expect(sw(fm(['kind: "task"']) + "ship the release")?.title).toBe("ship the release");
    expect(sw("@task pay the invoice")?.title).toBe("pay the invoice");
    expect(sw("todo: pay the invoice")?.title).toBe("pay the invoice");
    expect(sw("- [ ] pay the invoice")?.title).toBe("pay the invoice");
    expect(sw("buy milk")?.title).toBe("buy milk"); // TODO_RE, the rule that already existed
  });

  it("suggests nothing for everything else — most captures are not tasks", () => {
    expect(sw("an idea about routing")).toBeUndefined();
    expect(sw("https://example.com/a")).toBeUndefined();
    expect(sw("")).toBeUndefined();
    expect(sw(fm(['kind: "session"']) + "a session summary")).toBeUndefined();
    expect(sw("sam said to @task something later")).toBeUndefined(); // the cue must LEAD
  });

  it("carries a project only when the frontmatter names one in slug form", () => {
    expect(sw(fm(['kind: "todo"', 'title: "x"', 'project: "metistry"']))?.project).toBe("metistry");
    expect(sw(fm(['kind: "todo"', 'title: "x"', 'project: "Some Project"']))?.project).toBeUndefined();
    expect(sw(fm(['kind: "todo"', 'title: "x"']))?.project).toBeUndefined();
  });
});

// T8-2b: a recording's transcript, and the one report a crashed one raises (C137).
describe("a recording's transcript", () => {
  const transcript = (endedReason: string, session = "20260928-120000-00ab") =>
    [
      "---",
      'kind: "transcript"',
      'title: "Recording 2026-09-28 13:00"',
      `capture_session: ${JSON.stringify(session)}`,
      'started_at: "2026-09-28T12:00:00Z"',
      'ended_at: "2026-09-28T12:41:07Z"',
      `ended_reason: ${JSON.stringify(endedReason)}`,
      'apps: "us.zoom.xos"',
      'source: "live-capture"',
      "---",
      "",
      "[00:00:01] (apps) the numbers are in",
    ].join("\n");
  const row = (note: string, source_agent: string | null = null) => ({ ...base, id: 9, path: "Inbox/9-transcript-20260928-120000-00ab.md", note, source_agent });

  it("declares itself: frontmatter kind transcript, deterministic, never a model tier", () => {
    expect(classify(row(transcript("owner")))).toEqual({ kind: "transcript", reason: "frontmatter kind: transcript", title: "Recording 2026-09-28 13:00" });
  });

  it("a crash raises one report, keyed on the session, in this file's words", () => {
    const r = crashReport(row(transcript("crashed")), classify(row(transcript("crashed"))))!;
    expect(r).toMatchObject({
      kind: "report",
      source_agent: "inbox-drain",
      trust: "internal",
      source: { kind: "live-capture", external_ref: "crash:20260928-120000-00ab" },
      payload: { title: "A recording stopped unexpectedly", event: "recording_crashed", capture_session: "20260928-120000-00ab", inbox_id: 9, refs: ["Inbox/9-transcript-20260928-120000-00ab.md"], ended_at: "2026-09-28T12:41:07.000Z" },
    });
    expect(r.payload.body).toMatch(/stopped at 12:41 UTC .*Everything it heard up to then was saved/);
    expect(r.payload.body).not.toContain("the numbers are in");
  });

  it("raises nothing for a recording that ended any other way, for an agent's capture, or for a session id that is not one", () => {
    for (const reason of ["owner", "max_duration", "disk_full", "helper_stopped", "resume_failed"]) {
      expect(crashReport(row(transcript(reason)), classify(row(transcript(reason))))).toBeUndefined();
    }
    const forged = row(transcript("crashed"), "some-agent");
    expect(crashReport(forged, classify(forged))).toBeUndefined();
    const bad = row(transcript("crashed", "../../x"));
    expect(crashReport(bad, classify(bad))).toBeUndefined();
    const plain = row("---\nended_reason: crashed\n---\nnot a transcript");
    expect(crashReport(plain, classify(plain))).toBeUndefined();
  });
});
