// A data policy: what a brief bound for a target — or a prompt bound for an
// off-machine provider — may carry (§4.18.B). Its own module because two
// schemas use it from opposite sides: `manifest.ts` (targets, and the
// `provider` manifest kind, which embeds a compute provider block) and
// `compute.ts` (the provider block itself). Either importing the other for
// it would be a cycle.

import { z } from "zod";
import { isVaultPath } from "./instance-layout.js";

// A vault-relative path prefix the brief may reference (plan §4.15: scopes
// are prefix matches, so `Areas/Fsl` covers every sub-area). The vault root
// is the instance directory, so a prefix has no `Knowledge/` to anchor on;
// what anchors it instead is the casing rule — the FIRST segment is
// TitleCase, exactly as Obsidian renders it, which is also why `.metistry/`
// can never be named here. `isVaultPath` carries the rest: no traversal, no
// dot-directory, not `Artifacts/`.
export const knowledgePrefix = z
  .string()
  .regex(
    /^[A-Z][A-Za-z0-9 _.'-]*(\/[A-Za-z0-9_.'-][A-Za-z0-9 _.'-]*)*$/,
    "allow entries are vault path prefixes with a TitleCase first segment (no leading slash, no '..', no trailing slash)",
  )
  .refine((p) => isVaultPath(p), "allow entries must name vault content — not .metistry/, not Artifacts/, no traversal");

// What a brief bound for this target may carry (§4.18.B). Every field is
// required so the policy is a declaration, not a default nobody chose. The
// dispatch tool enforces it — a manifest is the contract, the tool is the
// control.
export const dataPolicySchema = z.object({
  /** Vault path prefixes a brief may reference; empty = no vault references at all. */
  allow: z.array(knowledgePrefix),
  /** Provenance classes that may never leave the machine via this target, e.g. `comms` (§4.12). */
  deny_sources: z.array(z.string().regex(/^[a-z][a-z0-9_-]*$/, "source names are lowercase kebab-case")),
  max_brief_bytes: z.number().int().positive(),
});

export type DataPolicy = z.infer<typeof dataPolicySchema>;
