// `metistry vault settings` (M18, §2.21, T10-2) and doctor's vault sync row:
// the policy as a person reads it, the block written back without touching a
// line around it, the protected write through the reconciler as `user`, and
// the row's ahead / behind / last push / conflict.
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { parseDeployment, type VaultStatus } from "@foldedspacelabs/metistry-core";
import { vaultSyncRow } from "../src/doctor.js";
import { main } from "../src/main.js";
import { applyVaultToYaml, loadVaultSettings, renderVaultSettings, setVaultSettings } from "../src/vault.js";
import { checkout, fakeExec, put } from "./fixtures.js";

async function instanceWith(content?: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "metistry-vault-inst-"));
  await mkdir(join(dir, ".metistry"), { recursive: true });
  if (content !== undefined) await writeFile(join(dir, ".metistry", "deployment.yaml"), content);
  return dir;
}

const noFetch = (async () => new Response("{}")) as unknown as typeof fetch;

describe("applyVaultToYaml", () => {
  it("appends the block and leaves every other line byte for byte", () => {
    const existing = "# a comment nobody should lose\nshape: launchd\nkeep_awake: always\n\nservices:\n  db:\n    shape: compose\n";
    const out = applyVaultToYaml(existing, { push: "after_commit", pull: { every: "5m" } }, "launchd");
    expect(out.startsWith(existing)).toBe(true);
    expect(parseDeployment(parseYaml(out)).vault).toEqual({ push: "after_commit", pull: { every: "5m" } });
    expect(parseDeployment(parseYaml(out)).services).toEqual({ db: { shape: "compose" } });
  });

  it("replaces an existing block in place — its own lines only — rather than adding a second", () => {
    const existing = "shape: launchd\nvault:\n  push: manual\n  pull:\n    every: 10m\n\nservices: {}\n# trailing\n";
    const out = applyVaultToYaml(existing, { push: { every: "15m" }, pull: { every: "10m" } }, "launchd");
    expect(out).toBe("shape: launchd\nvault:\n  push:\n    every: 15m\n  pull:\n    every: 10m\n\nservices: {}\n# trailing\n");
    expect(out.match(/^vault:/gm)).toHaveLength(1);
    // and a flow-style block on one line
    const flow = applyVaultToYaml("shape: compose\nvault: {push: manual}\nservices: {}\n", { push: "after_commit", pull: { every: "5m" } }, "compose");
    expect(parseDeployment(parseYaml(flow)).vault).toEqual({ push: "after_commit", pull: { every: "5m" } });
    expect(flow).toContain("services: {}");
  });

  it("a fresh file carries the shape ALREADY in effect, so answering one question never answers another", () => {
    const out = applyVaultToYaml(undefined, { push: "manual", pull: { every: "1h" } }, "launchd");
    const d = parseDeployment(parseYaml(out));
    expect(d.shape).toBe("launchd");
    expect(d.vault).toEqual({ push: "manual", pull: { every: "1h" } });
  });
});

describe("metistry vault settings — reading", () => {
  it("names where each answer came from: the instance, the seed, the default — and the old variable's override", async () => {
    const P = await checkout();
    const I = await instanceWith("shape: compose\nvault:\n  push: manual\nservices: {}\n");
    let s = await loadVaultSettings(P, { METISTRY_INSTANCE_DIR: I });
    expect(s.policy.push).toBe("manual");
    expect(s.from.push).toBe(join(I, ".metistry", "deployment.yaml"));
    expect(s.policy.pull).toEqual({ every: "5m" });
    expect(s.from.pull).toBe("the default");

    await put(P, "seed/deployment.yaml", "shape: compose\nvault:\n  pull:\n    every: 10m\nservices: {}\n");
    s = await loadVaultSettings(P, { METISTRY_INSTANCE_DIR: I, METISTRY_PUSH_SCHEDULE: "@hourly" });
    expect(s.from.pull).toBe("seed/deployment.yaml");
    expect(s.policy.push).toEqual({ every: "1h" });
    expect(s.from.push).toMatch(/^METISTRY_PUSH_SCHEDULE \(overriding .*deployment\.yaml\)$/);
    const text = renderVaultSettings(s);
    expect(text).toContain("every 1h");
    expect(text).toContain("honoured for this release only");
  });

  it("through main: shows it, and --json is the machine's copy", async () => {
    const P = await checkout();
    const I = await instanceWith("shape: compose\nservices: {}\n");
    const out: string[] = [];
    expect(await main(["vault", "settings", "--json", "--product-dir", P, "--instance", I], { out: (l) => out.push(l), err: () => {} })).toBe(0);
    expect(JSON.parse(out.join("\n")).policy).toMatchObject({ push: "after_commit", pull: { every: "5m" } });
  });

  it("refuses a bad value and an unknown verb, and writes nothing", async () => {
    const P = await checkout();
    const I = await instanceWith("shape: compose\nservices: {}\n");
    const errs: string[] = [];
    expect(await main(["vault", "settings", "--push", "never", "--yes", "--product-dir", P, "--instance", I], { out: () => {}, err: (l) => errs.push(l) })).toBe(1);
    expect(errs.join("\n")).toMatch(/--push must be after_commit, manual, or an interval/);
    expect(await main(["vault", "settings", "--pull", "never", "--yes", "--product-dir", P, "--instance", I], { out: () => {}, err: (l) => errs.push(l) })).toBe(1);
    expect(errs.join("\n")).toMatch(/there is no "never"/);
    expect(await main(["vault", "rollback", "--product-dir", P], { out: () => {}, err: (l) => errs.push(l) })).toBe(2);
    expect(await readFile(join(I, ".metistry", "deployment.yaml"), "utf8")).toBe("shape: compose\nservices: {}\n");
  });
});

