// The actor model (plan §2.4, F-2). The model is TYPES, so most of what it
// promises is a compile error — test/types/actor.types.ts holds those, and
// the last block here is what makes them checked: vitest strips types
// without reading them, and the package's tsconfig covers src/ only.
//
// The runtime half is the one mapping table that is data: a registry row's
// kind → the actor it is and the role the door decides on.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ACTOR_KINDS, ACTOR_OF_AGENT_KIND, PERMISSION_RESOURCES, ROLES } from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..", "..");

describe("the mapping table covers internal, crew and external", () => {
  it("maps each stored kind to one actor kind, and every actor kind is reached", () => {
    expect(Object.keys(ACTOR_OF_AGENT_KIND).sort()).toEqual(["crew", "external", "internal"]);
    expect(ACTOR_OF_AGENT_KIND.internal.kind).toBe("assistant");
    expect(ACTOR_OF_AGENT_KIND.crew.kind).toBe("crew");
    expect(ACTOR_OF_AGENT_KIND.external.kind).toBe("external");
    expect(Object.values(ACTOR_OF_AGENT_KIND).map((v) => v.kind).sort()).toEqual([...ACTOR_KINDS].sort());
  });

  it("names the role the door already derives — internal is the assistant, a crew is a crew, anything else an agent", () => {
    // principalOfRow (apps/console/src/agents.ts) and the console's principalOf make this mapping today.
    expect(ACTOR_OF_AGENT_KIND.internal.role).toBe("assistant");
    expect(ACTOR_OF_AGENT_KIND.crew.role).toBe("crew");
    expect(ACTOR_OF_AGENT_KIND.external.role).toBe("agent");
    for (const { role } of Object.values(ACTOR_OF_AGENT_KIND)) expect(ROLES).toContain(role);
  });

  it("is exactly the list the database admits (the last agents_kind_check in db/migrations)", () => {
    // A fourth kind is a migration first. When one lands, this fails until the
    // table says what actor it is — rather than the resolver meeting it at runtime.
    const dir = join(repo, "db", "migrations");
    let admitted: string[] | undefined;
    for (const f of readdirSync(dir).filter((n) => n.endsWith(".sql")).sort()) {
      const sql = readFileSync(join(dir, f), "utf8");
      const m = /agents_kind_check[\s\S]*?CHECK\s*\(\s*kind\s+IN\s*\(([^)]*)\)/i.exec(sql);
      if (m) admitted = [...m[1]!.matchAll(/'([^']+)'/g)].map((x) => x[1]!);
    }
    expect(admitted, "no agents_kind_check CHECK found in db/migrations").toBeDefined();
    expect([...admitted!].sort()).toEqual(Object.keys(ACTOR_OF_AGENT_KIND).sort());
  });

  it("cannot be edited at runtime", () => {
    expect(Object.isFrozen(ACTOR_OF_AGENT_KIND)).toBe(true);
    expect(() => {
      (ACTOR_OF_AGENT_KIND as Record<string, unknown>).tool = { kind: "assistant", role: "assistant" };
    }).toThrow();
  });
});

describe("the permissions table's resources", () => {
  it("is a closed list, with connections as the one open end", () => {
    expect([...PERMISSION_RESOURCES]).toEqual(["knowledge", "work", "artifacts", "inbox", "queries", "agents"]);
    expect(PERMISSION_RESOURCES).not.toContain("connection");
  });
});

describe("type-level tests (test/types/actor.types.ts)", () => {
  const tsc = join(dirname(createRequire(import.meta.url).resolve("typescript/package.json")), "bin", "tsc");
  // Nothing from the environment: the compiler needs none of it (docs/ops/testing.md).
  const run = (project: string) => {
    try {
      return { status: 0, out: execFileSync(process.execPath, [tsc, "-p", project], { encoding: "utf8", env: {} }) };
    } catch (err) {
      const e = err as { status?: number; stdout?: string; stderr?: string };
      return { status: e.status ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
    }
  };

  it("compile: every assertion holds and every refusal is refused", () => {
    const r = run(join(here, "types", "tsconfig.json"));
    expect(r.out).toBe("");
    expect(r.status).toBe(0);
  });

  it("the harness fails on a broken assertion — so a pass above is not vacuous", () => {
    const tmp = mkdtempSync(join(tmpdir(), "metistry-actor-types-"));
    try {
      const actor = join(here, "..", "src", "actor.js");
      writeFileSync(
        join(tmp, "canary.ts"),
        `import type { ExternalActor } from ${JSON.stringify(actor)};\n` +
          `declare const x: ExternalActor;\n` +
          `export const wrong: null = x.definition;\n` +
          `// @ts-expect-error — this line compiles, so the directive is unused\n` +
          `export const fine: null = x.compute;\n` +
          `export const broken: string = x.compute;\n`,
      );
      // The same compiler settings as the real fixture: an ES module, core's own @types.
      writeFileSync(join(tmp, "package.json"), JSON.stringify({ type: "module" }));
      writeFileSync(
        join(tmp, "tsconfig.json"),
        JSON.stringify({
          extends: join(repo, "tsconfig.base.json"),
          compilerOptions: { noEmit: true, declaration: false, sourceMap: false, typeRoots: [join(here, "..", "node_modules", "@types")] },
          files: ["canary.ts"],
        }),
      );
      const r = run(join(tmp, "tsconfig.json"));
      expect(r.status).not.toBe(0);
      // Exactly the two planted faults, and nothing incidental.
      const errors = r.out.split("\n").filter((l) => l.includes("error TS"));
      expect(errors).toHaveLength(2);
      expect(errors[0]).toMatch(/canary\.ts\(4,1\): error TS2578/); // unused @ts-expect-error
      expect(errors[1]).toMatch(/canary\.ts\(6,14\): error TS2322/); // not assignable
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
