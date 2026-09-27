// Deterministic redaction (§4.3 default 3) — of inputs AND model-generated
// output. PoC-13 proved the wide version is mandatory: a local model copied
// a live OTP verbatim into a "body-free" structured field despite explicit
// prompt instructions. Prompt rules are not a control; this pass is.

export const REDACTED = "***REDACTED***";

/** Key names whose values never enter agent context, transcripts, or logs. */
const SECRET_KEY = /(token|secret|password|passphrase|credential|api[_-]?key|authorization|bearer|cookie)/i;

/** Whether a field NAMED `key` has its value redacted here — so a variable (variables.ts) may not take such a name: whatever it held would read as ***REDACTED*** anyway, and the name says it is a secret. */
export function isSecretKeyName(key: string): boolean {
  return SECRET_KEY.test(key);
}

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

/** Either placeholder: the key-name one, or a named secret's (`***REDACTED secret.github_write***`). */
const PLACEHOLDER_RE = /\*\*\*REDACTED(?: secret\.[a-z][a-z0-9_]{0,63})?\*\*\*/;

/**
 * Reject the placeholder coming BACK as a value, so a redacted read can
 * never be written as if it were real data.
 */
export function containsRedactedPlaceholder(value: unknown): boolean {
  if (typeof value === "string") return PLACEHOLDER_RE.test(value);
  if (Array.isArray(value)) return value.some(containsRedactedPlaceholder);
  if (value !== null && typeof value === "object") {
    return Object.values(value).some(containsRedactedPlaceholder);
  }
  return false;
}

// ---- the values themselves: redaction on the way back (§2.14, T4-2) ------------------

/**
 * What a filled secret's value becomes wherever it comes back: a response, a
 * log line, a `runs` row, an error. It carries the NAME — a transcript says
 * which secret was there (§2.14's misuse test) — and it is deliberately not
 * `{{ secret.name }}`: text a model wrote from a redacted response must never
 * be a reference the egress fill would expand again.
 */
export function redactedSecret(name: string): string {
  return `***REDACTED secret.${name}***`;
}

const REDACTOR_NAME_RE = /^[a-z][a-z0-9_]{0,63}$/;

/**
 * The spellings a value can come back in. A server that echoes it inside
 * JSON escapes it; one that echoes a query string encodes it; one that
 * reflects a header may base64 it. Each is a form of the same value, so each
 * is redacted to the same name.
 */
const BASE64_MIN_VALUE = 8;  // limit: fixed — below this an encoded form is too short to be distinctive

function formsOf(value: string): string[] {
  const forms = new Set<string>([value]);
  const json = JSON.stringify(value).slice(1, -1);
  forms.add(json);
  forms.add(encodeURIComponent(value));
  forms.add(encodeURIComponent(value).replaceAll("%20", "+"));
  // base64 of a very short value is a few common letters; redacting those
  // would shred ordinary text for no protection. The raw form still counts.
  if (value.length >= BASE64_MIN_VALUE) {
    const b64 = Buffer.from(value, "utf8").toString("base64");
    forms.add(b64);
    forms.add(b64.replace(/=+$/, ""));
    forms.add(Buffer.from(value, "utf8").toString("base64url"));
  }
  return [...forms].filter((f) => f !== "");
}

/**
 * **Redaction of secret VALUES**, for everything that comes back from an
 * egress call. `redactSecrets` above redacts by key NAME (`api_key: …`); a
 * server that echoes a token in an error message, a `message` field or a
 * `Location` header has no key to be caught by. This one knows the values.
 *
 * It learns a value the moment the egress fill puts it on the wire
 * (`egress.ts`), or up front with `prime()`; it never forgets one, so a value
 * rotated out is still redacted if an old response resurfaces. It holds
 * values — so it lives in the process that fills them, is never serialised,
 * and has no method that returns one.
 *
 * Every form is replaced longest first, so a value that contains another
 * value is redacted whole rather than half-named.
 */
export class SecretRedactor {
  /** form → name. Private: nothing outside can read a value back out. */
  readonly #forms = new Map<string, string>();
  #ordered: string[] | undefined;
  #pattern: RegExp | undefined;

