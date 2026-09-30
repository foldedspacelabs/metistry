// The IMAP4rev1 wire (RFC 3501 §4, §7, §9) — the subset the `imap` provider
// reads, hand-rolled (no dependency, like `dav-xml.ts`): a response reader
// that frames lines and their literals, and a tokenizer for what a response
// line holds — atoms, quoted strings, literals, NIL and parenthesised lists.
//
// What it refuses rather than guesses at, each an `ImapWireError`:
//   * a line longer than `MAX_LINE_BYTES`, a literal larger than
//     `MAX_LITERAL_BYTES`, or a response past `MAX_RESPONSE_BYTES` — a server
//     that streams forever is not answering;
//   * a quoted string or list that never closes.
//
// And one thing it builds: a command's arguments. `quoted` writes a string
// the server reads back byte for byte, and refuses a CR, LF or NUL — the
// characters that would end the command early and start another. A command
// line is only ever assembled from these, so no value a caller passes can
// become a second command.

/** One response line longer than this is refused — RFC 7162 §4 recommends clients accept 8192-octet command lines; a response line with no literal past 64 KiB is not a reply this client reads. */
export const MAX_LINE_BYTES = 64 * 1024; // limit: fixed — one framed line without a literal
/** A literal larger than this is refused. Header fields are all this client fetches; the largest real ones (a long References chain) are a few KiB. */
export const MAX_LITERAL_BYTES = 1024 * 1024; // limit: fixed — one header literal
/** Everything one command's responses may add up to. A LIST of every folder or a FETCH of a window of headers fits well inside it. */
export const MAX_RESPONSE_BYTES = 16 * 1024 * 1024; // limit: fixed — one command's untagged responses together

export class ImapWireError extends Error {
  override readonly name = "ImapWireError";
  constructor(
    readonly code: "too_large" | "protocol",
    message: string,
  ) {
    super(message);
  }
}

/** A parsed value: an atom or quoted string (a string), a literal (its bytes), NIL (null), or a list. */
export type ImapValue = string | Buffer | null | ImapValue[];

/**
 * Frames a byte stream into responses: one line, CRLF-terminated, with each
 * `{n}` literal's n bytes and the rest of the line folded in. `take()`
 * returns the next complete response (without its final CRLF), or undefined
 * until one has arrived.
 */
