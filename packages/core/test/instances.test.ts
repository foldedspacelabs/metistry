// S3 (instance-qualified agent identity) and S4 (the peer registry's
// schema) — misuse first: the ways a caller can get a cross-instance name
// wrong are the ways two instances' records silently merge.
import { describe, expect, it } from "vitest";
import {
  CAPABILITIES,
  emptyInstances,
  findInstance,
  normalizeCapabilities,
  parseAgentId,
  parseInstances,
  qualifyAgentId,
  qualifyIfPossible,
  validateInstances,
} from "../src/instances.js";

const ID = "8b6a3a2e-1c4d-4f7a-9b2e-0d1c2b3a4e5f";
const OTHER = "0a1b2c3d-4e5f-4a6b-8c9d-0e1f2a3b4c5d";

describe("qualifyAgentId (misuse)", () => {
  it("refuses an id that is already qualified — re-qualifying would make agent:a@x@y a name forever", () => {
    const q = qualifyAgentId("cursor", ID);
    expect(q).toBe(`agent:cursor@${ID}`);
    expect(() => qualifyAgentId(q, ID)).toThrow(/not an agent id/);
    expect(() => qualifyAgentId(`cursor@${ID}`, ID)).toThrow(/not an agent id/);
  });

  it("refuses anything that is not the registry's slug shape", () => {
    for (const bad of ["", "Cursor", "-cursor", "cursor_x", "cur sor", "a".repeat(41), "agent:cursor", "crew:researcher"]) {
      expect(() => qualifyAgentId(bad, ID), bad).toThrow();
    }
    expect(qualifyAgentId("a", ID)).toBe(`agent:a@${ID}`);
    expect(qualifyAgentId(`${"a".repeat(40)}`, ID)).toBe(`agent:${"a".repeat(40)}@${ID}`);
  });

  it("refuses an instance_id that is not the UUID `metistry init` mints — an origin is not an identity", () => {
    for (const bad of ["", "local", "https://metis.example", ID.toUpperCase(), ID.slice(0, -1), `${ID} `]) {
      expect(() => qualifyAgentId("cursor", bad), bad).toThrow(/not an instance_id/);
    }
  });

  it("round-trips through parseAgentId, and a bare name parses as nothing", () => {
    expect(parseAgentId(qualifyAgentId("cursor", ID))).toEqual({ name: "cursor", instance_id: ID });
    for (const notQualified of ["cursor", "agent:cursor", `cursor@${ID}`, `agent:cursor@${ID}@${OTHER}`, "agent:Cursor@" + ID]) {
      expect(parseAgentId(notQualified), notQualified).toBeUndefined();
    }
  });

  it("qualifyIfPossible never throws at a boundary: no instance_id means the bare name, documented as the mixed period", () => {
    expect(qualifyIfPossible("cursor", ID)).toBe(`agent:cursor@${ID}`);
    expect(qualifyIfPossible("cursor", undefined)).toBe("cursor");
    expect(qualifyIfPossible("cursor", "not-a-uuid")).toBe("cursor");
    expect(qualifyIfPossible(null, ID)).toBeNull();
    expect(qualifyIfPossible(undefined, ID)).toBeNull();
    // not a registry id at all (a crew owner prefix, the owner): passed through untouched, never invented
    expect(qualifyIfPossible("crew:researcher", ID)).toBe("crew:researcher");
    expect(qualifyIfPossible("user", ID)).toBe(`agent:user@${ID}`); // `user` IS a legal slug; callers filter principals, not this
  });
});

describe("capabilities vocabulary", () => {
  it("is coarse group names only — nothing that could be a tool name or a count", () => {
    expect([...CAPABILITIES]).toEqual(["artifacts", "capture", "dispatch", "knowledge", "queries", "tasks"]);
    for (const c of CAPABILITIES) expect(c).toMatch(/^[a-z]+$/);
  });

  it("normalizes to the canonical order and drops anything outside the vocabulary", () => {
    expect(normalizeCapabilities(["tasks", "knowledge", "tasks"])).toEqual(["knowledge", "tasks"]);
    expect(normalizeCapabilities(["knowledge_write", "queries_run", "", "KNOWLEDGE"])).toEqual([]);
    expect(normalizeCapabilities([...CAPABILITIES])).toEqual([...CAPABILITIES]);
  });
});

describe("instances.yaml", () => {
  it("parses a registry and keys it by instance_id", () => {
    const r = parseInstances(`
instances:
  - instance_id: "${ID}"
    name: Studio
    origin: https://metis.example.com
    capabilities: [knowledge, capture]
  - instance_id: "${OTHER}"
    name: Second
    origin: http://127.0.0.1:8080
`);
    expect(r.ok, r.errors.join("; ")).toBe(true);
    expect(r.value.instances.map((i) => i.name)).toEqual(["Studio", "Second"]);
    expect(r.value.instances[0]!.resources).toEqual([]); // the OPEN-7 placeholder, defaulted
    expect(findInstance(r.value, OTHER)?.origin).toBe("http://127.0.0.1:8080");
    expect(findInstance(r.value, "nope")).toBeUndefined();
  });

  it("an empty or absent file is an empty registry, never an error", () => {
    expect(parseInstances("")).toEqual({ ok: true, value: emptyInstances, errors: [] });
    expect(parseInstances("# nothing yet\n")).toEqual({ ok: true, value: emptyInstances, errors: [] });
    expect(parseInstances("instances: []").value).toEqual(emptyInstances);
  });

  it("refuses a non-empty `resources` — OPEN-7 is not designed here, so an entry would be a guess", () => {
    const r = parseInstances(`
instances:
  - instance_id: "${ID}"
    name: Studio
    origin: https://metis.example.com
    resources: [{ kind: mcp, name: brain }]
`);
    expect(r.ok).toBe(false);
    expect(r.errors.join("\n")).toMatch(/OPEN-7/);
  });

  it("refuses an origin with a path or a trailing slash, and a name that is not a UUID's", () => {
    for (const origin of ["https://metis.example.com/", "https://metis.example.com/api", "metis.example.com", "", "ftp://x"]) {
      const r = validateInstances({ instances: [{ instance_id: ID, name: "x", origin }] });
      expect(r.ok, origin).toBe(false);
      expect(r.errors.join("\n")).toMatch(/origin/);
    }
    expect(validateInstances({ instances: [{ instance_id: "studio", name: "x", origin: "https://a.b" }] }).ok).toBe(false);
    expect(validateInstances({ instances: [{ instance_id: ID, name: "", origin: "https://a.b" }] }).ok).toBe(false);
  });

  it("a broken file yields the EMPTY registry, never a half-applied one", () => {
    const r = parseInstances("instances: [ { instance_id: nope } ]");
    expect(r.ok).toBe(false);
    expect(r.value).toEqual(emptyInstances);
    expect(parseInstances("instances: [\n").ok).toBe(false);
  });
});
