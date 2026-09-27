// The vault's sync policy (§2.21, T10-2): the `vault:` block of
// deployment.yaml, its overlay, the old variable's one-release override, and
// the status body's schema.
import { describe, expect, it } from "vitest";
import { overlayDeployment, parseDeployment } from "../src/deployment.js";
import {
  describeVaultSync,
  intervalSeconds,
  parsePullArg,
  parsePushArg,
  pushFromSchedule,
  resolveVaultSync,
  VAULT_SYNC_DEFAULT,
  vaultStatusSchema,
} from "../src/vault-sync.js";

describe("the vault: block", () => {
  it("parses the three push policies and a pull interval", () => {
    expect(parseDeployment({ vault: { push: "after_commit", pull: { every: "5m" } } }).vault).toEqual({ push: "after_commit", pull: { every: "5m" } });
    expect(parseDeployment({ vault: { push: "manual" } }).vault).toEqual({ push: "manual" });
    expect(parseDeployment({ vault: { push: { every: "15m" } } }).vault).toEqual({ push: { every: "15m" } });
  });

  it("refuses what it does not know, loudly: a misspelled policy, `never` for pull, an interval outside 1m…24h, an unknown key", () => {
    expect(() => parseDeployment({ vault: { push: "after-commit" } })).toThrow(/vault\.push/);
    expect(() => parseDeployment({ vault: { pull: "never" } })).toThrow(/vault\.pull/);
    expect(() => parseDeployment({ vault: { pull: { every: "10s" } } })).toThrow(/outside 1m…24h/);
    expect(() => parseDeployment({ vault: { push: { every: "25h" } } })).toThrow(/outside 1m…24h/);
    expect(() => parseDeployment({ vault: { push: { every: "soon" } } })).toThrow(/not an interval/);
    expect(() => parseDeployment({ vault: { push: "manual", fetch: true } })).toThrow();
  });

  it("an absent block is the default, and so is an absent key", () => {
    expect(parseDeployment({}).vault).toBeUndefined();
    const r = resolveVaultSync(undefined);
    expect({ push: r.push, pull: r.pull }).toEqual(VAULT_SYNC_DEFAULT);
    expect(r.pull_every_sec).toBe(300);
    expect(r.push_every_sec).toBe(0);
    expect(resolveVaultSync({ push: "manual" }).pull).toEqual({ every: "5m" });
    expect(resolveVaultSync({ pull: { every: "1h" } }).push).toBe("after_commit");
  });

  it("the overlay merges per key: the instance's push keeps the seed's pull", () => {
    const seed = parseDeployment({ vault: { push: { every: "1h" }, pull: { every: "10m" } } });
    const inst = parseDeployment({ shape: "launchd", vault: { push: "manual" } });
    expect(overlayDeployment(seed, inst).vault).toEqual({ push: "manual", pull: { every: "10m" } });
    expect(overlayDeployment(seed, parseDeployment({})).vault).toEqual(seed.vault);
    expect(overlayDeployment(parseDeployment({}), parseDeployment({})).vault).toBeUndefined();
  });

  it("intervals in seconds", () => {
    expect(intervalSeconds("90s")).toBe(90);
    expect(intervalSeconds("15m")).toBe(900);
    expect(intervalSeconds("2h")).toBe(7200);
    expect(intervalSeconds("0m")).toBeUndefined();
    expect(intervalSeconds("5")).toBeUndefined();
  });
});

describe("METISTRY_PUSH_SCHEDULE, kept one release as an override of push", () => {
  it("keeps its grammar exactly", () => {
    expect(pushFromSchedule(undefined)).toBeUndefined();
    expect(pushFromSchedule("")).toBeUndefined();
    expect(pushFromSchedule("never")).toEqual({ push: "manual", seconds: 0 });
    expect(pushFromSchedule("0")).toEqual({ push: "manual", seconds: 0 });
    expect(pushFromSchedule("@hourly")).toEqual({ push: { every: "1h" }, seconds: 3600 });
    expect(pushFromSchedule("@daily")).toEqual({ push: { every: "24h" }, seconds: 86400 });
    expect(pushFromSchedule("90")).toEqual({ push: { every: "90s" }, seconds: 90 });
    expect(pushFromSchedule("30m")).toEqual({ push: { every: "30m" }, seconds: 1800 });
    expect(() => pushFromSchedule("hourly")).toThrow(/METISTRY_PUSH_SCHEDULE must be/);
  });

  it("wins over the file's push — and only push — and says so", () => {
    const r = resolveVaultSync({ push: "after_commit", pull: { every: "10m" } }, { METISTRY_PUSH_SCHEDULE: "@hourly" });
    expect(r.push).toEqual({ every: "1h" });
    expect(r.push_every_sec).toBe(3600);
    expect(r.pull).toEqual({ every: "10m" });
    expect(r.push_override).toBe("@hourly");
    expect(describeVaultSync(r)).toBe("push every 1h (METISTRY_PUSH_SCHEDULE=@hourly), pull every 10m");
    expect(resolveVaultSync({ push: "after_commit" }, {}).push_override).toBeUndefined();
  });
});

describe("the CLI's spellings", () => {
  it("--push takes after_commit, manual, or an interval with or without `every`", () => {
    expect(parsePushArg("after_commit")).toBe("after_commit");
    expect(parsePushArg("manual")).toBe("manual");
    expect(parsePushArg("15m")).toEqual({ every: "15m" });
    expect(parsePushArg("every:15m")).toEqual({ every: "15m" });
    expect(parsePushArg("every 2h")).toEqual({ every: "2h" });
    expect(() => parsePushArg("never")).toThrow(/--push must be/);
    expect(() => parsePushArg("30s")).toThrow(/--push must be/);
  });

  it("--pull takes an interval, and there is no never", () => {
    expect(parsePullArg("5m")).toEqual({ every: "5m" });
    expect(parsePullArg("every:1h")).toEqual({ every: "1h" });
    expect(() => parsePullArg("never")).toThrow(/there is no "never"/);
  });
});

describe("the status body", () => {
  const body = {
    branch: "main",
    remote: "origin",
    ahead: 2,
    behind: 0,
    last_commit: { sha: "4c1d", subject: "Tick 1 task", author: "user", at: "2026-09-28T12:58:01.000Z" },
    last_push: { at: "2026-09-28T12:30:00.000Z", ok: true, remote: "origin" },
    last_pull: null,
    conflict: null,
    policy: { push: "after_commit", pull: { every: "5m" } },
    as_of: "2026-09-28T13:05:00.000Z",
  };

  it("parses what the reconciler sends", () => {
    expect(vaultStatusSchema.parse(body)).toEqual(body);
    expect(vaultStatusSchema.parse({ ...body, remote: null, ahead: null, behind: null, conflict: { paths: ["now.md"] } }).conflict).toEqual({ paths: ["now.md"] });
  });

  it("is strict: a field it does not name cannot ride through", () => {
    expect(vaultStatusSchema.safeParse({ ...body, diff: "the note's content" }).success).toBe(false);
    expect(vaultStatusSchema.safeParse({ ...body, last_commit: { ...body.last_commit, body: "x" } }).success).toBe(false);
  });
});
