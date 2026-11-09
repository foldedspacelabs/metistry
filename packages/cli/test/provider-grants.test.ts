// A provider key's grantee (ruling 2 of the W2 checkpoint, 2026-09-27; X-7):
// the engine attaches a `{{ secret.x }}` provider key only when secrets.yaml
// grants `x` to `provider:<name>`. So no install may lose compute on the
// update that brings the refusal: `metistry update` and `secrets
// migrate-scope` backfill the grant for every key compute.yaml already uses,
// and `compute providers add|set` write it for the provider they just wrote.
//
// Each backfill runs TWICE on the same fixture: the second run must find
// nothing to do and write nothing. Scratch instances only; "linux" so a
// protected write lands directly, with no reconciler to find.
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { memoryKeychain, parseSecretsFile } from "@foldedspacelabs/metistry-core";
import { providersSet } from "../src/compute.js";
import { grantProviderSecrets, migrateScope, secretsGrant, type NamedSecretsOptions } from "../src/secrets.js";
import { updateProviderGrants } from "../src/update.js";
import { StepRunner } from "../src/steps.js";

const ID = "11111111-2222-4333-8444-555555555555";

const COMPUTE = `providers:
  openrouter:
    kind: openai-compatible
    base_url: https://openrouter.ai/api/v1
    locality: off_machine
    auth: { secret: "{{ secret.openrouter_api_key }}" }
    data_policy: { allow: [Knowledge], deny_sources: [], max_brief_bytes: 4096 }
  second:
    kind: openai-compatible
    base_url: https://llm.example:8443/v1
    locality: off_machine
    auth: { secret: "{{ secret.openrouter_api_key }}" }
    data_policy: { allow: [Knowledge], deny_sources: [], max_brief_bytes: 4096 }
  revoked:
    kind: openai-compatible
    base_url: https://revoked.example/v1
    locality: off_machine
    auth: { secret: "{{ secret.revoked_key }}" }
    data_policy: { allow: [Knowledge], deny_sources: [], max_brief_bytes: 4096 }
  ghost:
    kind: openai-compatible
    base_url: https://ghost.example/v1
    locality: off_machine
    auth: { secret: "{{ secret.never_set }}" }
    data_policy: { allow: [Knowledge], deny_sources: [], max_brief_bytes: 4096 }
  applefm:
    kind: openai-compatible
    base_url: http://127.0.0.1:7810/v1
    locality: on_machine
    auth: { secret: METISTRY_BRIDGE_TOKEN_APPLE_FM }
  lmstudio:
    kind: openai-compatible
    base_url: http://127.0.0.1:1234/v1
    locality: on_machine
`;

// what an install from before X-7 has: T4-18's `providers add` wrote the host and no grant
const SECRETS = `# secrets.yaml — the owner's comment, which must survive
secrets:
  openrouter_api_key:
    hosts: [openrouter.ai]
    grants:
      agent:devin: ask
  revoked_key:
    hosts: [revoked.example]
    grants:
      provider:revoked: off
`;

async function fixture(label: string, compute = COMPUTE, secrets: string | undefined = SECRETS): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `metistry-x7-${label}-`));
  await mkdir(join(dir, ".metistry", "state"), { recursive: true });
  await writeFile(join(dir, ".metistry", "identity.yaml"), `name: Aide\ninstance_id: "${ID}"\n`);
  await writeFile(join(dir, ".metistry", "compute.yaml"), compute);
  if (secrets !== undefined) await writeFile(join(dir, ".metistry", "secrets.yaml"), secrets);
  return dir;
}

function opts(dir: string, extra: Partial<NamedSecretsOptions> = {}): NamedSecretsOptions & { lines: string[] } {
  const lines: string[] = [];
  return { instanceDir: dir, instanceId: ID, env: {}, platform: "linux", uid: 501, out: (l) => lines.push(l), lines, ...extra };
}

