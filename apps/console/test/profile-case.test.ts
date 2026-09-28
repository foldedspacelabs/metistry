// A profile whose file is `Me/Profile.md` while the product reads
// `Me/profile.md` (the 0.14.2 owner instance, seeded 2026-09-06): over the
// REAL vault bridge, the console's client and the runner's log line must say
// what is actually there, not "(invalid request)". No database — the runner's
// `runs` go to the in-memory fake.
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PROFILE_PATH, mintToken } from "@foldedspacelabs/metistry-core";
import { VaultError } from "@foldedspacelabs/metistry-artifacts";
import { httpVaultClient } from "../src/vault-client.js";
import { profileFacts, tick, type ScheduledCollector } from "../src/runner.js";
import { Committer } from "../../reconciler/src/committer.js";
import { Vault } from "../../reconciler/src/vault.js";
import { makeBridge } from "../../reconciler/src/server.js";
import { tempRepo, type TempRepo } from "../../reconciler/test/helpers.js";
import { FakeRuns } from "./runs-fake.js";

const HINT = "Me/Profile.md exists — the product's name is Me/profile.md";

describe("a profile spelled Me/Profile.md, read as Me/profile.md", () => {
  const token = mintToken();
  let repo: TempRepo;
  let bridge: ReturnType<typeof makeBridge>;
  let url: string;

  beforeAll(async () => {
    repo = await tempRepo();
    const committer = new Committer(repo.git, { authorPrefix: "Metistry", authorEmail: "metistry@test", sourceTrailer: "Brain-Source" });
    bridge = makeBridge({ vault: new Vault(repo.root, repo.git, committer, { maxBytes: 64 * 1024 }), committer }, { token, maxBodyBytes: 64 * 1024 });
    await new Promise<void>((r) => bridge.listen(0, "127.0.0.1", r));
    url = `http://127.0.0.1:${(bridge.address() as AddressInfo).port}`;
    await mkdir(join(repo.root, "Me"), { recursive: true });
    await writeFile(join(repo.root, "Me", "Profile.md"), "---\ntimezone: America/New_York\nworking_days: [mon, tue, wed, thu, fri]\n---\n");
  });
  afterAll(async () => {
    await new Promise<void>((r) => bridge.close(() => r()));
    await repo.cleanup();
  });

  it("the client throws not_found carrying the bridge's hint — a mis-cased file is not an absent one — and an absent file is still null", async () => {
    const vault = httpVaultClient({ url, token });
    const err = await vault.read(PROFILE_PATH).catch((e) => e);
    expect(err).toBeInstanceOf(VaultError);
    expect(err.code).toBe("not_found");
    expect(err.message).toBe(HINT);
    expect(await vault.read("Me/nobody.md")).toBeNull();
  });

  it("the runner's log line prints the hint, and the schedule that follows the profile waits rather than guessing", async () => {
    const vault = httpVaultClient({ url, token });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const db = new FakeRuns(new Date("2026-09-21T11:00:00Z")); // Monday 07:00 in New York
      let ran = 0;
      const brief: ScheduledCollector = {
        name: "morning-brief",
        dir: "routines/morning-brief",
        schedule: { days: "working_days", at: ["07:00"] },
        runKind: "routine_run",
        requires: { env: [], reachable: [], engine: false },
        run: async () => (ran++, 0),
      };
      // exactly main.ts's reader
      const profile = async () => profileFacts((await vault.read(PROFILE_PATH))?.content.toString("utf8") ?? null);
      await tick(db, [brief], {}, { env: {}, timeZone: null, profile, requests: null, now: db.now, startedAt: db.now });
      expect(ran).toBe(0);
      const lines = warn.mock.calls.map((c) => String(c[0]));
      expect(lines).toContain(`runner: ${PROFILE_PATH} could not be read (${HINT}) — schedules that follow it wait for the next tick`);
    } finally {
      warn.mockRestore();
    }
  });
});
