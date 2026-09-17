// Applying an `improvement` proposal (§4.10 self-modification, invariant 2).
//
// The reply-review routine only ever *suggests* — it writes a proposal whose
// payload carries a section of prose. Nothing edits the assistant's prompt
// until the user allows that proposal in triage, and then the write goes
// through the vault bridge as principal `user`: a commit in the user's name,
// in the instance repo, reviewable and revertable like any other. The
// assistant itself cannot reach this path at all — mcp-brain's knowledge_write
// is confined to the vault, and `.metistry/assistant-prompt.md` is a §4.7
// protected path, writable only by the `user` principal
// (apps/reconciler/src/paths.ts).
//
// One subtlety worth stating out loud: the prompt overlay REPLACES the seed
// prompt (D4: last existing file wins, apps/assistant/src/prompt.ts), it does
// not merge with it. So when no overlay exists yet, creating one from the
// suggested section alone would silently delete the whole system prompt.
// Instead the first apply seeds the overlay with the shipped seed prompt and
// appends the section to it — which also pins the seed at that moment, and is
// exactly what the user sees in the resulting diff.

import { readFile } from "node:fs/promises";
import { INSTANCE_LAYOUT } from "@foldedspacelabs/metistry-core";
import { VaultError, type VaultClient } from "@foldedspacelabs/metistry-artifacts";

/** The instance-repo overlay the assistant reads (METISTRY_PROMPT_FILES), instance-relative. */
export const OVERLAY_PATH = INSTANCE_LAYOUT.assistantPrompt;
/** The product seed, shipped in the console image at /app/seed. */
export const SEED_PROMPT_PATH = "seed/assistant-prompt.md";

const MAX_SECTION = 20_000;  // limit: fixed — a proposal suggesting more prose than this is not an edit to review

/** The section of prose an `improvement` proposal suggests appending, or null when the payload carries none. */
export function suggestedSection(payload: unknown): string | null {
  const edit = (payload as { suggested_edit?: { path?: unknown; content?: unknown } } | null)?.suggested_edit;
  if (!edit || typeof edit.content !== "string") return null;
  const content = edit.content.trim();
  if (!content || content.length > MAX_SECTION) return null;
  // the routine only ever proposes the prompt overlay; anything else is not this handler's
  if (edit.path !== undefined && edit.path !== OVERLAY_PATH) return null;
  return content;
}

/**
 * Append an allowed improvement to the prompt overlay, as the user. Throws
 * VaultError (mapped to the uniform envelope by the caller) when the vault
 * refuses, when the payload has no section, or when neither the overlay nor
 * the seed prompt can be read.
 */
export async function applyImprovement(
  vault: VaultClient,
  payload: unknown,
  proposalId: number | string,
  seedPath = SEED_PROMPT_PATH,
): Promise<{ path: string; sha256: string; created: boolean }> {
  const section = suggestedSection(payload);
  if (!section) throw new VaultError("invalid_request", "proposal carries no suggested prompt edit");

  const current = await vault.read(OVERLAY_PATH);
  let base = current?.content.toString("utf8");
  if (base === undefined) {
    try {
      base = await readFile(seedPath, "utf8");
    } catch {
      throw new VaultError("not_available", `no ${OVERLAY_PATH} overlay and no seed prompt to base one on`);
    }
  }
  const next = `${base.trimEnd()}\n\n${section}\n`;
  const r = await vault.write(
    OVERLAY_PATH,
    Buffer.from(next, "utf8"),
    { principal: "user", message: `assistant prompt: apply improvement proposal #${proposalId}` },
    current?.sha256 ?? "",
  );
  await vault.flush?.().catch?.(() => {});
  return { path: r.path, sha256: r.sha256, created: r.created };
}
