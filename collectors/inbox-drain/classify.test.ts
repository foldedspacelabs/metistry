import { describe, expect, it } from "vitest";
import { classify, frontmatter } from "./run.js";

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
