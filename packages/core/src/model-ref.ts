// `<provider>/<model-id>` — the one spelling for "which model, served by
// whom", and the one function that says why a string is not one.
//
// Its own module, not part of compute.ts, for a boring reason with a real
// consequence: `manifest.ts` needs this rule (a collector's `uses_model:`)
// and `compute.ts` needs `manifest.ts` (`data_policy`). Putting the rule
// here is what keeps that from being an import cycle — and it is the right
// shape anyway, since a model reference is a lexical rule about a string,
// not a fact about a configuration file.
//
// compute.ts re-exports everything below, so no caller has to know this
// file exists.

/** Provider names are lowercase kebab-case — the casing rule: only `Knowledge/` is TitleCase. */
export const PROVIDER_NAME_RE = /^[a-z][a-z0-9_-]*$/;

export interface ModelRef {
  /** the first segment: a provider named in `compute.yaml` */
  provider: string;
  /** everything after it, verbatim — LM Studio and OpenRouter ids contain slashes */
  model: string;
  /** the `<provider>/<id>` string as written */
  ref: string;
}

/**
 * Why a string is not a usable model reference, or undefined when it is.
 * Returned as a message rather than thrown so the schema, the CLI's
 * argument parsing and the app can all refuse in the same words.
 *
 * `/auto` and anything list-shaped are refused outright: invariant 4 says
 * the router is deterministic — no model decides which model runs — and an
 * auto-router or a fallback list hands that choice to the provider.
 */
export function modelRefIssue(ref: string): string | undefined {
  if (ref.trim() !== ref || ref === "") return "must not be empty or padded with spaces";
  if (/\s/.test(ref)) return `${JSON.stringify(ref)} contains whitespace — a model reference is one \`<provider>/<model-id>\` token`;
  const slash = ref.indexOf("/");
  if (slash <= 0 || slash === ref.length - 1) {
    return `${JSON.stringify(ref)} is not \`<provider>/<model-id>\` — pin the provider that serves it (e.g. openrouter/anthropic/claude-sonnet-5), so nothing has to guess where it runs`;
  }
  const provider = ref.slice(0, slash);
  const model = ref.slice(slash + 1);
  if (!PROVIDER_NAME_RE.test(provider)) return `provider ${JSON.stringify(provider)} is not a provider name (lowercase, digits, - and _, starting with a letter)`;
  if (model.split("/").includes("auto") || model.endsWith(":auto")) {
    return `${JSON.stringify(ref)} names an auto-router — pin one model instead (invariant 4: the router is deterministic; no model decides which model runs)`;
  }
  return undefined;
}

/** Split a validated reference. Throws with the same message the schema would give. */
export function parseModelRef(ref: string): ModelRef {
  const why = modelRefIssue(ref);
  if (why) throw new Error(`model: ${why}`);
  const slash = ref.indexOf("/");
  return { provider: ref.slice(0, slash), model: ref.slice(slash + 1), ref };
}
