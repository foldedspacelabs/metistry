// `GET /vault/read` as a `TemplateReader` — the one adapter every routine
// that renders a template reads the vault through (invariant 3). Lives here,
// not inside `plan-tomorrow/run.ts`, because it has two callers: `plan-tomorrow`
// builds one from its own `ctx.vault` for `{{ include }}`, and the console's
// runner (`apps/console/src/main.ts`) builds the SAME adapter once from the
// vault bridge client and hands it to every routine as `ctx.reader` —
// `knowledge-fold` has no `vault` field on its ctx at all, only `reader`, so
// without this shared helper the runner would have had to reimplement the
// wrapping-a-refusal-as-absent rule below a second time.
//
// A refusal from the bridge is read as absent, not thrown: §6.4 says an
// `include` (or a template read) that cannot be satisfied renders a note and
// the file still renders — the same rule `templateSkip` applies to the
// template's own bytes.

import type { TemplateReader } from "@foldedspacelabs/metistry-core";

/** Anything with `GET /vault/read`'s shape. `PlanVault` (`plan-tomorrow/run.ts`) and the console's `VaultClient` (`@foldedspacelabs/metistry-artifacts`) both satisfy it structurally. */
export interface VaultReadable {
  read(path: string): Promise<{ content: Buffer } | null>;
}

export function vaultReader(vault: VaultReadable): TemplateReader {
  return {
    async read(path: string): Promise<string | null> {
      try {
        const file = await vault.read(path);
        return file === null ? null : file.content.toString("utf8");
      } catch {
        return null;
      }
    },
  };
}
