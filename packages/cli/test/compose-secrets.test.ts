// The compose shape's secrets policy mount (X-7; the owner's rulings of
// 2026-09-30): docker-compose.yml bind-mounts the instance's policy MIRROR
// directory, `.metistry/state/policy/` — a copy of secrets.yaml, policy,
// never a value — READ-ONLY into the console and assistant, and nothing else
// of the instance (D5). A directory, so a revoke written by rename reaches a
// running container. Tested as text: the file is parsed, docker never runs.
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { COMPOSE_POLICY_TARGET_DIR, COMPOSE_SECRETS_SOURCE_VAR, COMPOSE_SECRETS_TARGET, SECRETS_FILE_VAR, secretsMirrorDir } from "@foldedspacelabs/metistry-core";
import { prepareComposePolicy } from "../src/up.js";
import { StepRunner } from "../src/steps.js";

const compose = parse(readFileSync(new URL("../../../docker-compose.yml", import.meta.url), "utf8")) as {
  services: Record<string, { environment?: Record<string, string>; volumes?: Array<string | Record<string, unknown>> }>;
};

describe("docker-compose.yml mounts the policy mirror directory read-only into console and assistant", () => {
  it.each(["console", "assistant"])("%s: one read-only DIRECTORY bind, never a created path, and the variable that names the file in it", (service) => {
    const svc = compose.services[service]!;
    const binds = (svc.volumes ?? []).filter((v): v is Record<string, unknown> => typeof v === "object" && v.target === COMPOSE_POLICY_TARGET_DIR);
    expect(binds).toEqual([
      {
        type: "bind",
        // unset → the product's own seed/ (exists in every install, holds no secret), with the variable below empty
        source: `\${${COMPOSE_SECRETS_SOURCE_VAR}:-./seed}`,
        target: COMPOSE_POLICY_TARGET_DIR,
        read_only: true,
        bind: { create_host_path: false },
      },
    ]);
    expect(svc.environment?.[SECRETS_FILE_VAR]).toBe(`\${${COMPOSE_SECRETS_SOURCE_VAR}:+${COMPOSE_SECRETS_TARGET}}`);
    expect(COMPOSE_SECRETS_TARGET).toBe(`${COMPOSE_POLICY_TARGET_DIR}/secrets.yaml`);
  });

  it("no other instance path is mounted into either container (D5): every other volume is a named volume, and .metistry/ itself never is", () => {
    for (const service of ["console", "assistant"]) {
      for (const v of compose.services[service]!.volumes ?? []) {
        if (typeof v === "string") expect(v, `${service}: ${v}`).toMatch(/^[a-z-]+:\//);
        else expect(v.target, service).toBe(COMPOSE_POLICY_TARGET_DIR);
      }
    }
    expect(JSON.stringify(compose.services.db)).not.toContain("policy");
  });
});

describe("prepareComposePolicy: what `metistry up` does before compose starts", () => {
  it("creates the mirror directory, mirrors secrets.yaml into it, and names the DIRECTORY for compose", async () => {
    const dir = await mkdtemp(join(tmpdir(), "metistry-x7-prep-"));
    await mkdir(join(dir, ".metistry", "state"), { recursive: true });
    await writeFile(join(dir, ".metistry", "identity.yaml"), "name: Aide\n");
    await writeFile(join(dir, ".metistry", "secrets.yaml"), "secrets: {}\n");
    const lines: string[] = [];
    const env = await prepareComposePolicy(new StepRunner({ dryRun: false, out: (l) => lines.push(l), env: {} }), dir);
    expect(env).toEqual({ [COMPOSE_SECRETS_SOURCE_VAR]: secretsMirrorDir(dir) });
    expect(readFileSync(join(secretsMirrorDir(dir), "secrets.yaml"), "utf8")).toBe("secrets: {}\n");
    expect(lines.join("\n")).toContain("mounted read-only");
  });

  it("with no secrets.yaml the directory still exists (the bind never creates a path) and holds nothing; a dry run touches nothing; no instance, no mount", async () => {
    const dir = await mkdtemp(join(tmpdir(), "metistry-x7-prep-none-"));
    await mkdir(join(dir, ".metistry", "state"), { recursive: true });
    await writeFile(join(dir, ".metistry", "identity.yaml"), "name: Aide\n");
    const quiet = () => new StepRunner({ dryRun: false, out: () => {}, env: {} });
    expect(await prepareComposePolicy(quiet(), dir)).toEqual({ [COMPOSE_SECRETS_SOURCE_VAR]: secretsMirrorDir(dir) });
    expect(existsSync(secretsMirrorDir(dir))).toBe(true);
    expect(existsSync(join(secretsMirrorDir(dir), "secrets.yaml"))).toBe(false);

    const dry = await mkdtemp(join(tmpdir(), "metistry-x7-prep-dry-"));
    await prepareComposePolicy(new StepRunner({ dryRun: true, out: () => {}, env: {} }), dry);
    expect(existsSync(secretsMirrorDir(dry))).toBe(false);

    expect(await prepareComposePolicy(quiet(), undefined)).toEqual({});
  });
});
