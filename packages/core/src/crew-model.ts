// A crew's `model:` — the three forms a crew definition may name (a pinned
// `<provider>/<model-id>`, `same_as_assistant`, or for one release a legacy
// alias) and the one function that says why a string is none of them.
//
// Its own module because two schemas read it from opposite sides:
// `manifest.ts` (the crew definition) and `compute.ts` (resolving a crew's
// compute), and `manifest.ts` already imports `compute.ts` for
// `providerSchema`. Either importing the other for these would be a cycle —
// the same reason `data-policy.ts` and `model-ref.ts` are leaves. Nothing
// here may import `manifest.ts` or `compute.ts`.

import { modelRefIssue } from "./model-ref.js";

/**
 * The LEGACY crew model aliases — what `model:` admitted before a crew named
 * its own model (C128, ruling 4: an agent's model and effort live in its
 * definition). Read for ONE release: an alias resolves through `compute.yaml`'s
 * `assignments.crews.<name>`, and with none there, to the assistant's default
 * tier — exactly what an unassigned crew ran on before (docs/ops/actors.md,
 * *Crew compute*). After that release doctor warns (plan §2.4, *Where tiers go*).
 */
export const CREW_MODELS = ["haiku", "sonnet", "opus"] as const;
export type CrewModelAlias = (typeof CREW_MODELS)[number];

/**
 * `model: same_as_assistant` — the assistant's DEFAULT TIER
 * (`assignments.default`, its model AND its effort), never the router
 * (§4 Q14). A crew's own `effort:` is not used under it (actors.md, open
 * question 5).
 */
export const SAME_AS_ASSISTANT = "same_as_assistant";

/** True for a pre-C128 alias (`haiku | sonnet | opus`), which is not a model: it names a row of `assignments.crews`. */
export function isLegacyCrewModel(model: string): model is CrewModelAlias {
  return (CREW_MODELS as readonly string[]).includes(model);
}

/**
 * Why a crew's `model:` is not one this Metistry reads, or undefined when it
 * is. Three forms (docs/ops/actors.md): a pinned `<provider>/<model-id>`
 * (`modelRefIssue`, the same rule `compute.yaml` is held to), the literal
 * `same_as_assistant`, or — for one release — a legacy alias. Returned as a
 * sentence so the schema, `metistry agents define` and doctor refuse in the
 * same words.
 */
export function crewModelIssue(model: unknown): string | undefined {
  if (typeof model !== "string") return `must be <provider>/<model-id> or ${SAME_AS_ASSISTANT}`;
  if (model === SAME_AS_ASSISTANT || isLegacyCrewModel(model)) return undefined;
  const why = modelRefIssue(model);
  return why === undefined ? undefined : `${why} — or ${SAME_AS_ASSISTANT}, the assistant's default tier`;
}
