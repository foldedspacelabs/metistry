// The door a connection's own HTTP requests go through — the MCP transport's,
// a generated tool's, a sync's (plan §2.6, T4-2): core's `guardedFetch` with
// the connection as the grantee, pinned to one origin, no redirect followed.
//
// And the two sources that turn a sign-in shortcut into what the door fills:
// `basicSource` (an app password, encoded with its username inside the door)
// and, for OAuth, `oauthSource` in oauth.ts (the access token minted from the
// stored refresh token). Either way the header holds a `{{ secret.x }}`
// reference, and the value is filled for a host on that secret's *Sent only
// to* list, when granted to `connection:<name>`, or not at all.

import { SecretRedactor, guardedFetch, type SecretSource, type SecretsFile } from "@foldedspacelabs/metistry-core";
import { ConnectionRefused } from "./errors.js";

/** The grantee a connection's own secrets are granted to (`secrets.yaml`). */
export function connectionGrantee(name: string): string {
  return `connection:${name}`;
}

/**
 * Basic sign-in (RFC 7617) at the door: the header the caller holds is
 * `Basic {{ secret.<name> }}`, and this source fills that reference with
 * `base64(<username>:<value>)` — so the encoding happens inside the door,
 * for a listed host or not at all, and the pair never exists outside it.
 * The redactor learns the value itself as well as the encoded pair, so a
 * server that echoes either shows the secret's name, never the value.
 * Every other name reads through unchanged.
 */
export function basicSource(source: SecretSource, basic: { secret: string; username: string }, redactor: SecretRedactor): SecretSource {
  return {
    async value(name) {
      const v = await source.value(name);
      if (name !== basic.secret || v === undefined) return v;
      redactor.learn(name, v);
      return Buffer.from(`${basic.username}:${v}`, "utf8").toString("base64");
    },
  };
}

export function urlOf(input: Parameters<typeof fetch>[0]): string {
  return input instanceof Request ? input.url : input instanceof URL ? input.href : String(input);
}

export interface PinnedDoorOptions {
  /** the connection's name — the grantee, and the name a refusal carries */
  connection: string;
  /** the only origin a request may go to */
  origin: string;
  /** the secrets policy each request is checked against — read per request, so the latest the host has read applies */
  secrets: () => SecretsFile;
  source: SecretSource;
  redactor: SecretRedactor;
  /** told the NAMES a request carried */
  onUse?: ((names: string[]) => void) | undefined;
  /** the base fetch under the door (a test's fixture server; default global fetch) */
  fetch?: typeof fetch | undefined;
}

/**
 * A `fetch` that reaches `origin` and nowhere else, through the egress door,
 * following no redirect: a request elsewhere, or a 3xx, is `other_host`
 * before (or instead of) anything else happening.
 */
export function pinnedDoor(opts: PinnedDoorOptions): typeof fetch {
  const base = opts.fetch ?? fetch;
  return async (input, init) => {
    const url = urlOf(input);
    let target: URL;
    try {
      target = new URL(url);
    } catch {
      throw new ConnectionRefused("other_host", opts.connection, "not a URL");
    }
    if (target.origin !== opts.origin) {
      throw new ConnectionRefused("other_host", opts.connection, `a request to ${target.origin} — this connection is ${opts.origin}, and it goes nowhere else`);
    }
    const door = guardedFetch(
      {
        secrets: opts.secrets(),
        grantee: connectionGrantee(opts.connection),
        purpose: "service",
        redactor: opts.redactor,
        source: opts.source,
        onUse: ({ names }) => opts.onUse?.(names),
      },
      base,
    );
    const res = await door(url, { ...(init ?? {}), redirect: "manual" });
    if (res.status >= 300 && res.status < 400) {
      await res.body?.cancel().catch(() => undefined);
      const loc = res.headers.get("location");
      let where = "somewhere else";
      try {
        if (loc) where = new URL(loc, url).origin;
      } catch {
        /* unparseable: say so generically */
      }
      throw new ConnectionRefused("other_host", opts.connection, `the server redirected to ${where} — a redirect is not followed; set the connection's URL to where the server lives`);
    }
    return res;
  };
}
