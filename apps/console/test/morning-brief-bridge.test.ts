// The Morning Brief end to end over the REAL vault bridge (T3-6): the
// console's own client (`httpVaultClient`, its new `section` verb) against the
// reconciler's `makeBridge` on a throwaway repo, and the assistant's fill
// through mcp-brain's real `knowledge_write` over the same bridge. No
// database — the routine's `runs` bookkeeping goes to a fake.
//
// What only the real bridge can prove:
//
//  - the brief's file and the daily note's section are ONE commit, in the
//    routine's name, with the run's trailer (§2.21 — the act is the run);
//  - the assistant's fill is a SECOND commit, still in the routine's name
//    (ruling (a): the folder is written under the routine's principal),
//    carrying the reply's turn — and it touches the brief's file only;
//  - **no generated text reaches the owner's note**: the bytes between the
//    markers are the routine's before and after the turn, and the owner's
//    bytes outside them never moved;
//  - a broken marker is the bridge's `section_missing`, and it arrives at the
//    routine as that code.
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PROFILE_PATH, mintToken, pendingProseSlots, scanNoteSection } from "@foldedspacelabs/metistry-core";
import { sha256Text, vaultBridgeWriter, writeKnowledge, type AgentPrincipal } from "@foldedspacelabs/metistry-mcp-brain";
import { routineCode, type BriefCtx, type Db } from "@metistry-apps/routines";
import { httpVaultClient } from "../src/vault-client.js";
import { Committer } from "../../reconciler/src/committer.js";
import { Vault } from "../../reconciler/src/vault.js";
import { makeBridge } from "../../reconciler/src/server.js";
import { tempRepo, type TempRepo } from "../../reconciler/test/helpers.js";

const SEED = fileURLToPath(new URL("../../../seed/vault/", import.meta.url));
const TZ = "America/New_York";
const SLOT = new Date("2026-09-28T11:00:00Z");
const DATE = "2026-09-28";
const dailyNotePath = (date: string): string => `Journal/${date}.md`;
const NOTE = dailyNotePath(DATE);
const BRIEF = `Journal/Brief/${DATE}.md`;
/** The routine as the runner finds it: by name, through the registry's code lookup. */
let morningBrief: (db: Db, ctx: BriefCtx) => Promise<number>;
const DAILY = `---\nsource: user\n---\n# ${DATE}\n\n- [ ] the owner's own task\n\n## Today · Metistry\n\n<!-- metistry:day -->\n<!-- /metistry:day -->\n\n## Later\n\nthe owner's afternoon\n`;
const assistant: AgentPrincipal = { id: "assistant", kind: "internal", grants: { tier: "areas", areas: ["/"] }, projects: [] };

/** The routine's own bookkeeping, as far as it reads it back: its `brief_for` rows. */
function fakeRunsDb() {
  const inserted: Record<string, any>[] = [];
  const proposals: unknown[] = [];
  return {
    inserted,
    proposals,
    async query(text: string, values: unknown[] = []) {
      if (text.includes("brief_for")) return { rows: inserted.filter((m) => m.brief_for === values[1] && m.outcome === "acted") };
      if (text.includes("INSERT INTO runs")) inserted.push(JSON.parse(String(values[1])));
      if (text.includes("FROM proposals")) return { rows: [] };
      if (text.includes("INSERT INTO proposals")) proposals.push(JSON.parse(String(values[1])));
      if (text.includes("INSERT INTO inbound_messages")) return { rows: [{ id: 1 }] };
      if (text.includes("count(*) FILTER")) return { rows: [{ runs_ok: 0, turns: 0, captures: 0, failures: 0, spend: 0 }] };
      return { rows: [] };
    },
  };
}

function between(bytes: Buffer): Buffer {
  const scan = scanNoteSection(bytes, "day");
  if (scan.state !== "present") throw new Error(`no section: ${scan.state}`);
  return bytes.subarray(scan.innerStart, scan.innerEnd);
}
function outside(bytes: Buffer): Buffer {
  const scan = scanNoteSection(bytes, "day");
  if (scan.state !== "present") throw new Error(`no section: ${scan.state}`);
  return Buffer.concat([bytes.subarray(0, scan.innerStart), bytes.subarray(scan.innerEnd)]);
}

