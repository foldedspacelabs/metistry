// Where a capture lands. No database: a fake executor records the SQL, a
// fake vault records the bridge calls. The rules under test are the ones
// the 2026-09-16 move into the vault added (docs/ops/inbox.md):
//   - the row's `path` is repo-relative under a prefixed sink;
//   - a vault write is compare-and-swap on "" — a capture can never land on
//     top of a file someone else (a human, in Obsidian) already wrote;
//   - anything over METISTRY_INBOX_MAX_TRACKED_BYTES goes to `.large/`.
import { mkdtemp, readFile, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { captureToInbox, dirSink, placeCapture, vaultPathPredicate, vaultSink, INBOX_PREFIX, type CaptureVault, type Db } from "../src/index.js";

interface Call {
  text: string;
  values: unknown[];
}

function fakeDb(rows: Record<string, unknown>[] = [{ id: 7 }]): Db & { calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    async query(text: string, values: unknown[] = []) {
      calls.push({ text, values });
      return { rows: /SELECT/.test(text) ? [] : rows };
    },
  } as Db & { calls: Call[] };
}

function fakeVault(): CaptureVault & { writes: Array<{ path: string; bytes: number; expected: string | undefined; principal: string }>; deletes: string[]; listed: string[] } {
  const writes: Array<{ path: string; bytes: number; expected: string | undefined; principal: string }> = [];
  const deletes: string[] = [];
  const listed: string[] = [];
  return {
    writes,
    deletes,
    listed,
    async write(path, content, intent, expectedSha256) {
      writes.push({ path, bytes: content.length, expected: expectedSha256, principal: intent.principal });
      return {};
    },
    async delete(path) {
      deletes.push(path);
      return {};
    },
    async list(prefix) {
      listed.push(prefix);
      return [];
    },
  };
}

describe("placeCapture", () => {
  it("prefixes the vault inbox and spills over the threshold into .large/", () => {
    expect(placeCapture("1-a.md", 10, { prefix: INBOX_PREFIX })).toBe("Inbox/1-a.md");
    expect(placeCapture("1-a.md", 10, {})).toBe("1-a.md"); // a bare directory: the filename alone, as before the move
    expect(placeCapture("1-big.mov", 6 * 1024 * 1024, { prefix: INBOX_PREFIX })).toBe("Inbox/.large/1-big.mov");
    expect(placeCapture("1-big.mov", 6 * 1024 * 1024, { prefix: INBOX_PREFIX, maxTrackedBytes: 0 })).toBe("Inbox/1-big.mov"); // 0 = never spill
    expect(placeCapture("1-a.md", 100, { prefix: INBOX_PREFIX, maxTrackedBytes: 50 })).toBe("Inbox/.large/1-a.md");
  });
});

describe("vaultSink", () => {
  it("writes through the bridge with compare-and-swap on absence, as `capture`", async () => {
    const vault = fakeVault();
    const db = fakeDb();
    const r = await captureToInbox(db, vaultSink(vault), { bytes: Buffer.from("hello"), filename: "note.md", source: "http", sourceAgent: null });

    expect(vault.writes).toHaveLength(1);
    expect(vault.writes[0]!.expected).toBe(""); // "must not exist" — never over a human's file
    expect(vault.writes[0]!.principal).toBe("capture");
    expect(vault.writes[0]!.path).toMatch(/^Inbox\/\d+-note\.md$/);
    expect(r.path).toBe(vault.writes[0]!.path);
    const insert = db.calls.find((c) => c.text.includes("INSERT INTO inbox"))!;
    expect(insert.values[1]).toBe(r.path); // the row records the repo-relative path
    expect(insert.text).toContain("ON CONFLICT (path) WHERE path LIKE 'Inbox/%'"); // the scan may have inserted first
  });

  it("puts an oversized capture in .large/ and probes by listing the prefix", async () => {
    const vault = fakeVault();
    const sink = vaultSink(vault, { maxTrackedBytes: 8 });
    const r = await captureToInbox(fakeDb(), sink, { bytes: Buffer.alloc(64), filename: "clip.mov", source: "share", sourceAgent: null });
    expect(r.path).toMatch(/^Inbox\/\.large\/\d+-clip\.mov$/);
    await sink.check();
    expect(vault.listed).toEqual([INBOX_PREFIX]);
  });
});

