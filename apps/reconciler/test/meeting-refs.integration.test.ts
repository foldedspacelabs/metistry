// Meeting refs and people emails (plan §2.9, ticket T1-10): the walk derives
// `vault_meeting_refs` from a meeting note's `event_id:` and `people_emails`
// from a People page's `email:`. The parsing is pure and tested first; the
// tables need the real (scratch) database, because "derived" is a claim about
// what one walk rebuilds after a wipe, and "never guessed" is a claim about
// which files the walk is willing to believe. The DB half is skipped without a
// db. The read half — `people_by_email`'s normalisation and its refusal to
// choose between two pages — is `apps/console/test/seed-queries.test.ts`.
import { randomUUID } from "node:crypto";
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { Committer } from "../src/committer.js";
import { Vault } from "../src/vault.js";
import { Indexer, meetingRefPairs, personEmailPairs } from "../src/indexer.js";
import { emptyNoteMeta, isMeetingNotePath, meetingEventId, normaliseEmail, parseFrontmatter, personEmails, type NoteMeta } from "../src/notes.js";
import { tempRepo, type TempRepo } from "./helpers.js";
import { loadTestEnv, testDb } from "@foldedspacelabs/metistry-core/test-env";

const { hasDb } = loadTestEnv(new URL("../../../.env", import.meta.url)); // METISTRY_DB_* only (docs/ops/testing.md)

describe("event_id: and email: in frontmatter (pure)", () => {
  it("an event id is kept verbatim — case, punctuation and all — and a value that is not one whole id is none", () => {
    expect(meetingEventId("  7F3A2C1B-99D0:RecurrenceID/20260928T140000Z ")).toBe("7F3A2C1B-99D0:RecurrenceID/20260928T140000Z");
    expect(meetingEventId(4815162342)).toBe("4815162342"); // YAML reads a bare numeric id as a number
    expect(meetingEventId("")).toBeNull();
    expect(meetingEventId("   ")).toBeNull();
    expect(meetingEventId("abc\tdef")).toBeNull(); // a control character is not part of anyone's id
    expect(meetingEventId("x".repeat(1025))).toBeNull(); // refused, never cut to fit
    expect(meetingEventId(["a", "b"])).toBeNull();
    expect(meetingEventId({ id: "a" })).toBeNull();
    expect(meetingEventId(null)).toBeNull();
    expect(meetingEventId(true)).toBeNull();
  });

  it("an address is trimmed, un-mailto'd and lowercased; anything that is not plainly an address is dropped, not repaired", () => {
    expect(normaliseEmail(" Jim.Fallon@Example.COM ")).toBe("jim.fallon@example.com");
    expect(normaliseEmail("mailto:jim@example.com")).toBe("jim@example.com");
    expect(normaliseEmail("MAILTO:jim+work@example.co.uk")).toBe("jim+work@example.co.uk");
    for (const bad of ["Jim Fallon <jim@example.com>", "jim at example dot com", "jim@example", "@example.com", "jim@", "jim@@example.com", "jim fallon@example.com", "jim@example..com", "jim@.example.com", "[[Jim Fallon]]", "", `${"a".repeat(250)}@x.io`]) {
      expect(normaliseEmail(bad), bad).toBeNull();
    }
  });

  it("`email:` takes one address or a list; non-strings and invalid entries are skipped and duplicates collapse", () => {
    expect(personEmails("Jim@Example.com")).toEqual(["jim@example.com"]);
    expect(personEmails(["jim@example.com", "JIM@example.com", "j.fallon@work.example", 42, null, "not an address"])).toEqual(["jim@example.com", "j.fallon@work.example"]);
    expect(personEmails(undefined)).toEqual([]);
    expect(personEmails({ work: "jim@example.com" })).toEqual([]); // a map is not the schema, and is not guessed at
    expect(personEmails(Array.from({ length: 40 }, (_, i) => `p${i}@example.com`))).toHaveLength(16); // one page cannot flood the table
  });

  it("parseFrontmatter carries both fields, and a note without them carries none", () => {
    const { meta } = parseFrontmatter("---\nevent_id: EV-1\nemail:\n  - Jim@Example.com\n---\n# x\n");
    expect(meta.event_id).toBe("EV-1");
    expect(meta.emails).toEqual(["jim@example.com"]);
    expect(parseFrontmatter("# no frontmatter\n").meta).toEqual(emptyNoteMeta());
    expect(parseFrontmatter("---\nevent_id: [unclosed\n---\n").meta).toEqual(emptyNoteMeta()); // bad YAML is no frontmatter
  });

  it("a meeting note is a note under Journal/Meetings/, archived or not — nothing else", () => {
    expect(isMeetingNotePath("Journal/Meetings/2026-09-28-q4-planning.md")).toBe(true);
    expect(isMeetingNotePath("Journal/Meetings/2026/01/2026-01-05-q4-planning.md")).toBe(true);
    for (const p of ["Journal/2026-09-28.md", "Journal/Plan/2026-09-28.md", "Templates/Meeting.md", "Areas/Work/Meetings/x.md", "Journal/Meetings/x.png", "journal/meetings/x.md", "Journal/MeetingsX/x.md"]) {
      expect(isMeetingNotePath(p), p).toBe(false);
    }
  });

  it("only a People page the USER owns maps an address; an agent's page, a note elsewhere and a conflict copy never do", () => {
    const note = (path: string, meta: Partial<NoteMeta>, conflict = false) => ({ path, conflict, meta: { ...emptyNoteMeta(), ...meta } });
    const pairs = personEmailPairs([
      note("People/Jim Fallon.md", { emails: ["jim@example.com"] }),
      note("People/Ann Lee.md", { source: "user", emails: ["ann@example.com"] }),
      note("People/Eve.md", { source: "research-agent", emails: ["ceo@example.com"] }), // an agent's page claims the CEO's address
      note("Areas/Work/Contacts.md", { emails: ["bob@example.com"] }),
      note("People/Jim Fallon (conflict copy).md", { emails: ["jim@example.com"] }, true),
    ]);
    expect([...pairs.values()].sort()).toEqual([
      ["ann@example.com", "People/Ann Lee.md"],
      ["jim@example.com", "People/Jim Fallon.md"],
    ]);

    const refs = meetingRefPairs([
      note("Journal/Meetings/2026-09-28-q4.md", { event_id: "EV-1" }),
      note("Journal/Meetings/2026-09-28-q4-copy.md", { event_id: "EV-1" }), // two notes, one id: both kept, the reader decides
      note("Journal/2026-09-28.md", { event_id: "EV-2" }),
      note("Templates/Meeting.md", { event_id: "EV-3" }),
      note("Journal/Meetings/2026-09-28-empty.md", {}),
    ]);
    expect([...refs.values()].sort()).toEqual([
      ["EV-1", "Journal/Meetings/2026-09-28-q4-copy.md"],
      ["EV-1", "Journal/Meetings/2026-09-28-q4.md"],
    ]);
  });
});