describe("the Morning Brief over the real vault bridge", () => {
  const token = mintToken();
  let repo: TempRepo;
  let bridge: ReturnType<typeof makeBridge>;
  let url: string;
  const put = async (rel: string, text: string) => {
    await mkdir(join(repo.root, rel, ".."), { recursive: true });
    await writeFile(join(repo.root, rel), text);
  };
  const onDisk = (rel: string) => readFile(join(repo.root, rel));
  const flush = async () => (await (await fetch(`${url}/flush`, { method: "POST", headers: { authorization: `Bearer ${token}` } })).json()) as { commits: { sha: string; paths: string[] }[] };

  beforeAll(async () => {
    const code = await routineCode("morning-brief");
    if (typeof code !== "function") throw new Error(code.missing);
    morningBrief = code as (db: Db, ctx: BriefCtx) => Promise<number>; // the registry types every run by the widest ctx; this one takes the brief's
    repo = await tempRepo();
    const committer = new Committer(repo.git, { authorPrefix: "Metistry", authorEmail: "metistry@test", sourceTrailer: "Brain-Source" });
    const db = { async query() { return { rows: [{ id: 1 }] }; } };
    bridge = makeBridge({ vault: new Vault(repo.root, repo.git, committer, { maxBytes: 256 * 1024 }), committer, db }, { token, maxBodyBytes: 512 * 1024 });
    await new Promise<void>((r) => bridge.listen(0, "127.0.0.1", r));
    url = `http://127.0.0.1:${(bridge.address() as AddressInfo).port}`;
    await put("Templates/Brief.md", readFileSync(`${SEED}Templates/Brief.md`, "utf8"));
    await put(PROFILE_PATH, `---\nsource: user\ntimezone: ${TZ}\nworking_days: [mon, tue, wed, thu, fri]\n---\n`);
    await put(NOTE, DAILY);
    await repo.git.run(["add", "-A"]);
    await repo.git.run(["-c", "user.name=seed", "-c", "user.email=seed@test", "commit", "-q", "-m", "owner's files"]);
  });
  afterAll(async () => {
    await new Promise<void>((r) => bridge.close(() => r()));
    await repo.cleanup();
  });

  it("file + section are one commit in the routine's name; the turn's fill is a second, still the routine's, and never reaches the note", async () => {
    const vault = httpVaultClient({ url, token });
    const events = [{ title: "Design review", start: `${DATE}T13:30:00Z`, end: `${DATE}T14:00:00Z`, all_day: false, attendees: ["Jim Fallon"] }];
    const db = fakeRunsDb();
    expect(await morningBrief(db, { vault, calendar: { events: async () => events }, now: SLOT, scheduledFor: SLOT, timeZone: TZ, env: {}, runId: 4242 })).toBe(1);
    expect(db.inserted).toEqual([expect.objectContaining({ brief_for: DATE, outcome: "acted", day_section: "written", prose_slots: 2 })]);

    const first = await flush();
    expect(first.commits).toHaveLength(1);
    expect([...first.commits[0]!.paths].sort()).toEqual([NOTE, BRIEF].sort());
    const msg = await repo.git.run(["show", "-s", "--format=%an%n%B", first.commits[0]!.sha]);
    expect(msg.split("\n")[0]).toBe("Metistry morning-brief");
    expect(msg).toContain("Metistry-Run: 4242");
    expect(msg).toContain("Brain-Source: morning-brief");

    const note = await onDisk(NOTE);
    const inside = between(note);
    expect(outside(note).equals(outside(Buffer.from(DAILY)))).toBe(true); // the owner's bytes, untouched
    expect(inside.toString("utf8")).toContain("9:30 AM–10:00 AM · Design review · with Jim Fallon");

    // the ONE turn: knowledge_read, fill, knowledge_write — mcp-brain's real tool body over the real bridge
    const read = async (p: string) => (await vault.read(p))?.content.toString("utf8") ?? null;
    const brief = (await read(BRIEF))!;
    const slots = pendingProseSlots(brief);
    const filled = brief.split("\n").map((line, i) => { const s = slots.find((x) => x.line === i); return s ? `${s.prefix}GENERATED slot ${s.index}` : line; }).join("\n");
    const writer = vaultBridgeWriter({ url, token });
    const r = await writeKnowledge(assistant, { path: BRIEF, content: filled, message: "the brief's prose", expected_sha256: sha256Text(brief) }, writer, SLOT, read, { turnId: "turn-9", runId: 77 });
    expect(r).toMatchObject({ ok: true, result: { filled: [1, 2] } });

    const second = await flush();
    expect(second.commits).toHaveLength(1);
    expect(second.commits[0]!.paths).toEqual([BRIEF]);
    const msg2 = await repo.git.run(["show", "-s", "--format=%an%n%B", second.commits[0]!.sha]);
    expect(msg2.split("\n")[0]).toBe("Metistry morning-brief");
    expect(msg2).toContain("Metistry-Turn: turn-9");
    expect((await read(BRIEF))!).toContain("GENERATED slot 2 <!-- metistry:written 2 -->");
    expect((await read(BRIEF))!).toContain("source: morning-brief");

    // the owner's note: not one byte different from the routine's write
    expect((await onDisk(NOTE)).equals(note)).toBe(true);
    expect((await onDisk(NOTE)).toString("utf8")).not.toContain("GENERATED");

    // and the tool cannot be pointed at the note instead
    const noteText = (await read(NOTE))!;
    const into = await writeKnowledge(assistant, { path: NOTE, content: noteText.replace("<!-- /metistry:day -->", "GENERATED\n<!-- /metistry:day -->"), message: "m", expected_sha256: sha256Text(noteText) }, writer, SLOT, read);
    expect(into).toMatchObject({ ok: false, code: "forbidden" });
    expect((await onDisk(NOTE)).equals(note)).toBe(true);
  });

  it("the section door's own refusals reach the routine by code: a broken marker is section_missing → one note request, nothing written", async () => {
    const day = "2026-09-29";
    const broken = `# ${day}\n\n<!-- metistry:day -->\nno closer\n`;
    await put(dailyNotePath(day), broken);
    const vault = httpVaultClient({ url, token });
    // straight at the door first: the client surfaces the bridge's own code
    await expect(vault.section(dailyNotePath(day), "day", "x", "morning-brief", sha256Text(broken))).rejects.toMatchObject({ code: "section_missing" });
    await expect(vault.section(dailyNotePath(day), "day", "x", "assistant", sha256Text(broken))).rejects.toMatchObject({ code: "forbidden" });

    const db = fakeRunsDb();
    const slot = new Date(`${day}T11:00:00Z`);
    await morningBrief(db, { vault, calendar: null, now: slot, scheduledFor: slot, timeZone: TZ, env: {} });
    expect(db.inserted[0]).toMatchObject({ day_section: "section_missing", day_section_reason: "unpaired" });
    expect(db.proposals).toHaveLength(1);
    expect((await onDisk(dailyNotePath(day))).toString("utf8")).toBe(broken);
  });
});
