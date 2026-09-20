// `vaultReader`: the shared `VaultReadable` → `TemplateReader` adapter that
// both `plan-tomorrow` (its own `ctx.vault`) and the console's runner (the
// `ctx.reader` every routine's `ComponentCtx` carries, `apps/console/src/runner.ts`)
// build from. The one property that matters — a refusal reads as absent, not
// thrown — is what lets `knowledge-fold` treat "the bridge is down" the same
// as "no such file" (§6.4).
import { describe, expect, it } from "vitest";
import { vaultReader, type VaultReadable } from "./vault-reader.js";

function fakeVault(files: Record<string, string>, opts: { throwOn?: string } = {}): VaultReadable {
  return {
    async read(path: string) {
      if (opts.throwOn === path) throw new Error("bridge unreachable");
      return Object.hasOwn(files, path) ? { content: Buffer.from(files[path]!, "utf8") } : null;
    },
  };
}

describe("vaultReader", () => {
  it("reads a file's content back as text", async () => {
    const reader = vaultReader(fakeVault({ "Templates/Fold.md": "---\nsource: fold\n---\nbody" }));
    expect(await reader.read("Templates/Fold.md")).toBe("---\nsource: fold\n---\nbody");
  });

  it("returns null for a path the vault does not hold", async () => {
    const reader = vaultReader(fakeVault({}));
    expect(await reader.read("Templates/Fold.md")).toBeNull();
  });

  it("reads a refusal as absent rather than throwing (§6.4: an unsatisfiable read renders a note, not a failure)", async () => {
    const reader = vaultReader(fakeVault({}, { throwOn: "Templates/Fold.md" }));
    await expect(reader.read("Templates/Fold.md")).resolves.toBeNull();
  });
});