describe("a placed capture (T8-4: a recording's transcript, Q29)", () => {
  it("lands at the exact path, create-only, in the principal the adapter chose — and the row records that path with no inbox conflict target", async () => {
    const vault = fakeVault();
    const db = fakeDb();
    const place = { path: "Journal/Transcripts/2026-09-28-20260928-120000-00ab.md", principal: "user" };
    const r = await captureToInbox(db, vaultSink(vault), { bytes: Buffer.from("---\nkind: \"transcript\"\n---\n"), filename: "t.md", source: "http", sourceAgent: null, place });
    expect(vault.writes).toEqual([{ path: place.path, bytes: 27, expected: "", principal: "user" }]);
    expect(r.path).toBe(place.path);
    const insert = db.calls.find((c) => c.text.includes("INSERT INTO inbox"))!;
    expect(insert.values[1]).toBe(place.path);
    expect(insert.text).not.toContain("ON CONFLICT"); // not under Inbox/: no scan races it for that index
  });

  it("a bare directory has nowhere to place it: the capture lands under the directory as always", async () => {
    const dir = await mkdtemp(join(tmpdir(), "brain-place-"));
    try {
      const r = await captureToInbox(fakeDb(), dirSink(dir), { bytes: Buffer.from("x"), filename: "t.md", source: "http", sourceAgent: null, place: { path: "Journal/Transcripts/x.md", principal: "user" } });
      expect(r.path).toMatch(/^\d+-t\.md$/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("a second attempt that meets the first's file answers the first's row when its key is there", async () => {
    const vault = fakeVault();
    vault.write = async () => {
      throw new Error("conflict: the file exists");
    };
    let lookups = 0;
    const db = {
      async query(text: string) {
        if (/SELECT id, path, sha256 FROM inbox/.test(text)) return { rows: lookups++ === 0 ? [] : [{ id: 9, path: "Journal/Transcripts/x.md", sha256: "abc" }] };
        return { rows: [] };
      },
    } as unknown as Db;
    const r = await captureToInbox(db, vaultSink(vault), { bytes: Buffer.from("x"), filename: "t.md", source: "http", sourceAgent: null, idempotency: { principal: "owner_token", key: "live-capture:x" }, place: { path: "Journal/Transcripts/x.md", principal: "user" } });
    expect(r).toEqual({ id: 9, path: "Journal/Transcripts/x.md", sha256: "abc", replayed: true });
    // …and without a key there is nothing to answer with: the conflict is the caller's
    await expect(captureToInbox(fakeDb(), vaultSink(vault), { bytes: Buffer.from("x"), source: "http", sourceAgent: null, place: { path: "Journal/Transcripts/x.md", principal: "user" } })).rejects.toThrow(/conflict/);
  });
});

describe("the legacy inbox prefix", () => {
  // A legacy instance captures into `Knowledge/Inbox/` and its rows live
  // under migration 0015's partial index, not 0021's. The conflict target
  // comes from the SINK's prefix for that reason: named from the flat
  // constant it would have addressed an index the row is not in, and the
  // insert that races the reconciler's scan would have raised instead of
  // refining the row.
  it("names the index the row is actually in", async () => {
    const vault = fakeVault();
    const db = fakeDb();
    const r = await captureToInbox(db, vaultSink(vault, { prefix: "Knowledge/Inbox" }), { bytes: Buffer.from("hello"), filename: "note.md", source: "http", sourceAgent: null });
    expect(r.path).toMatch(/^Knowledge\/Inbox\/\d+-note\.md$/);
    const insert = db.calls.find((c) => c.text.includes("INSERT INTO inbox"))!;
    expect(insert.text).toContain("ON CONFLICT (path) WHERE path LIKE 'Knowledge/Inbox/%'");
  });

  it("checks the prefix rather than trusting it — it reaches SQL as text (invariant 8)", () => {
    expect(vaultPathPredicate("Inbox")).toBe("path LIKE 'Inbox/%'");
    expect(vaultPathPredicate("Knowledge/Inbox")).toBe("path LIKE 'Knowledge/Inbox/%'");
    for (const bad of ["", "'", "Inbox'; DROP TABLE inbox --", "../Inbox", "In box", "/Inbox", "Inbox/"]) {
      expect(vaultPathPredicate(bad), bad).toBeNull();
    }
  });

  it("a bare directory sink has no prefix, so the insert carries no conflict clause — as before the move", async () => {
    const db = fakeDb();
    const dir = await mkdtemp(join(tmpdir(), "metistry-capture-bare-"));
    await captureToInbox(db, dir, { bytes: Buffer.from("hi"), filename: "a.md", source: "http", sourceAgent: null });
    expect(db.calls.find((c) => c.text.includes("INSERT INTO inbox"))!.text).not.toContain("ON CONFLICT");
    await rm(dir, { recursive: true, force: true });
  });
});

describe("dirSink", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "metistry-capture-"));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("writes the bytes and records the prefixed path; a bare directory keeps the old bare name", async () => {
    const prefixed = await captureToInbox(fakeDb(), dirSink(dir, { prefix: INBOX_PREFIX }), { bytes: Buffer.from("x"), filename: "a.md", source: "http", sourceAgent: null });
    expect(prefixed.path).toMatch(/^Inbox\/\d+-a\.md$/);
    expect(await readFile(join(dir, prefixed.path.slice(INBOX_PREFIX.length + 1)), "utf8")).toBe("x");

    const bare = await captureToInbox(fakeDb(), dir, { bytes: Buffer.from("y"), filename: "b.md", source: "http", sourceAgent: null });
    expect(bare.path).toMatch(/^\d+-b\.md$/);
    expect(await readFile(join(dir, bare.path), "utf8")).toBe("y");
  });

  it("sanitizes a hostile filename — no traversal out of the inbox", async () => {
    const r = await captureToInbox(fakeDb(), dirSink(dir, { prefix: INBOX_PREFIX }), { bytes: Buffer.from("z"), filename: "../../etc/passwd", source: "http", sourceAgent: null });
    expect(r.path).toMatch(/^Inbox\/\d+-_+etc_passwd$/);
    expect((await readdir(dir)).some((f) => f.includes("etc_passwd"))).toBe(true);
  });
});

describe("two attempts racing one idempotency key", () => {
  // Names are `<ms>-<name>`, so two attempts inside one millisecond put the
  // SAME path. The insert that loses on the idempotency index (23505) used to
  // remove "its" file unconditionally — which was the winner's, leaving the
  // winner's row pointing at nothing (collectors' "two presses at once": an
  // empty Inbox/ in ~2% of runs on a fast database). The loser may remove
  // only a file the winning row does not name.
  const race = (winnerPath: (rel: string) => string) => {
    let dir = "";
    return async () => {
      dir = await mkdtemp(join(tmpdir(), "metistry-capture-race-"));
      const now = vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
      try {
        let looked = 0;
        const db = {
          async query(text: string) {
            if (/^\s*SELECT/.test(text)) return { rows: looked++ === 0 ? [] : [{ id: 3, path: winnerPath("Inbox/1700000000000-x.md"), sha256: "w" }] }; // the lookup misses, then the winner's row is there
            throw Object.assign(new Error("duplicate key value violates unique constraint"), { code: "23505" });
          },
        } as unknown as Db;
        const r = await captureToInbox(db, dirSink(dir, { prefix: INBOX_PREFIX }), { bytes: Buffer.from("x"), filename: "x.md", source: "linear", sourceAgent: null, idempotency: { principal: "tracker:linear", key: "linear:A-1" } });
        return { r, files: await readdir(dir) };
      } finally {
        now.mockRestore();
        await rm(dir, { recursive: true, force: true });
      }
    };
  };

  it("keeps the winner's file when it is the same path", async () => {
    const { r, files } = await race((rel) => rel)();
    expect(r).toMatchObject({ id: 3, replayed: true });
    expect(files).toEqual(["1700000000000-x.md"]); // before the fix: []
  });

  it("still withdraws its own file when the winner's is another", async () => {
    const { r, files } = await race(() => "Inbox/1700000000001-x.md")();
    expect(r).toMatchObject({ id: 3, replayed: true });
    expect(files).toEqual([]);
  });
});