describe("metistry vault settings — writing", () => {
  it("previews without --yes and writes nothing", async () => {
    const P = await checkout();
    const I = await instanceWith("shape: launchd\nservices: {}\n");
    const lines: string[] = [];
    const r = await setVaultSettings({ productDir: P, instanceDir: I, push: { every: "15m" }, env: { METISTRY_INSTANCE_DIR: I }, platform: "linux", uid: 501, fetchFn: noFetch, exec: fakeExec(), out: (l) => lines.push(l) });
    expect(r.applied).toBe(false);
    expect(lines.join("\n")).toContain("vault sync: push every 15m, pull every 5m");
    expect(lines.join("\n")).toContain("[dry-run] write");
    expect(await readFile(join(I, ".metistry", "deployment.yaml"), "utf8")).toBe("shape: launchd\nservices: {}\n");
  });

  it("--yes writes it; --pull alone keeps the push already chosen; the file states both", async () => {
    const P = await checkout();
    const I = await instanceWith("shape: launchd\nvault:\n  push: manual\nservices: {}\n");
    const r = await setVaultSettings({ productDir: P, instanceDir: I, pull: { every: "10m" }, yes: true, env: { METISTRY_INSTANCE_DIR: I }, platform: "linux", uid: 501, fetchFn: noFetch, exec: fakeExec(), out: () => {} });
    expect(r.applied).toBe(true);
    const written = await readFile(join(I, ".metistry", "deployment.yaml"), "utf8");
    expect(parseDeployment(parseYaml(written))).toMatchObject({ shape: "launchd", vault: { push: "manual", pull: { every: "10m" } } });
  });

  it("goes through the reconciler as the user principal when one is configured (invariant 2)", async () => {
    const P = await checkout();
    const I = await instanceWith("shape: launchd\nservices: {}\n");
    const posted: { url: string; auth: string; body: any }[] = [];
    const fetchFn = (async (url: string, init: RequestInit) => {
      posted.push({ url: String(url), auth: String((init.headers as Record<string, string>).authorization), body: JSON.parse(String(init.body)) });
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    await setVaultSettings({
      productDir: P,
      instanceDir: I,
      push: "after_commit",
      yes: true,
      env: { METISTRY_INSTANCE_DIR: I, METISTRY_RECONCILER_URL: "http://127.0.0.1:7812", METISTRY_BRIDGE_TOKEN_RECONCILER: "t", METISTRY_BRIDGE_TOKEN_RECONCILER_USER: "owner-t" },
      platform: "darwin",
      uid: 501,
      fetchFn,
      exec: fakeExec(),
      out: () => {},
    });
    expect(posted).toHaveLength(1);
    expect(posted[0]!.url).toContain("/vault/write");
    expect(posted[0]!.auth).toBe("Bearer owner-t");
    expect(posted[0]!.body.path).toBe(".metistry/deployment.yaml");
    expect(posted[0]!.body.intent.principal).toBe("user");
    expect(parseDeployment(parseYaml(posted[0]!.body.content)).vault).toEqual({ push: "after_commit", pull: { every: "5m" } });
  });

  it("never writes the old variable's value into the file, and says it still overrides", async () => {
    const P = await checkout();
    const I = await instanceWith("shape: compose\nvault:\n  push: after_commit\nservices: {}\n");
    const lines: string[] = [];
    await setVaultSettings({ productDir: P, instanceDir: I, pull: { every: "30m" }, yes: true, env: { METISTRY_INSTANCE_DIR: I, METISTRY_PUSH_SCHEDULE: "@hourly" }, platform: "linux", uid: 501, fetchFn: noFetch, exec: fakeExec(), out: (l) => lines.push(l) });
    const written = parseDeployment(parseYaml(await readFile(join(I, ".metistry", "deployment.yaml"), "utf8")));
    expect(written.vault).toEqual({ push: "after_commit", pull: { every: "30m" } });
    expect(lines.join("\n")).toContain("METISTRY_PUSH_SCHEDULE=@hourly");
    expect(lines.join("\n")).toContain("Until then push stays every 1h");
  });

  it("says nothing to change when the file already states the answer", async () => {
    const P = await checkout();
    const I = await instanceWith("shape: compose\nvault:\n  push: manual\n  pull:\n    every: 5m\nservices: {}\n");
    const lines: string[] = [];
    const r = await setVaultSettings({ productDir: P, instanceDir: I, push: "manual", yes: true, env: { METISTRY_INSTANCE_DIR: I }, platform: "linux", uid: 501, fetchFn: noFetch, exec: fakeExec(), out: (l) => lines.push(l) });
    expect(r.applied).toBe(false);
    expect(lines.join("\n")).toContain("nothing to change");
  });
});

describe("doctor's vault sync row", () => {
  const base: VaultStatus = {
    branch: "main",
    remote: "origin",
    ahead: 2,
    behind: 0,
    last_commit: { sha: "abc", subject: "Tick", author: "user", at: "2026-09-28T12:58:01.000Z" },
    last_push: { at: "2026-09-28T12:30:00.000Z", ok: true, remote: "origin" },
    last_pull: null,
    conflict: null,
    policy: { push: "after_commit", pull: { every: "5m" } },
    as_of: "2026-09-28T13:05:00.000Z",
  };
  const env = { METISTRY_RECONCILER_URL: "http://127.0.0.1:7812", METISTRY_BRIDGE_TOKEN_RECONCILER: "t" };
  const row = (body: unknown, status = 200) => {
    const asked: string[] = [];
    const fetchFn = (async (url: string, init: RequestInit) => {
      asked.push(`${String(url)} ${String((init.headers as Record<string, string>).authorization)}`);
      return new Response(JSON.stringify(body), { status });
    }) as unknown as typeof fetch;
    return vaultSyncRow({ env, shape: "launchd", fetchFn, timeoutMs: 1000 }).then((r) => ({ r, asked }));
  };

  it("ok: ahead, behind, last push, conflict and the policy, in the probe's summary and meta", async () => {
    const { r, asked } = await row(base);
    expect(asked).toEqual(["http://127.0.0.1:7812/vault/status Bearer t"]);
    expect(r.status).toBe("ok");
    expect(r.kind).toBe("vault");
    expect(r.meta).toMatchObject({ ahead: 2, behind: 0, conflict: null, summary: "2 ahead, 0 behind origin; last push 2026-09-28T12:30:00.000Z ok; no conflict; push after_commit, pull every 5m" });
  });

  it("degraded, never failed: a conflict, a failed push, a failed pull, a policy file that does not validate, the old variable", async () => {
    const cases: Array<[Partial<VaultStatus>, RegExp]> = [
      [{ conflict: { paths: ["now.md", "Areas/Beta.md"] } }, /conflict: a pull could not integrate now\.md, Areas\/Beta\.md/],
      [{ last_push: { at: base.as_of, ok: false, remote: "origin", error: "! [rejected] main -> main (fetch first)" } }, /last push failed \(! \[rejected\]/],
      [{ last_pull: { at: base.as_of, ok: false, remote: "origin", error: "fatal: unable to access" } }, /last pull failed/],
      [{ policy: { push: "manual", pull: { every: "5m" }, error: "vault.push: Invalid input" } }, /does not validate/],
      [{ policy: { push: { every: "1h" }, pull: { every: "5m" }, push_override: "@hourly" } }, /METISTRY_PUSH_SCHEDULE=@hourly .* honoured for this release only/],
    ];
    for (const [over, want] of cases) {
      const { r } = await row({ ...base, ...over });
      expect(r.status, JSON.stringify(over)).toBe("degraded");
      expect(r.remediation).toMatch(want);
    }
  });

  it("absent with no remote, with no bridge configured, and when the reconciler does not answer; degraded for an older reconciler", async () => {
    expect((await row({ ...base, remote: null, ahead: null, behind: null })).r).toMatchObject({ status: "absent", remediation: expect.stringContaining("metistry connect-repo") });
    expect((await vaultSyncRow({ env: {}, shape: "launchd", fetchFn: noFetch, timeoutMs: 1000 })).status).toBe("absent");
    const down = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    expect((await vaultSyncRow({ env, shape: "launchd", fetchFn: down, timeoutMs: 1000 })).status).toBe("absent");
    expect((await row({ error: { code: "not_found" } }, 404)).r.status).toBe("degraded");
    expect((await row({ ...base, surprise: true })).r.status).toBe("degraded");
  });
});
