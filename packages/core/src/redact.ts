// Deterministic redaction (§4.3 default 3) — of inputs AND model-generated
// output. PoC-13 proved the wide version is mandatory: a local model copied
// a live OTP verbatim into a "body-free" structured field despite explicit
// prompt instructions. Prompt rules are not a control; this pass is.

export const REDACTED = "***REDACTED***";

/** Key names whose values never enter agent context, transcripts, or logs. */
const SECRET_KEY = /(token|secret|password|passphrase|credential|api[_-]?key|authorization|bearer|cookie)/i;

/** Redact secret-named fields recursively. Returns a new structure. */
export function redactSecrets<T>(value: T): T {
  return walk(value, false) as T;
}

function walk(value: unknown, parentSecret: boolean): unknown {
  if (Array.isArray(value)) return value.map((v) => walk(v, parentSecret));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      const secret = SECRET_KEY.test(k);
      out[k] = secret && typeof v !== "object" ? REDACTED : walk(v, secret || parentSecret);
    }
    return out;
  }
  if (parentSecret && typeof value === "string") return REDACTED;
  return value;
}

/**
 * Scrub model-GENERATED text before it is treated as low-sensitivity
 * (the PoC-13 boundary): digit runs that look like OTP/PIN/card/phone.
 * Deliberately blunt — a reducer field has no legitimate need for them.
 */
export function scrubModelOutput(text: string): string {
  return (
    text
      // card-like groups (4x4 with separators) first, then bare runs of 4+
      .replace(/\b(?:\d[ -]?){13,19}\b/g, REDACTED)
      .replace(/\b\d{4,}\b/g, REDACTED)
  );
}

/**
 * Reject the placeholder coming BACK as a value, so a redacted read can
 * never be written as if it were real data.
 */
export function containsRedactedPlaceholder(value: unknown): boolean {
  if (typeof value === "string") return value.includes(REDACTED);
  if (Array.isArray(value)) return value.some(containsRedactedPlaceholder);
  if (value !== null && typeof value === "object") {
    return Object.values(value).some(containsRedactedPlaceholder);
  }
  return false;
}
