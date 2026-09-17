// Reading deployment.yaml off disk (seed + the instance's overlay), and the
// environment each launchd job is handed.
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { emptyCompute, parseCompute } from "@foldedspacelabs/metistry-core";
import { ASSISTANT_ENV_KEYS, assistantEnv, assistantEnvKeys, consoleEnv, deploymentPaths, loadDeployment, type ShapeContext } from "../src/deployment.js";

async function dirs(): Promise<{ product: string; instance: string }> {
  const root = await mkdtemp(join(tmpdir(), "metistry-deploy-"));
  await mkdir(join(root, "product", "seed"), { recursive: true });
  await mkdir(join(root, "instance"), { recursive: true });
  return { product: join(root, "product"), instance: join(root, "instance") };
}

describe("loadDeployment", () => {
  it("no file anywhere = today's install", async () => {
    const { product } = await dirs();
    expect(await loadDeployment(product, {})).toEqual({ deployment: { shape: "compose", services: {} }, from: "no deployment.yaml — the built-in default" });
  });

  it("the seeded default is used when the instance has no copy", async () => {
    const { product, instance } = await dirs();
    await writeFile(join(product, "seed", "deployment.yaml"), "shape: compose\nservices: {}\n");
    const r = await loadDeployment(product, { METISTRY_INSTANCE_DIR: instance });
    expect(r.deployment.shape).toBe("compose");
    expect(r.from).toBe("seed/deployment.yaml");
  });

  it("the instance's copy wins, and its per-service keys merge over the seeded ones (D4)", async () => {
    const { product, instance } = await dirs();
    await writeFile(join(product, "seed", "deployment.yaml"), "shape: compose\nservices:\n  db:\n    shape: compose\n");
    await mkdir(join(instance, ".metistry"), { recursive: true });
    await writeFile(join(instance, ".metistry", "deployment.yaml"), "shape: launchd\nservices:\n  db:\n    enabled: false\n");
    const r = await loadDeployment(product, { METISTRY_INSTANCE_DIR: instance });
    expect(r.deployment).toEqual({ shape: "launchd", services: { db: { shape: "compose", enabled: false } } });
    expect(r.from).toBe(join(instance, ".metistry", "deployment.yaml"));
    expect(deploymentPaths(product, { METISTRY_INSTANCE_DIR: instance }).instance).toBe(join(instance, ".metistry", "deployment.yaml"));
  });

  it("METISTRY_DEPLOYMENT_SHAPE overrides the file and says so", async () => {
    const { product } = await dirs();
    await writeFile(join(product, "seed", "deployment.yaml"), "shape: compose\nservices: {}\n");
    const r = await loadDeployment(product, { METISTRY_DEPLOYMENT_SHAPE: "launchd" });
    expect(r.deployment.shape).toBe("launchd");
    expect(r.from).toMatch(/^METISTRY_DEPLOYMENT_SHAPE \(overriding seed\/deployment\.yaml\)$/);
    await expect(loadDeployment(product, { METISTRY_DEPLOYMENT_SHAPE: "podman" })).rejects.toThrow(/METISTRY_DEPLOYMENT_SHAPE/);
  });

  it("a malformed file is an error, not a silent compose", async () => {
    const { product } = await dirs();
    await writeFile(join(product, "seed", "deployment.yaml"), "shape: dokcer\n");
    await expect(loadDeployment(product, {})).rejects.toThrow(/seed\/deployment\.yaml/);
  });
});

const ctx = (env: NodeJS.ProcessEnv): ShapeContext => ({
  productDir: "/p",
  instanceDir: "/i",
  env,
  shape: "launchd",
  stateDir: "/i/state/assistant",
});