const secretsText = (dir: string) => readFile(join(dir, ".metistry", "secrets.yaml"), "utf8");
const policyOf = async (dir: string) => parseSecretsFile(await secretsText(dir)).secrets;
const mtime = async (dir: string) => (await stat(join(dir, ".metistry", "secrets.yaml"))).mtimeMs;

describe("grantProviderSecrets — the backfill", () => {
  it("grants each provider key to its provider, adds the provider's host, keeps the owner's word, and a second run writes nothing", async () => {
    const dir = await fixture("backfill");
    const first = await grantProviderSecrets(opts(dir));
    expect(first.granted.map((g) => `${g.secret}→${g.provider}`)).toEqual(["openrouter_api_key→openrouter", "openrouter_api_key→second"]);
    expect(first.kept.map((g) => g.provider)).toEqual(["revoked"]); // Off is the owner's word, not a gap
    expect(first.unlisted.map((g) => g.secret)).toEqual(["never_set"]);

    const p = await policyOf(dir);
    expect(p.openrouter_api_key).toEqual({
      // the second provider's host joins the list — `llm.example:8443`, the exact destination
      hosts: ["openrouter.ai", "llm.example:8443"],
      grants: { "agent:devin": "ask", "provider:openrouter": "on", "provider:second": "on" },
    });
    expect(p.revoked_key!.grants).toEqual({ "provider:revoked": "off" });
    expect(p.never_set).toBeUndefined(); // no line is invented for a secret the owner never stored
    // an env: credential and a keyless provider are not secrets.yaml's business
    expect(JSON.stringify(p)).not.toContain("applefm");
    expect(JSON.stringify(p)).not.toContain("lmstudio");
    expect(await secretsText(dir)).toContain("# secrets.yaml — the owner's comment, which must survive");

    const before = await secretsText(dir);
    const at = await mtime(dir);
    const second = await grantProviderSecrets(opts(dir));
    expect(second.granted).toEqual([]);
    expect(second.delivery).toBeUndefined();
    expect(await secretsText(dir)).toBe(before);
    expect(await mtime(dir)).toBe(at);
  });

  it("a dry run says what it would grant and writes nothing", async () => {
    const dir = await fixture("dry");
    const o = opts(dir, { dryRun: true });
    const r = await grantProviderSecrets(o);
    expect(r.granted).toHaveLength(2);
    expect(o.lines.join("\n")).toContain("[dry-run] would grant openrouter_api_key to provider:openrouter");
    expect(await secretsText(dir)).toBe(SECRETS);
  });

  it("`only` narrows it to the providers named; no compute.yaml, or an invalid one, grants nothing and fails nothing", async () => {
    const dir = await fixture("only");
    const r = await grantProviderSecrets({ ...opts(dir), only: ["second"] });
    expect(r.granted.map((g) => g.provider)).toEqual(["second"]);
    expect((await policyOf(dir)).openrouter_api_key!.grants["provider:openrouter"]).toBeUndefined();

    const none = await fixture("nocompute");
    await writeFile(join(none, ".metistry", "compute.yaml"), "providers: { broken: [");
    const o = opts(none);
    expect((await grantProviderSecrets(o)).granted).toEqual([]);
    expect(o.lines.join("\n")).toContain("does not validate");
    expect(await secretsText(none)).toBe(SECRETS);
  });
});

