// How a secret is SPELLED where it is referenced — `{{ secret.name }}` — and
// the one environment variable Metistry's own services receive it in.
//
// A leaf module on purpose. `secrets.ts` (the store, the policy file, the
// fill) imports `connections.ts`, which imports `manifest.ts`, which imports
// `compute.ts` — so `compute.ts`, which has to read a provider's
// `auth.secret`, cannot import `secrets.ts` without a load-time cycle that
// leaves `providerSchema` undefined while `manifest.ts` builds its own
// schema from it. Both import this instead, and `secrets.ts` re-exports all
// of it, so there is still one spelling and one import for every caller.

/** A secret's name: owner-chosen, lowercase snake_case (§2.14), at most 64 characters — the shape connections.ts gives a `secret` field. Not compute.ts's `SECRET_NAME_RE`, which is the UPPER_SNAKE environment name an `env:` reference takes. */
export const INSTANCE_SECRET_NAME_RE = /^[a-z][a-z0-9_]{0,63}$/;

/** One well-formed reference. Global: use with `matchAll`/`replace`, never `test`. */
export const SECRET_REF_RE = /\{\{\s*secret\.([a-z][a-z0-9_]{0,63})\s*\}\}/g;

/** Exactly one reference and nothing else. */
export const SECRET_REF_EXACT_RE = new RegExp(`^${SECRET_REF_RE.source}$`);

/**
 * A field that holds ONE reference (`auth.secret`, a connection's `secret`
 * field): `{{ secret.name }}`, or — for one release — `env:NAME`, the
 * install-environment spelling it replaces (§2.14). Undefined when the value
 * is neither.
 */
export type SecretReference = { kind: "secret"; name: string } | { kind: "env"; name: string; deprecated: true };

export function parseSecretReference(value: string): SecretReference | undefined {
  const v = value.trim();
  const m = SECRET_REF_EXACT_RE.exec(v);
  if (m?.[1]) return { kind: "secret", name: m[1] };
  const e = /^env:([A-Z][A-Z0-9_]*)$/.exec(v);
  if (e?.[1]) return { kind: "env", name: e[1], deprecated: true };
  return undefined;
}

/**
 * The prefix of the variable a named secret reaches one of Metistry's OWN
 * services in — the engine, the console's collectors (T4-18). Disjoint from
 * every install variable: nothing Metistry sets or mints begins with it, so
 * `{{ secret.db_password }}` can never be answered by `METISTRY_DB_PASSWORD`.
 *
 * Not `secretEnvName` (secrets.ts), which is the bare `GITHUB_READ` a LOCAL
 * AGENT the owner granted a secret is handed: that one is spelled for a
 * third-party tool's conventions, and a bare name is exactly what a stray
 * export in the operator's shell would collide with.
 */
export const SECRET_DELIVERY_PREFIX = "METISTRY_SECRET_";

/** `openrouter_api_key` → `METISTRY_SECRET_OPENROUTER_API_KEY`. Throws on anything that is not a secret name. */
export function secretDeliveryVar(name: string): string {
  if (!INSTANCE_SECRET_NAME_RE.test(name)) throw new Error(`${JSON.stringify(name)} is not a secret name — lowercase snake_case: a letter, then letters, digits and _ (at most 64)`);
  return `${SECRET_DELIVERY_PREFIX}${name.toUpperCase()}`;
}