export class ResponseFramer {
  #buf: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): void {
    this.#buf = this.#buf.length === 0 ? chunk : Buffer.concat([this.#buf, chunk]);
  }

  take(): Buffer | undefined {
    let pos = 0;
    for (;;) {
      const crlf = this.#buf.indexOf("\r\n", pos);
      if (crlf === -1) {
        if (this.#buf.length - pos > MAX_LINE_BYTES) throw new ImapWireError("too_large", `a response line past ${MAX_LINE_BYTES} bytes`);
        return undefined;
      }
      if (crlf - pos > MAX_LINE_BYTES) throw new ImapWireError("too_large", `a response line past ${MAX_LINE_BYTES} bytes`);
      const m = /\{(\d{1,10})\}$/.exec(this.#buf.subarray(Math.max(pos, crlf - 16), crlf).toString("latin1"));
      if (!m) {
        const out = Buffer.from(this.#buf.subarray(0, crlf));
        this.#buf = this.#buf.subarray(crlf + 2);
        return out;
      }
      const n = Number(m[1]);
      if (n > MAX_LITERAL_BYTES) throw new ImapWireError("too_large", `a literal of ${n} bytes — past the ${MAX_LITERAL_BYTES}-byte limit`);
      const end = crlf + 2 + n;
      if (this.#buf.length < end) return undefined; // the literal is still arriving
      pos = end;
    }
  }
}

/** A response, classified by its first token. */
export type ImapResponse =
  | { kind: "tagged"; tag: string; status: "OK" | "NO" | "BAD"; code: string | undefined; text: string }
  | { kind: "untagged"; raw: Buffer }
  | { kind: "continuation"; text: string };

/** Classify one framed response. */
export function classify(raw: Buffer): ImapResponse {
  if (raw.length >= 1 && raw[0] === 0x2b /* + */) return { kind: "continuation", text: raw.subarray(1).toString("utf8").trim() };
  if (raw.length >= 2 && raw[0] === 0x2a /* * */ && raw[1] === 0x20) return { kind: "untagged", raw: raw.subarray(2) };
  const line = raw.toString("utf8");
  const m = /^([A-Za-z0-9]+) (OK|NO|BAD)(?: (.*))?$/is.exec(line);
  if (!m) throw new ImapWireError("protocol", "a response that is neither tagged, untagged nor a continuation");
  const rest = m[3] ?? "";
  const code = /^\[([^\]]*)\]\s*/.exec(rest);
  return { kind: "tagged", tag: m[1]!, status: m[2]!.toUpperCase() as "OK" | "NO" | "BAD", code: code?.[1], text: code ? rest.slice(code[0].length) : rest };
}

/** The status text of an untagged `OK`/`NO`/`BAD`/`BYE`/`PREAUTH`, and its response code. */
export function untaggedStatus(raw: Buffer): { status: string; code: string | undefined; text: string } | undefined {
  const line = raw.toString("utf8");
  const m = /^(OK|NO|BAD|BYE|PREAUTH)(?: (.*))?$/is.exec(line);
  if (!m) return undefined;
  const rest = m[2] ?? "";
  const code = /^\[([^\]]*)\]\s*/.exec(rest);
  return { status: m[1]!.toUpperCase(), code: code?.[1], text: code ? rest.slice(code[0].length) : rest };
}

/**
 * Tokenize a response (without its leading `* `). Atoms may carry a
 * bracketed section with spaces inside (`BODY[HEADER.FIELDS (FROM TO)]`),
 * which is one atom, as RFC 3501's `section` grammar has it.
 */
export function tokenize(raw: Buffer): ImapValue[] {
  let i = 0;
  const n = raw.length;
  const SP = 0x20;
  const value = (): ImapValue => {
    const c = raw[i]!;
    if (c === 0x28 /* ( */) {
      i++;
      const list: ImapValue[] = [];
      for (;;) {
        while (i < n && raw[i] === SP) i++;
        if (i >= n) throw new ImapWireError("protocol", "a list that never closes");
        if (raw[i] === 0x29 /* ) */) {
          i++;
          return list;
        }
        list.push(value());
      }
    }
    if (c === 0x22 /* " */) {
      i++;
      const bytes: number[] = [];
      for (;;) {
        if (i >= n) throw new ImapWireError("protocol", "a quoted string that never closes");
        const b = raw[i++]!;
        if (b === 0x22) break;
        if (b === 0x5c /* \ */) {
          if (i >= n) throw new ImapWireError("protocol", "a quoted string that never closes");
          bytes.push(raw[i++]!);
          continue;
        }
        bytes.push(b);
      }
      return Buffer.from(bytes).toString("utf8");
    }
    if (c === 0x7b /* { */) {
      const close = raw.indexOf(0x7d, i);
      const len = close === -1 ? NaN : Number(raw.subarray(i + 1, close).toString("latin1").replace(/\+$/, ""));
      if (!Number.isInteger(len) || raw[close + 1] !== 0x0d || raw[close + 2] !== 0x0a) throw new ImapWireError("protocol", "a malformed literal");
      const start = close + 3;
      if (start + len > n) throw new ImapWireError("protocol", "a literal shorter than it says");
      i = start + len;
      return Buffer.from(raw.subarray(start, start + len));
    }
    const start = i;
    let depth = 0;
    while (i < n) {
      const b = raw[i]!;
      if (b === 0x5b /* [ */) depth++;
      else if (b === 0x5d /* ] */) depth = Math.max(0, depth - 1);
      else if (depth === 0 && (b === SP || b === 0x28 || b === 0x29 || b === 0x0d || b === 0x0a)) break;
      i++;
    }
    if (i === start) throw new ImapWireError("protocol", `an unexpected ${JSON.stringify(String.fromCharCode(c))}`);
    const atom = raw.subarray(start, i).toString("utf8");
    return atom.toUpperCase() === "NIL" ? null : atom;
  };
  const out: ImapValue[] = [];
  while (i < n) {
    if (raw[i] === SP) {
      i++;
      continue;
    }
    out.push(value());
  }
  return out;
}

/** A value as text: an atom or quoted string as it is, a literal decoded as UTF-8 (RFC 6532), NIL as undefined. */
export function text(v: ImapValue | undefined): string | undefined {
  if (v === null || v === undefined || Array.isArray(v)) return undefined;
  return typeof v === "string" ? v : v.toString("utf8");
}

/**
 * A quoted string (RFC 3501 §4.3) for a command argument: `"` and `\`
 * escaped. Refused — never written — when it holds a CR, LF or NUL (they
 * would end the command and begin another) or a byte outside 7-bit ASCII
 * (a quoted string is 7-bit; a mailbox name is already modified UTF-7 as the
 * server spelled it). The refusal names the argument, never its value.
 */
export function quoted(value: string, what: string): string {
  if (/[\r\n\0]/.test(value)) throw new ImapWireError("protocol", `${what} holds a line break or NUL — it is never written into a command`);
  if (/[^\x01-\x7f]/.test(value)) throw new ImapWireError("protocol", `${what} holds a character outside 7-bit ASCII — it cannot be written as an IMAP quoted string`);
  return `"${value.replace(/[\\"]/g, (c) => `\\${c}`)}"`;
}

/**
 * Modified UTF-7 (RFC 3501 §5.1.3) → text, for showing a mailbox's name.
 * The raw name is what every command uses; this is for people.
 */
export function decodeMailboxName(raw: string): string {
  return raw.replace(/&([^-]*)-/g, (_, b64: string) => {
    if (b64 === "") return "&";
    const bytes = Buffer.from(b64.replace(/,/g, "/"), "base64");
    let s = "";
    for (let k = 0; k + 1 < bytes.length; k += 2) s += String.fromCharCode((bytes[k]! << 8) | bytes[k + 1]!);
    return s;
  });
}