describe("`metistry update` backfills, idempotently", () => {
  it("run twice on the same instance: the first grants, the second finds nothing and writes nothing", async () => {
    const dir = await fixture("update");
    const lines: string[] = [];
    const r = () => new StepRunner({ dryRun: false, out: (l) => lines.push(l), env: {} });
    const o = { instanceDir: dir, env: {}, platform: "linux" as const, uid: 501, fetchFn: fetch };
    const first = await updateProviderGrants(r(), o);
    expect(first?.granted).toHaveLength(2);
    const after = await secretsText(dir);
    const at = await mtime(dir);
    const second = await updateProviderGrants(r(), o);
    expect(second?.granted).toEqual([]);
    expect(await secretsText(dir)).toBe(after);
    expect(await mtime(dir)).toBe(at);
    expect((await policyOf(dir)).openrouter_api_key!.grants).toMatchObject({ "provider:openrouter": "on", "provider:second": "on" });
  });

  it("never fails the update: no instance directory is a no-op, and a secrets.yaml it cannot read is a note", async () => {
    const lines: string[] = [];
    const r = new StepRunner({ dryRun: false, out: (l) => lines.push(l), env: {} });
    expect(await updateProviderGrants(r, { instanceDir: undefined, env: {}, platform: "linux", uid: 501, fetchFn: fetch })).toBeUndefined();
    const dir = await fixture("unreadable", COMPUTE, "secrets: [not, a, map]\n");
    expect(await updateProviderGrants(r, { instanceDir: dir, env: {}, platform: "linux", uid: 501, fetchFn: fetch })).toBeUndefined();
    expect(lines.join("\n")).toContain("provider grants: not written");
  });
});

describe("`secrets migrate-scope` grants the references it rewrites", () => {
  it("a provider migrated from METISTRY_LOCAL_API_KEY to {{ secret.local_api_key }} gets provider:local, and a rerun adds nothing", async () => {
    const compute = `providers:
  local:
    kind: openai-compatible
    base_url: http://127.0.0.1:1234/v1
    locality: on_machine
    auth: { secret: METISTRY_LOCAL_API_KEY }
`;
    const dir = await fixture("scope", compute, undefined);
    await writeFile(join(dir, ".metistry", "state", ".env"), "METISTRY_DB_PASSWORD=x\n", { mode: 0o600 });
    const kc = memoryKeychain([{ service: "metistry:METISTRY_LOCAL_API_KEY", account: "metistry", value: "local-SHARED-original" }]);
    const o = { ...opts(dir), envFile: join(dir, ".metistry", "state", ".env"), keychain: kc };
    const first = await migrateScope(o);
    expect(first.rewritten.map((w) => w.to)).toEqual(["local_api_key"]);
    expect(first.granted.map((g) => `${g.secret}→${g.provider}`)).toEqual(["local_api_key→local"]);
    expect((await policyOf(dir)).local_api_key).toEqual({ hosts: ["127.0.0.1:1234"], grants: { "provider:local": "on" } });

    const after = await secretsText(dir);
    const second = await migrateScope(o);
    expect(second.granted).toEqual([]);
    expect(await secretsText(dir)).toBe(after);
  });
});

describe("`compute providers set --secret` and `secrets grant`", () => {
  it("pointing a provider at a secret grants it to that provider", async () => {
    const dir = await fixture("set", `providers:
  lmstudio:
    kind: openai-compatible
    base_url: http://127.0.0.1:1234/v1
    locality: on_machine
`, "secrets:\n  lm_key:\n    hosts: []\n    grants: {}\n");
    const lines: string[] = [];
    await providersSet({ instanceDir: dir, seedDir: join(dir, "seed"), env: {}, platform: "linux", uid: 501, out: (l) => lines.push(l), name: "lmstudio", secret: "lm_key" });
    expect((await policyOf(dir)).lm_key).toEqual({ hosts: ["127.0.0.1:1234"], grants: { "provider:lmstudio": "on" } });
  });

  it("`metistry secrets grant <name> provider:<name> on|ask|off` takes the provider grantee, and refuses a malformed one", async () => {
    const dir = await fixture("grant");
    const r = await secretsGrant("openrouter_api_key", "provider:openrouter", "off", opts(dir));
    expect(r.grantee).toBe("provider:openrouter");
    expect((await policyOf(dir)).openrouter_api_key!.grants["provider:openrouter"]).toBe("off");
    await expect(secretsGrant("openrouter_api_key", "provider:Open Router", "on", opts(dir))).rejects.toThrow(/provider:<name>/);
  });
});