describe("the console's launchd environment", () => {
  const env = {
    METISTRY_DB_HOST: "db",
    METISTRY_DB_PASSWORD: "pw",
    METISTRY_ORIGIN: "https://studio.ts.net",
    METISTRY_CONSOLE_HOST: "0.0.0.0",
    METISTRY_EK_URL: "http://host.docker.internal:7811",
    METISTRY_INBOX_DIR: "/data/inbox",
    METISTRY_GITHUB_WRITE_TOKEN: "ghp_x",
    METISTRY_TZ: "America/New_York",
    HOME: "/Users/someone",
    PATH: "/usr/bin",
  };

  it("carries every METISTRY_* the compose service got, with the container-only values replaced", () => {
    const e = consoleEnv(ctx(env));
    expect(e.METISTRY_DB_HOST).toBe("127.0.0.1");
    expect(e.METISTRY_CONSOLE_HOST).toBe("127.0.0.1"); // loopback bind (invariant 8)
    expect(e.METISTRY_EK_URL).toBe("http://127.0.0.1:7811"); // resolved for a host process
    expect(e.METISTRY_INBOX_DIR).toBe("/i/Inbox"); // the vault inbox, not the named volume (docs/ops/inbox.md)
    expect(e.METISTRY_ORIGIN).toBe("https://studio.ts.net");
    expect(e.METISTRY_GITHUB_WRITE_TOKEN).toBe("ghp_x");
    expect(e.TZ).toBe("America/New_York");
    // nothing from the operator's shell that is not ours
    expect(e.PATH).toBeUndefined();
    expect(e.HOME).toBeUndefined();
  });

  it("an inbox the operator set to a real path is kept", () => {
    expect(consoleEnv(ctx({ ...env, METISTRY_INBOX_DIR: "/Users/someone/inbox" })).METISTRY_INBOX_DIR).toBe("/Users/someone/inbox");
    expect(consoleEnv(ctx({ ...env, METISTRY_INSTANCE_DIR: undefined })).METISTRY_INBOX_DIR).toBe("/i/Inbox"); // the container volume path is never kept
  });
});

describe("the assistant's launchd environment is an allowlist, not a passthrough", () => {
  const env = {
    METISTRY_DB_PASSWORD: "pw",
    METISTRY_DB_HOST: "db",
    METISTRY_ASSISTANT_TOKEN: "tok",
    METISTRY_BRAIN_URL: "http://console:8080/mcp",
    METISTRY_OPENROUTER_API_KEY: "sk-or-declared",
    METISTRY_SOMEWHERE_ELSE_API_KEY: "sk-not-declared",
    METISTRY_GITHUB_WRITE_TOKEN: "ghp_x",
    METISTRY_AWS_SECRET_ACCESS_KEY: "aws",
    METISTRY_VAPID_PRIVATE: "vapid",
  };
  // The engine's credential has no fixed NAME: compute.yaml says which one
  // each provider uses, so the allowlist is the static keys plus exactly the
  // secrets THIS file declares (C2/C3).
  const compute = parseCompute(`
providers:
  openrouter:
    kind: openai-compatible
    base_url: https://openrouter.ai/api/v1
    locality: off_machine
    auth: { secret: METISTRY_OPENROUTER_API_KEY }
    data_policy: { allow: [Knowledge/Projects], deny_sources: [comms], max_brief_bytes: 65536 }
assignments:
  default: { model: openrouter/anthropic/claude-sonnet-5 }
`);

  it("gets the db, its own token, the brain URL and the provider key compute.yaml names — and nothing else", () => {
    const e = assistantEnv(ctx(env), compute);
    expect(e.METISTRY_DB_HOST).toBe("127.0.0.1");
    expect(e.METISTRY_BRAIN_URL).toBe("http://127.0.0.1:8080/mcp");
    expect(e.METISTRY_ASSISTANT_TOKEN).toBe("tok");
    expect(e.METISTRY_OPENROUTER_API_KEY).toBe("sk-or-declared");
    expect(e.HOME).toBe("/i/state/assistant"); // the one writable path the sandbox allows
    // the console's outbound credentials never enter the engine's environment
    expect(e.METISTRY_GITHUB_WRITE_TOKEN).toBeUndefined();
    expect(e.METISTRY_AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(e.METISTRY_VAPID_PRIVATE).toBeUndefined();
    // a provider key in the operator's shell that this file does not name
    // cannot reach the engine and buy tokens on somebody else's account
    expect(e.METISTRY_SOMEWHERE_ELSE_API_KEY).toBeUndefined();
  });

  it("with no compute.yaml at all, no provider key is passed through — the static keys are the whole list", () => {
    const e = assistantEnv(ctx(env));
    expect(e.METISTRY_OPENROUTER_API_KEY).toBeUndefined();
    expect(assistantEnvKeys(emptyCompute())).toEqual([...ASSISTANT_ENV_KEYS]);
    expect(assistantEnvKeys(compute)).toContain("METISTRY_OPENROUTER_API_KEY");
  });

  it("defaults the brain URL to the console's own port when .env has none", () => {
    expect(assistantEnv(ctx({ METISTRY_CONSOLE_PORT: "8099" })).METISTRY_BRAIN_URL).toBe("http://127.0.0.1:8099/mcp");
  });
});
