// `standup_days` / `standup_time` left in Me/profile.md (design-build-plan
// §2.5, §4 Q13; ticket T3-4): one INFO line naming them, never a finding —
// the owner Declined the tidy, or has not answered it, and the lines are
// simply ignored.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { profileRow, renderTable, type DoctorReport } from "../src/doctor.js";

const dirs: string[] = [];
async function instance(profile?: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "metistry-doctor-profile-"));
  dirs.push(dir);
  if (profile !== undefined) {
    await mkdir(join(dir, "Me"), { recursive: true });
    await writeFile(join(dir, "Me", "profile.md"), profile);
  }
  return dir;
}
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

describe("doctor: the standup lines left in Me/profile.md", () => {
  it("no row at all when the profile has neither key, or there is no profile", async () => {
    expect(await profileRow(await instance("---\nworking_days: [mon, tue]\n---\n"))).toBeNull();
    expect(await profileRow(await instance())).toBeNull();
  });

  it("one info line naming the keys — ok, never a finding", async () => {
    const row = await profileRow(await instance('---\nstandup_days: [mon, tue]\nstandup_time: "09:15"\n---\n'));
    expect(row).toMatchObject({ kind: "instance", name: "profile", status: "ok", meta: { ignored: ["standup_days", "standup_time"] } });
    expect(row?.meta?.["info"]).toMatch(/standup_days, standup_time — ignored/);
    expect(row?.meta?.["info"]).toMatch(/Tidy Me\/profile\.md/);
  });

  it("names a key it cannot read, and says why", async () => {
    const row = await profileRow(await instance("---\nstandup_time: after coffee\n---\n"));
    expect(row).toMatchObject({ status: "ok", meta: { ignored: ["standup_time"] } });
    expect(row?.meta?.["info"]).toMatch(/cannot be read \(standup_time is not a time of day/);
  });

  it("the table shows an ok row's info line — and still nothing under any other ok row", async () => {
    const row = (await profileRow(await instance("---\nstandup_time: 09:15\n---\n")))!;
    const plain = { kind: "instance", name: "inbox", status: "ok" as const, latency_ms: 0, probe: "a probe that is noise" };
    const report: DoctorReport = { as_of: "2026-09-26T00:00:00Z", product_dir: "/p", shape: "launchd", ok: true, rows: [row, plain] };
    const text = renderTable(report);
    expect(text).toMatch(/standup_time — ignored/);
    expect(text).not.toMatch(/a probe that is noise/);
    expect(text).toMatch(/0 failed/);
  });
});