// This suite takes the two tables it tests, and `knowledge_files` with them,
// for the reason `vault-tasks.integration.test.ts` gives: the walk owns
// them whole, so a leftover row is not noise here, it is a row this suite
// would delete and then miscount. `fileParallelism: false` is what makes it
// safe.
describe.skipIf(!hasDb)("meeting refs and people emails are derived by the walk (real db)", () => {
  let pool: pg.Pool;
  let repo: TempRepo;
  let indexer: Indexer;
  const MARKER = `Itest${randomUUID().replace(/-/g, "").slice(0, 8)}`;
  const MEET = `Journal/Meetings/2026-09-28-${MARKER.toLowerCase()}-q4.md`;
  const ARCHIVED = `Journal/Meetings/2026/01/2026-01-05-${MARKER.toLowerCase()}-kickoff.md`;
  const JIM = `People/${MARKER} Jim Fallon.md`;
  const ANN = `People/${MARKER} Ann Lee.md`;
  const EVE = `People/${MARKER} Eve.md`;

  const clean = async () => {
    await pool.query(`DELETE FROM vault_meeting_refs`);
    await pool.query(`DELETE FROM people_emails`);
    await pool.query(`DELETE FROM vault_tasks`);
    await pool.query(`DELETE FROM vault_task_refs`);
    await pool.query(`DELETE FROM knowledge_links`);
    await pool.query(`DELETE FROM knowledge_files`);
    await pool.query(`DELETE FROM runs WHERE component = 'reconciler'`);
  };
  const write = async (rel: string, lines: string[]) => {
    const abs = join(repo.root, rel);
    await mkdir(abs.slice(0, abs.lastIndexOf("/")), { recursive: true });
    await writeFile(abs, `${lines.join("\n")}\n`);
  };
  const refs = async () => (await pool.query(`SELECT event_id, path FROM vault_meeting_refs ORDER BY event_id COLLATE "C", path COLLATE "C"`)).rows;
  const emails = async () => (await pool.query(`SELECT email, path FROM people_emails ORDER BY email COLLATE "C", path COLLATE "C"`)).rows;

  beforeAll(async () => {
    pool = await testDb(pg.Pool);
    await clean();
    repo = await tempRepo(MARKER);
    const committer = new Committer(repo.git, { authorPrefix: "Metistry", authorEmail: "metistry@test" });
    const vault = new Vault(repo.root, repo.git, committer, { maxBytes: 65536 });
    indexer = new Indexer(pool, vault, committer, { commitExternalEdits: false });
  });
  afterAll(async () => {
    await repo.cleanup();
    await clean();
    await pool.end();
  });

  it("indexes a meeting note's event_id and a user's People page's addresses — and nothing a file did not say in its own field", async () => {
    await write(MEET, ["---", "source: user", "event_id: 7F3A2C1B-99D0:20260928T140000Z", "---", "# Q4 planning", "", "## Attendees", "", "- [[Jim Fallon]]"]);
    await write(ARCHIVED, ["---", "event_id: EV-KICKOFF", "---", "# Kickoff"]);
    await write(`Journal/Meetings/2026-09-29-${MARKER.toLowerCase()}-no-id.md`, ["# A meeting note typed by hand, no event"]);
    await write(`Journal/2026-09-28-${MARKER}.md`, ["---", "event_id: EV-DAILY", "---", "# not a meeting note"]);
    await write(JIM, ["---", "email:", "  - Jim.Fallon@Example.com", "  - mailto:jim@home.example", "  - Jim Fallon <jf@example.com>", "---", `# ${MARKER} Jim Fallon`]);
    await write(ANN, ["---", "source: user", "email: ann@example.com", "---", "# Ann"]);
    // an agent created this page (its source: is its own id) and claims an address the owner's meetings carry
    await write(EVE, ["---", "source: research-agent", "email: ceo@example.com", "---", "# Eve"]);
    // a person page with no address: the attendee named like it must NOT resolve to it
    await write(`People/${MARKER} Bob Stone.md`, [`# ${MARKER} Bob Stone`]);

    const s = await indexer.reconcile("test");
    expect(s).toMatchObject({ meeting_refs: 2, people_emails: 3 });
    expect(await refs()).toEqual([
      { event_id: "7F3A2C1B-99D0:20260928T140000Z", path: MEET }, // verbatim: ids are case-sensitive and opaque
      { event_id: "EV-KICKOFF", path: ARCHIVED }, // §5.2's archive keeps its link
    ]);
    expect(await emails()).toEqual([
      { email: "ann@example.com", path: ANN },
      { email: "jim.fallon@example.com", path: JIM },
      { email: "jim@home.example", path: JIM },
    ]);
  });

  it("**an unmatched attendee never resolves to a page**: no row exists for an address no page claims, whatever the names", async () => {
    const lookup = async (email: string) => (await pool.query(`SELECT path FROM people_emails WHERE email = $1`, [email])).rows;
    expect(await lookup("bob.stone@example.com")).toEqual([]); // `People/… Bob Stone.md` exists, and says no address
    expect(await lookup("jf@example.com")).toEqual([]); // written in a shape the parser would not guess at
    expect(await lookup("ceo@example.com")).toEqual([]); // claimed only by a page the owner did not write
    expect(await lookup("jim@example.com")).toEqual([]); // a near miss is a miss
  });

  it("a second walk with nothing changed writes nothing and says the same", async () => {
    const before = [await refs(), await emails()];
    const s = await indexer.reconcile("test");
    expect(s).toMatchObject({ meeting_refs: 2, people_emails: 3 });
    expect([await refs(), await emails()]).toEqual(before);
  });

  it("an edit, a rename and a delete move the rows with the files", async () => {
    await write(ANN, ["---", "source: user", "email: ann.lee@work.example", "---", "# Ann"]);
    const moved = `Journal/Meetings/2026-09-28-${MARKER.toLowerCase()}-q4-planning.md`;
    await rename(join(repo.root, MEET), join(repo.root, moved));
    await unlink(join(repo.root, ARCHIVED));
    // the owner takes over the agent's page: now it is theirs, and its address counts
    await write(EVE, ["---", "source: user", "email: eve@example.com", "---", "# Eve"]);

    await indexer.reconcile("test");
    expect(await refs()).toEqual([{ event_id: "7F3A2C1B-99D0:20260928T140000Z", path: moved }]);
    expect(await emails()).toEqual([
      { email: "ann.lee@work.example", path: ANN },
      { email: "eve@example.com", path: EVE },
      { email: "jim.fallon@example.com", path: JIM },
      { email: "jim@home.example", path: JIM },
    ]);
  });

  it("rebuilds both tables exactly after a wipe (derived, invariant 1)", async () => {
    const before = [await refs(), await emails()];
    expect(before[0]!.length + before[1]!.length).toBeGreaterThan(3);

    // the whole index, as `docker compose down -v` would leave it
    await clean();
    await indexer.reconcile("test");
    expect([await refs(), await emails()]).toEqual(before);
  });
});
