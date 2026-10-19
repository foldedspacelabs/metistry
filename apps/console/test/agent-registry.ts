// A TargetRegistry over a scratch instance directory holding agent
// connections (T4-11) — the only way a console reaches GitHub Issues or Devin
// since X-85 removed the `targets/` and environment-key shim. The tests that
// used to `add()` a manifest with an `env:` key build their target here
// instead: a connection file, a `secrets.yaml` that grants and scopes its key,
// and the delivered `METISTRY_SECRET_*` value, filled at the connection's door.
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { envSecretSource, loadInstanceCatalog } from "@foldedspacelabs/metistry-connections";
import { TargetRegistry } from "../src/dispatch.js";

export const root = fileURLToPath(new URL("../../../", import.meta.url));

export interface AgentRegistryOptions {
  fetchFn: typeof fetch;
  /** the Devin connection (named `devin`): its organization — omit the key to leave `config.org` out — and whether the key is delivered */
  devin?: { org?: string | undefined; key?: string | undefined; allow?: string[] | undefined } | undefined;
  /** the GitHub Issues connection (named `github-issues`): its repository and whether the write token is delivered */
  github?: { repo?: string | undefined; key?: string | undefined } | undefined;
}

export interface AgentRegistry {
  registry: TargetRegistry;
  dir: string;
  cleanup(): Promise<void>;
}

const conn = (name: string, provider: string, url: string, secret: string, config: Record<string, string>): string =>
  [
    `name: ${name}`,
    "type: agent",
    `provider: ${provider}`,
    "reach:",
    "  http:",
    `    url: ${url}`,
    `    auth: { scheme: bearer, secret: ${secret} }`,
    `secrets: [${secret}]`,
    ...(Object.keys(config).length ? ["config:", ...Object.entries(config).map(([k, v]) => `  ${k}: "${v}"`)] : ["config: {}"]),
    "",
  ].join("\n");

/** A registry whose connections are the ones asked for, reading `fetchFn` for everything the doors send. */
export async function agentRegistry(o: AgentRegistryOptions): Promise<AgentRegistry> {
  const dir = await mkdtemp(join(tmpdir(), "metistry-agent-registry-"));
  await mkdir(join(dir, ".metistry/connections"), { recursive: true });
  const secrets: string[] = ["secrets:"];
  const delivered: Record<string, string> = {};
  if (o.devin) {
    const config: Record<string, string> = o.devin.org === undefined ? {} : { org: o.devin.org };
    await writeFile(join(dir, ".metistry/connections/devin.yaml"), conn("devin", "devin", "https://api.devin.ai", "devin_api_key", config));
    secrets.push("  devin_api_key:", "    hosts: [api.devin.ai, mcp.devin.ai]", '    grants: { "connection:devin": on }');
    if (o.devin.key !== undefined) delivered.METISTRY_SECRET_DEVIN_API_KEY = o.devin.key;
    if (o.devin.allow) {
      // the instance's overlay of the type (D4) is what widens the product's empty allow list
      const type = parseYaml(await readFile(join(root, "seed/connection-types/devin/manifest.yaml"), "utf8")) as { dispatch: { data_policy: { allow: string[] } } };
      type.dispatch.data_policy.allow = o.devin.allow;
      await mkdir(join(dir, ".metistry/extensions/devin"), { recursive: true });
      await writeFile(join(dir, ".metistry/extensions/devin/manifest.yaml"), stringifyYaml(type));
    }
  }
  if (o.github) {
    const config: Record<string, string> = o.github.repo === undefined ? {} : { repo: o.github.repo };
    await writeFile(join(dir, ".metistry/connections/github-issues.yaml"), conn("github-issues", "github-issues", "https://api.github.com", "github_write_token", config));
    secrets.push("  github_write_token:", "    hosts: [api.github.com]", '    grants: { "connection:github-issues": on }');
    if (o.github.key !== undefined) delivered.METISTRY_SECRET_GITHUB_WRITE_TOKEN = o.github.key;
  }
  await writeFile(join(dir, ".metistry/secrets.yaml"), `${secrets.join("\n")}\n`);
  const registry = new TargetRegistry({ fetchFn: o.fetchFn });
  registry.bindConnections({ catalog: () => loadInstanceCatalog({ instanceDir: dir, seedDir: `${root}seed` }), secrets: envSecretSource(delivered) });
  return { registry, dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

/** The Authorization header a door filled onto a request. */
export const authorizationOf = (init: RequestInit | undefined): string | null => new Headers(init?.headers).get("authorization");
