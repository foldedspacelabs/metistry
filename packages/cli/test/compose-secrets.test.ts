// The compose shape's secrets.yaml mount (X-7; the owner's ruling of
// 2026-09-30, option 1): docker-compose.yml bind-mounts the instance's
// `.metistry/secrets.yaml` — policy, never a value — READ-ONLY into the
// console and assistant, and nothing else of the instance (D5). Tested as
// text: the file is parsed and read, docker is never run.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { COMPOSE_SECRETS_SOURCE_VAR, COMPOSE_SECRETS_TARGET, SECRETS_FILE_VAR } from "@foldedspacelabs/metistry-core";
import { composeSecretsEnv } from "../src/up.js";

const compose = parse(readFileSync(new URL("../../../docker-compose.yml", import.meta.url), "utf8")) as {
  services: Record<string, { environment?: Record<string, string>; volumes?: Array<string | Record<string, unknown>> }>;
};

describe("docker-compose.yml mounts secrets.yaml read-only into console and assistant", () => {
  it.each(["console", "assistant"])("%s: one read-only bind of the file, never a created path, and the variable that names it", (service) => {
    const svc = compose.services[service]!;
    const binds = (svc.volumes ?? []).filter((v): v is Record<string, unknown> => typeof v === "object" && v.target === COMPOSE_SECRETS_TARGET);
    expect(binds).toEqual([
      {
        type: "bind",
        source: `\${${COMPOSE_SECRETS_SOURCE_VAR}:-/dev/null}`,
        target: COMPOSE_SECRETS_TARGET,
        read_only: true,
        bind: { create_host_path: false },
      },
    ]);
    // set only when something real is mounted; empty otherwise, which the door refuses naming the mount
    expect(svc.environment?.[SECRETS_FILE_VAR]).toBe(`\${${COMPOSE_SECRETS_SOURCE_VAR}:+${COMPOSE_SECRETS_TARGET}}`);
  });

  it("no other instance path is mounted into either container (D5): every other volume is a named volume", () => {
    for (const service of ["console", "assistant"]) {
      for (const v of compose.services[service]!.volumes ?? []) {
        if (typeof v === "string") expect(v, `${service}: ${v}`).toMatch(/^[a-z-]+:\//);
        else expect(v.target, `${service}`).toBe(COMPOSE_SECRETS_TARGET);
      }
    }
    // and the db, the one other service, never sees it
    expect(JSON.stringify(compose.services.db)).not.toContain("secrets");
  });
});

describe("composeSecretsEnv: what `metistry up` tells compose", () => {
  it("the instance's .metistry/secrets.yaml when it exists; nothing when it does not, or with no instance — and says which", () => {
    const yes = composeSecretsEnv("/i", (p) => p === "/i/.metistry/secrets.yaml" || p === "/i/.metistry");
    expect(yes.env).toEqual({ [COMPOSE_SECRETS_SOURCE_VAR]: "/i/.metistry/secrets.yaml" });
    expect(yes.note).toContain("mounted read-only");

    const missing = composeSecretsEnv("/i", (p) => p === "/i/.metistry");
    expect(missing.env).toEqual({});
    expect(missing.note).toContain("does not exist yet");

    expect(composeSecretsEnv(undefined).env).toEqual({});
  });
});