  /** Learn `name`'s value. An empty value is ignored — there is nothing to redact. Throws on a name that is not a secret name. */
  learn(name: string, value: string): void {
    if (!REDACTOR_NAME_RE.test(name)) throw new Error(`${JSON.stringify(name)} is not a secret name`);
    if (value === "") return;
    for (const form of formsOf(value)) this.#forms.set(form, name);
    this.#ordered = undefined;
    this.#pattern = undefined;
  }

  /**
   * Learn every secret a policy names from the instance's store — for a
   * process that reads text a model will see (a vault note, a transcript)
   * before it has filled anything. Returns the names learned, never values.
   */
  async prime(names: Iterable<string>, source: { value(name: string): Promise<string | undefined> }): Promise<string[]> {
    const learned: string[] = [];
    for (const name of names) {
      const v = await source.value(name);
      if (v) {
        this.learn(name, v);
        learned.push(name);
      }
    }
    return learned;
  }

  /** How many distinct names it knows. */
  get size(): number {
    return new Set(this.#forms.values()).size;
  }

  #order(): string[] {
    this.#ordered ??= [...this.#forms.keys()].sort((a, b) => b.length - a.length || (a < b ? -1 : a > b ? 1 : 0));
    return this.#ordered;
  }

  /** The names whose value appears in `text`, in any known form. */
  find(text: string): string[] {
    const found = new Set<string>();
    for (const form of this.#order()) if (text.includes(form)) found.add(this.#forms.get(form)!);
    return [...found].sort();
  }

  /** The length of the longest form it knows — how much a stream must hold back so a value split across chunks is still caught. */
  get longestForm(): number {
    return this.#order()[0]?.length ?? 0;
  }

  #regex(): RegExp {
    this.#pattern ??= new RegExp(this.#order().map((f) => f.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "g");
    return this.#pattern;
  }

  /**
   * Redact the part of `text` that can be settled now: everything before
   * `safe`, plus any match that STARTS before it (a form starting there ends
   * within `text` when `safe` ≤ text.length − (longestForm − 1)). Returns the
   * redacted output and how many characters of `text` it consumed; the rest
   * waits for the next chunk.
   */
  redactPrefix(text: string, safe: number): { text: string; consumed: number } {
    if (this.#forms.size === 0) return { text: text.slice(0, safe), consumed: safe };
    const re = new RegExp(this.#regex().source, "g");
    let out = "";
    let last = 0;
    for (let m = re.exec(text); m && m.index < safe; m = re.exec(text)) {
      out += text.slice(last, m.index) + redactedSecret(this.#forms.get(m[0])!);
      last = m.index + m[0].length;
    }
    const end = Math.max(last, safe);
    return { text: out + text.slice(last, end), consumed: end };
  }

  /**
   * `text` with every known value replaced by `redactedSecret(name)`. One
   * left-to-right pass over an alternation ordered longest first, so a
   * marker already written is never itself rewritten by a short value that
   * happens to spell part of it.
   */
  redactText(text: string): string {
    if (this.#forms.size === 0 || text === "") return text;
    return text.replace(this.#regex(), (form) => redactedSecret(this.#forms.get(form)!));
  }

  /** A structure with every string — keys included — redacted. Returns a new structure; non-plain leaves pass through. */
  redact<T>(value: T): T {
    return this.#walk(value) as T;
  }

  #walk(value: unknown): unknown {
    if (typeof value === "string") return this.redactText(value);
    if (Array.isArray(value)) return value.map((v) => this.#walk(v));
    if (value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) out[this.redactText(k)] = this.#walk(v);
      return out;
    }
    return value;
  }

  /**
   * An error safe to rethrow, log or record: a new `Error` whose message is
   * redacted, with no `cause` — a fetch failure's cause can carry the request
   * it failed on, headers and all.
   */
  redactError(err: unknown): Error {
    const message = err instanceof Error ? err.message : String(err);
    const out = new Error(this.redactText(message));
    if (err instanceof Error && err.name !== "Error") out.name = err.name;
    return out;
  }
}
