// The console's half of the actor model (T4-6): loading what core's pure
// `resolveActor` reads. No database — the two reads it makes are faked, and
// the assistant's files are written to temporary directories.
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveActor } from "@foldedspacelabs/metistry-core";
import { consoleActorSources, definitionBody, loadAssistantDefinition, permissionLines } from "../src/actors.js";
import type { AgentRow } from "../src/agents.js";

const sha = (t: string) => createHash("sha256").update(t).digest("hex");

describe("the assistant's definition: the files that exist, in composition order, each relative and hashed", () => {
  let product: string;
  let instance: string;
  const IDENTITY = "name: Aide\nmention: \"@aide\"\nicon: sparkles\ninstance_id: 8b6a3a2e-1111-4222-8333-444455556666\n";
  const PROMPT = "You are {{name}}.\n";
  const CLAUDE = "# How I want this run\n";

  beforeAll(async () => {
    product = await mkdtemp(join(tmpdir(), "metistry-actors-product-"));
    instance = await mkdtemp(join(tmpdir(), "metistry-actors-instance-"));
    await mkdir(join(product, "seed"), { recursive: true });
    await writeFile(join(product, "seed", "identity.yaml"), "name: Seed\n");
    await writeFile(join(product, "seed", "assistant-prompt.md"), PROMPT);
    await mkdir(join(instance, ".metistry"), { recursive: true });
    await writeFile(join(instance, ".metistry", "identity.yaml"), IDENTITY);
  });
  afterAll(async () => {
    await rm(product, { recursive: true, force: true });
    await rm(instance, { recursive: true, force: true });
  });

  const paths = () => ({
    identityFiles: `seed/identity.yaml:${join(instance, ".metistry", "identity.yaml")}`,
    promptFiles: `seed/assistant-prompt.md:${join(instance, ".metistry", "assistant-prompt.md")}`,
    instanceDir: instance,
    productDir: product,
  });

  it("identity.yaml (the instance's, which wins), then assistant-prompt.md (the release's, the instance has none) — and no CLAUDE.md until the owner writes one", async () => {
    const d = await loadAssistantDefinition(paths());
    expect(d.identity).toEqual({ name: "Aide", mention: "@aide", mark: "sparkles" });
    expect(d.files).toEqual([
      { path: ".metistry/identity.yaml", origin: "instance", sha256: sha(IDENTITY) },
      { path: "seed/assistant-prompt.md", origin: "product", sha256: sha(PROMPT) },
    ]);
  });

  it("the root CLAUDE.md, once written, sits between them", async () => {
    await writeFile(join(instance, "CLAUDE.md"), CLAUDE);
    const d = await loadAssistantDefinition(paths());
    expect(d.files.map((f) => [f.path, f.origin])).toEqual([
      [".metistry/identity.yaml", "instance"],
      ["CLAUDE.md", "instance"],
      ["seed/assistant-prompt.md", "product"],
    ]);
    expect(d.files[1]!.sha256).toBe(sha(CLAUDE));
    // no path is absolute (invariant 7)
    for (const f of d.files) expect(f.path.startsWith("/")).toBe(false);
  });
});

describe("consoleActorSources — where an approved area came from", () => {
  const row = (over: Partial<AgentRow>): AgentRow =>
    ({ id: "x", display_name: "X", kind: "external", grants: { tier: "none", areas: [] }, projects: [], autonomy: {}, created_at: "", last_seen_at: null, revoked: false, remote: false, approved_at: null, pending: false, grant_source: "registry", ...over }) as AgentRow;
  const db = {
    query: async (sql: string) => {
      if (sql.includes("agent_grant_overrides")) return { rows: [{ agent_id: "assistant", area: "Me/Health", proposal_id: 7 }, { agent_id: "cursor", area: "Areas/Leak", proposal_id: 9 }] };
      if (sql.includes("FROM projects")) return { rows: [{ id: "drey", grants: { tier: "areas", areas: ["Areas/Shared"] } }] };
      return { rows: [{ id: 42, source_agent: "cursor", area: "Areas/Ops" }, { id: 43, source_agent: "assistant", area: "Areas/Wrong" }] };
    },
  };

  it("the assistant's row takes 0023's approvals, an external row its approved asks — and each only marks an area the row still holds", async () => {
    const rows = [
      row({ id: "assistant", kind: "internal", grants: { tier: "areas", areas: ["Areas/Fsl", "Me/Health"] }, grant_source: "environment" }),
      row({ id: "cursor", grants: { tier: "areas", areas: ["Areas/Ops", "Areas/Leak"] } }),
    ];
    const sources = await consoleActorSources(db, { rows, assistant: { identity: { name: "Aide", mention: null, mark: null }, files: [] } });
    expect(sources.grantHistory("assistant").approved).toEqual([{ area: "Me/Health", proposalId: 7 }]);
    expect(sources.grantHistory("cursor").approved).toEqual([{ area: "Areas/Ops", proposalId: 42 }]);
    const cursor = permissionLines("cursor", sources)[0]!.read.map((e) => [e.key, e.provenance.kind]);
    expect(cursor).toEqual([["Areas/Ops", "approved"], ["Areas/Leak", "base"]]);
    const asst = permissionLines("assistant", sources)[0]!.read.map((e) => [e.key, e.provenance]);
    expect(asst).toEqual([["Areas/Fsl", { kind: "base", source: "environment" }], ["Me/Health", { kind: "approved", proposalId: 7 }]]);
  });

  it("T4-7: every project's own grant is loaded, and a member's table marks what it inherits 'via project' — the assistant's never", async () => {
    const rows = [
      row({ id: "assistant", kind: "internal", grants: { tier: "areas", areas: ["Areas/Fsl"] }, projects: ["drey"], grant_source: "environment" }),
      row({ id: "cursor", grants: { tier: "areas", areas: ["Areas/Ops"] }, projects: ["drey"] }),
    ];
    const sources = await consoleActorSources(db, { rows, assistant: { identity: { name: "Aide", mention: null, mark: null }, files: [] } });
    expect(sources.projectGrants).toEqual([{ project: "drey", grants: { tier: "areas", areas: ["Areas/Shared"] } }]);
    expect(permissionLines("cursor", sources)[0]!.read.map((e) => [e.key, e.provenance.kind])).toEqual([["Areas/Ops", "approved"], ["Areas/Shared", "project"]]);
    expect(permissionLines("assistant", sources)[0]!.read.map((e) => e.key)).toEqual(["Areas/Fsl"]);
  });

  it("with no identity.yaml the assistant is named by its row, never by a name spelled in code; the definition body carries compute and limits", async () => {
    const sources = await consoleActorSources({ query: async () => ({ rows: [] }) }, { rows: [row({ id: "assistant", kind: "internal", display_name: "assistant (internal)" })], assistant: { identity: undefined, files: [] } });
    const actor = resolveActor("assistant", sources)!;
    expect(actor.displayName).toBe("assistant (internal)");
    const body = definitionBody(actor, new Date("2026-09-26T00:00:00Z"));
    expect(body).toEqual({ id: "assistant", definition: { kind: "assistant", identity: { name: "assistant (internal)", mention: null, mark: null }, files: [] }, compute: { kind: "router" }, limits: null, as_of: "2026-09-26T00:00:00.000Z" });
  });
});
