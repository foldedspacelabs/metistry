// `metistry instances` — the peer registry (S4, docs/ops/instances.md).
// Misuse first: the failures that matter are the ones that would quietly
// corrupt the owner's idea of which machines this instance will talk to —
// an origin that is not an origin, a peer that will not say who it is, a
// row silently repointed at whoever answers an address today.
import { readFile, mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseInstances } from "@foldedspacelabs/metistry-core";
import {
  fetchIdentity,
  instancesAdd,
  instancesFile,
  instancesList,
  instancesRefresh,
  instancesRemove,
  normalizeOrigin,
  parseInstanceVerb,
  renderInstances,
} from "../src/instances.js";
import { main } from "../src/main.js";

const SELF = "11111111-2222-4333-8444-555555555555";
const PEER = "a1b2c3d4-2222-4333-8444-666666666666";
const OTHER = "99999999-2222-4333-8444-777777777777";

/** A console answering GET /api/identity, and nothing else — the one unauthenticated read. */
function fakeIdentity(byOrigin: Record<string, { status?: number; body?: unknown } | "unreachable">) {
  const calls: string[] = [];
  const fetchFn = (async (u: string | URL | Request) => {
    const url = new URL(String(u));
    calls.push(url.toString());
    const entry = byOrigin[url.origin];
    if (entry === undefined || entry === "unreachable") throw Object.assign(new Error("fetch failed"), { cause: { message: "ECONNREFUSED" } });
    if (url.pathname !== "/api/identity") return new Response("{}", { status: 404 });
    return new Response(JSON.stringify(entry.body ?? {}), { status: entry.status ?? 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

const identityBody = (instance_id: string, name: string, capabilities?: string[]) => ({
  instance_id,
  name,
  icon: "🦉",
  ...(capabilities ? { capabilities } : {}),
  version: "0.8.0",
  as_of: new Date().toISOString(),
});

async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "metistry-instances-"));
  await mkdir(join(dir, ".metistry", "state"), { recursive: true });
  return dir;
}

/** No reconciler configured and a non-darwin platform: writeProtected writes the file directly, which is what these tests read back. */
function base(instanceDir: string, fetchFn: typeof fetch) {
  const lines: string[] = [];
  return {
    opts: {
      instanceDir,
      env: {} as NodeJS.ProcessEnv,
      platform: "linux" as const,
      uid: 501,
      fetchFn,
      out: (l: string) => lines.push(l),
    },
    lines,
  };
}

describe("origins (pure, misuse)", () => {
  it("refuses anything that is not a bare http(s) origin", () => {
    for (const bad of ["metis.example.com", "ftp://metis.example.com", "https://metis.example.com/api", "https://metis.example.com/x/y", "", "   "]) {
      expect(() => normalizeOrigin(bad), bad).toThrow();
    }
  });

  it("normalizes the spellings a person actually types", () => {
    expect(normalizeOrigin("https://metis.example.com/")).toBe("https://metis.example.com");
    expect(normalizeOrigin("  https://metis.example.com  ")).toBe("https://metis.example.com");
    expect(normalizeOrigin("http://127.0.0.1:8080")).toBe("http://127.0.0.1:8080");
  });

  it("verbs are strict — a typo is not a guess", () => {
    expect(parseInstanceVerb("list")).toBe("list");
    for (const bad of ["ls", "LIST", "", undefined, "delete"]) expect(parseInstanceVerb(bad as string | undefined)).toBeUndefined();
  });
});

describe("fetchIdentity (misuse)", () => {
  it("refuses an origin that will not say who it is — nothing is written from a guess", async () => {
    const cases: Record<string, { status?: number; body?: unknown }> = {
      "https://a.example": { status: 503, body: { error: { code: "not_available" } } },
      "https://b.example": { status: 200, body: { name: "No Id" } },
      "https://c.example": { status: 200, body: { instance_id: PEER } },
      "https://d.example": { status: 404, body: {} },
    };
    for (const origin of Object.keys(cases)) {
      const { fetchFn } = fakeIdentity({ [origin]: cases[origin]! });
      await expect(fetchIdentity(origin, { fetchFn })).rejects.toThrow();
    }
    const { fetchFn } = fakeIdentity({});
    await expect(fetchIdentity("https://gone.example", { fetchFn })).rejects.toThrow(/did not answer/);
  });

  it("records only capabilities from the shared vocabulary — a peer's invention is dropped, not stored", async () => {
    const { fetchFn } = fakeIdentity({ "https://a.example": { body: identityBody(PEER, "Second", ["tasks", "knowledge_read", "everything", "capture"]) } });
    // `knowledge_read` is a TOOL name and `everything` is not a group: both are dropped, and what is left comes back in the canonical order
    expect(await fetchIdentity("https://a.example", { fetchFn })).toEqual({ instance_id: PEER, name: "Second", capabilities: ["capture", "tasks"] });
  });
});

describe("instances add / list / remove", () => {
  it("asks the origin who it is and writes a valid file the console can serve back", async () => {
    const dir = await scratch();
    const { fetchFn, calls } = fakeIdentity({ "https://second.example": { body: identityBody(PEER, "Second", ["capture", "tasks"]) } });
    const { opts } = base(dir, fetchFn);
    const r = await instancesAdd({ ...opts, origin: "https://second.example/", selfInstanceId: SELF });

    expect(calls).toEqual(["https://second.example/api/identity"]);
    expect(r.action).toBe("added");
    expect(r.entry).toMatchObject({ instance_id: PEER, name: "Second", origin: "https://second.example", capabilities: ["capture", "tasks"], resources: [] });
    const text = await readFile(instancesFile(dir), "utf8");
    expect(parseInstances(text).ok, text).toBe(true);
    expect(text).toContain("# instances.yaml"); // the header explaining the file survives
    expect(text).toContain("OPEN-7");
    expect((await instancesList(opts)).instances).toHaveLength(1);
  });

  it("is keyed by instance_id, not origin: the same instance at a new address UPDATES its row", async () => {
    const dir = await scratch();
    const one = fakeIdentity({ "https://old.example": { body: identityBody(PEER, "Second") } });
    await instancesAdd({ ...base(dir, one.fetchFn).opts, origin: "https://old.example" });
    const two = fakeIdentity({ "https://new.example": { body: identityBody(PEER, "Second Renamed", ["capture"]) } });
    const r = await instancesAdd({ ...base(dir, two.fetchFn).opts, origin: "https://new.example" });

    expect(r.action).toBe("updated");
    expect(r.instances).toHaveLength(1);
    expect(r.instances[0]).toMatchObject({ instance_id: PEER, origin: "https://new.example", name: "Second Renamed" });
  });

  it("refuses to add THIS instance — a registry of peers that contains itself makes every consumer filter it", async () => {
    const dir = await scratch();
    const { fetchFn } = fakeIdentity({ "https://me.example": { body: identityBody(SELF, "Me") } });
    await expect(instancesAdd({ ...base(dir, fetchFn).opts, origin: "https://me.example", selfInstanceId: SELF })).rejects.toThrow(/THIS instance/);
    expect((await instancesList(base(dir, fetchFn).opts)).exists).toBe(false); // nothing written at all
  });

  it("remove takes an id or an unambiguous name, and says so when it is neither", async () => {
    const dir = await scratch();
    const { fetchFn } = fakeIdentity({
      "https://a.example": { body: identityBody(PEER, "Twin") },
      "https://b.example": { body: identityBody(OTHER, "Twin") },
    });
    const { opts } = base(dir, fetchFn);
    await instancesAdd({ ...opts, origin: "https://a.example" });
    await instancesAdd({ ...opts, origin: "https://b.example" });

    await expect(instancesRemove({ ...opts, target: "Twin" })).rejects.toThrow(/names 2 instances/);
    await expect(instancesRemove({ ...opts, target: "nobody" })).rejects.toThrow(/no instance/);
    const r = await instancesRemove({ ...opts, target: OTHER });
    expect(r.action).toBe("removed");
    expect(r.instances.map((i) => i.instance_id)).toEqual([PEER]);
    // and by name once it is unique again
    expect((await instancesRemove({ ...opts, target: "Twin" })).instances).toEqual([]);
    expect(parseInstances(await readFile(instancesFile(dir), "utf8")).value.instances).toEqual([]);
  });

  it("--dry-run changes nothing on disk", async () => {
    const dir = await scratch();
    const { fetchFn } = fakeIdentity({ "https://second.example": { body: identityBody(PEER, "Second") } });
    const { opts } = base(dir, fetchFn);
    await instancesAdd({ ...opts, dryRun: true, origin: "https://second.example" });
    expect((await instancesList(opts)).exists).toBe(false);
  });

  it("refuses to edit a file it cannot read back, rather than clobbering it", async () => {
    const dir = await scratch();
    await writeFile(instancesFile(dir), "instances:\n  - instance_id: nope\n    name: Bad\n    origin: https://x.example\n");
    const { fetchFn } = fakeIdentity({ "https://second.example": { body: identityBody(PEER, "Second") } });
    await expect(instancesAdd({ ...base(dir, fetchFn).opts, origin: "https://second.example" })).rejects.toThrow(/does not validate/);
  });
});

describe("instances refresh", () => {
  it("re-asks every origin and keeps an unreachable peer exactly as it was — a closed laptop is not a departed instance", async () => {
    const dir = await scratch();
    const add = fakeIdentity({
      "https://up.example": { body: identityBody(PEER, "Up", ["capture"]) },
      "https://down.example": { body: identityBody(OTHER, "Down", ["capture", "tasks"]) },
    });
    const { opts } = base(dir, add.fetchFn);
    await instancesAdd({ ...opts, origin: "https://up.example" });
    await instancesAdd({ ...opts, origin: "https://down.example" });

    const later = fakeIdentity({ "https://up.example": { body: identityBody(PEER, "Up Renamed", ["capture", "tasks", "queries"]) } });
    const r = await instancesRefresh({ ...base(dir, later.fetchFn).opts });

    expect(r.action).toBe("refreshed");
    expect(r.unreachable?.map((u) => u.origin)).toEqual(["https://down.example"]);
    const byId = Object.fromEntries(r.instances.map((i) => [i.instance_id, i]));
    expect(byId[PEER]).toMatchObject({ name: "Up Renamed", capabilities: ["capture", "queries", "tasks"] });
    expect(byId[OTHER]).toMatchObject({ name: "Down", capabilities: ["capture", "tasks"] }); // untouched, including last_seen
    expect(renderInstances(r)).toContain("did not answer:");
  });

  it("an origin that now answers as a DIFFERENT instance is reported, never silently repointed", async () => {
    const dir = await scratch();
    const add = fakeIdentity({ "https://moved.example": { body: identityBody(PEER, "Second") } });
    const { opts } = base(dir, add.fetchFn);
    await instancesAdd({ ...opts, origin: "https://moved.example" });

    const stranger = fakeIdentity({ "https://moved.example": { body: identityBody(OTHER, "Somebody Else") } });
    const r = await instancesRefresh({ ...base(dir, stranger.fetchFn).opts });

    expect(r.instances).toHaveLength(1);
    expect(r.instances[0]).toMatchObject({ instance_id: PEER, name: "Second" }); // NOT repointed
    expect(r.unreachable?.[0]?.reason).toMatch(/different instance/);
  });

  it("nothing to refresh is not a write", async () => {
    const dir = await scratch();
    const { fetchFn } = fakeIdentity({});
    const r = await instancesRefresh(base(dir, fetchFn).opts);
    expect(r.action).toBe("unchanged");
    expect(r.delivery).toBeUndefined();
  });
});

describe("rendering", () => {
  it("an empty registry says how to fill it, not nothing", async () => {
    const dir = await scratch();
    const { fetchFn } = fakeIdentity({});
    const text = renderInstances(await instancesList(base(dir, fetchFn).opts));
    expect(text).toContain("instances add <origin>");
    expect(text).toContain("does not exist yet");
  });
});

describe("metistry instances via main(): --json purity", () => {
  it("remove --json: exactly one JSON document on stdout, the protected write's step lines on stderr", async () => {
    const dir = await scratch();
    const seed = fakeIdentity({ "https://peer.example": { body: identityBody(PEER, "Peer") } });
    await instancesAdd({ ...base(dir, seed.fetchFn).opts, origin: "https://peer.example" });

    const out: string[] = [];
    const err: string[] = [];
    const code = await main(["instances", "remove", PEER, "--json", "--instance", dir], { out: (l) => out.push(l), err: (l) => err.push(l), platform: "linux", uid: 501 });
    expect(code).toBe(0);
    const parsed = JSON.parse(out.join("\n")); // throws if a step line leaked onto stdout ahead of the document
    expect(parsed).toMatchObject({ action: "removed", instances: [] });
    expect(err.join("\n")).toContain("removed instance Peer");
  });
});
