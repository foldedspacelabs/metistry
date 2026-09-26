// The connection model (plan §2.6) and the closed vocabularies a
// connection-type manifest names values from (§2.7).
//
// A **connection** is anything outside Metistry it reaches for the owner. Its
// **type** says what kind of thing it is (this file's `CONNECTION_TYPES`); its
// **provider** is a `connection-type` unit (manifest.ts, loaded through
// registry.ts) that knows how to reach it — or `custom`, configured by hand.
//
// Everything named here is CLOSED ON PURPOSE (§2.7): the types, each type's
// capability vocabulary, the reach classes, the field kinds, the tool groups
// and modes, the auth schemes, the OAuth redirect modes. A plugin names values
// from these lists and never adds one — a new value is a product change,
// reviewed as code, because Today and Needs You act on capabilities and the
// egress guard acts on reach. The schemas below are where that is enforced:
// an unknown value is refused, never ignored.
//
// This module has no I/O and imports nothing from the rest of core except
// types, so manifest.ts can build the `connection-type` manifest from it
// without a cycle.

import { z } from "zod";
import type { ConnectionTypeManifest } from "./manifest.js";

// --- the closed vocabularies ---------------------------------------------------

/** What a connection IS (§2.6). `agent` is today's `targets/`; `calendar`, `mail` (ruling 5) and `tracker` (§4 Q22) are consumed by capability. */
export const CONNECTION_TYPES = ["mcp", "agent", "api", "feed", "files", "calendar", "mail", "tracker"] as const;
export type ConnectionType = (typeof CONNECTION_TYPES)[number];

/**
 * Each type's capability vocabulary (§2.6). Today and Needs You consume
 * capabilities, never provider names — so a provider that can reply to an
 * invitation says `rsvp`, and Respond is refused where no connected provider
 * does (T4-17). The first five types are consumed through their tools, not
 * capabilities, so their vocabulary is empty: declaring any capability on one
 * is refused.
 */
export const CONNECTION_CAPABILITIES = {
  mcp: [],
  agent: [],
  api: [],
  feed: [],
  files: [],
  calendar: ["read", "write_own", "rsvp"],
  mail: ["read", "draft"],
  tracker: ["read", "create", "complete"],
} as const satisfies Record<ConnectionType, readonly string[]>;
export type ConnectionCapability = (typeof CONNECTION_CAPABILITIES)[ConnectionType][number];

/**
 * Capabilities refused BY NAME, with the reason — values a manifest author is
 * likely to reach for and the product has decided against. Not merely absent
 * from the vocabulary: named, so the refusal says why.
 */
export const REFUSED_CAPABILITIES: Readonly<Partial<Record<ConnectionType, Readonly<Record<string, string>>>>> = {
  mail: {
    send: "nothing sends mail (§2.6) — no provider gets a send capability; Draft Reply writes a draft the owner sends",
  },
};

/** Why `capability` is not one `type` may declare, or undefined when it may. */
export function capabilityIssue(type: ConnectionType, capability: string): string | undefined {
  const named = REFUSED_CAPABILITIES[type];
  if (named && Object.hasOwn(named, capability)) return `${type}: ${capability} is refused — ${named[capability]}`;
  const vocabulary: readonly string[] = CONNECTION_CAPABILITIES[type];
  if (vocabulary.includes(capability)) return undefined;
  return vocabulary.length === 0
    ? `${type} connections have no capabilities (they are consumed through their tools) — "${capability}" is not one`
    : `unknown ${type} capability "${capability}" — one of ${vocabulary.join(", ")}`;
}

/** How Metistry reaches a connection (C118): over HTTP, by running a command, or at a path. The bridges' `transport: http | stdio` are the first two. */
export const REACH_CLASSES = ["http", "command", "path"] as const;
export type ReachClass = (typeof REACH_CLASSES)[number];

/**
 * The reach each type's NATIVE handler speaks (C118's table): the generic MCP
 * client, dispatch, the HTTP tool generator, the feed reader, the file
 * reader. `calendar`, `mail` and `tracker` have no native handler — their
 * providers are product code (`builtin`) or a bridge — so a custom connection
 * of those types has nothing to run and is refused.
 */
export const NATIVE_REACH: Readonly<Record<ConnectionType, readonly ReachClass[]>> = {
  mcp: ["http", "command"],
  agent: ["http", "command"],
  api: ["http"],
  feed: ["http"],
  files: ["path", "http"],
  calendar: [],
  mail: [],
  tracker: [],
};

/** What a connection-type's config fields may be (§2.7). The app renders a known service's form from these — no per-service Swift. */
export const FIELD_KINDS = ["text", "secret", "variable", "url", "choice", "oauth"] as const;
export type FieldKind = (typeof FIELD_KINDS)[number];

/** Tools, by what they do (screen-09 §10.3: Reads · Changes things · Starts an agent). */
export const TOOL_GROUPS = ["reads", "changes", "starts_agent"] as const;
export type ToolGroup = (typeof TOOL_GROUPS)[number];

/** The owner's per-tool policy (C114, K4). */
export const TOOL_MODES = ["on", "ask", "off"] as const;
export type ToolMode = (typeof TOOL_MODES)[number];

/** A proxied connection tool's mode when the owner has not set one: Ask (CLAUDE.md, Packages — ratified 2026-09-26). A manifest cannot choose it. */
export const DEFAULT_TOOL_MODE: ToolMode = "ask";

/** The authentication shortcuts an HTTP reach offers (screen-09 §10.5). */
export const AUTH_SCHEMES = ["none", "bearer", "basic", "api_key", "oauth"] as const;
export type AuthScheme = (typeof AUTH_SCHEMES)[number];

/**
 * Where an OAuth provider redirects (§2.6). `loopback`: the Mac app listens on
 * 127.0.0.1 for one callback — a public client, PKCE required. `broker`:
 * `auth.metistry.app` performs the exchange for providers that demand a
 * confidential secret or an https redirect — modelled now, built when the
 * first such provider is scheduled (§5).
 */
export const OAUTH_REDIRECTS = ["loopback", "broker"] as const;
export type OAuthRedirect = (typeof OAUTH_REDIRECTS)[number];

/** The provider value of a connection configured by hand rather than by a connection type. Reserved: no connection type may take the name. */
export const CUSTOM_PROVIDER = "custom";

// --- shared shapes -------------------------------------------------------------

const kebab = z.string().regex(/^[a-z][a-z0-9-]*$/, "names are lowercase kebab-case (casing rule: only the vault is TitleCase)");

/** A config field's key, a secret's name, a variable's name: lowercase snake_case (§2.14). */
const snake = (what: string) => z.string().regex(/^[a-z][a-z0-9_]*$/, `${what} are lowercase snake_case`);
const fieldKey = snake("field keys");
const secretName = snake("secret names");
const variableName = snake("variable names");

/** A tool name as an upstream server spells it (MCP allows mixed case, `-`, `.`). */
const toolName = z.string().regex(/^[A-Za-z][A-Za-z0-9_.-]*$/, "tool names start with a letter and use letters, digits, _ . -");

const headerName = z.string().regex(/^[A-Za-z0-9-]+$/, "header names are letters, digits and -");
const envName = z.string().regex(/^[A-Z][A-Z0-9_]*$/, "environment variable names are UPPER_SNAKE_CASE");

/** An https URL with no credentials in it — an authorization or token endpoint. */
const httpsUrl = z.string().superRefine((v, ctx) => {
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    ctx.addIssue({ code: "custom", message: `not a URL: ${v}` });
    return;
  }
  if (u.protocol !== "https:") ctx.addIssue({ code: "custom", message: `OAuth endpoints are https only — ${u.protocol} is refused` });
  if (u.username || u.password) ctx.addIssue({ code: "custom", message: "a URL never carries credentials" });
});

// --- the OAuth client model (§2.6) ---------------------------------------------

/**
 * The client an `oauth` field signs in with. Metistry ships ONE public client
 * id per provider that supports public clients (Google, Microsoft): installed
 * apps cannot keep a secret, the provider says so, and PKCE with a loopback
 * redirect is the flow it recommends — so no user ever registers an app and no
 * Metistry server is in the path.
 *
 * What the schema makes impossible:
 *   - a `client_secret` in a manifest — a manifest is public; a provider that
 *     needs a confidential secret goes through the broker, and a
 *     bring-your-own secret is a per-instance secret (§2.14), never a file;
 *   - a loopback redirect without PKCE — a public client without PKCE is an
 *     interceptable code;
 *   - turning bring-your-own off — every OAuth connection accepts the owner's
 *     own client (§2.6 recommendation 2), so `allowed` is the only value;
 *   - a non-https endpoint, or scopes kept out of the manifest — the scopes
 *     are what a reviewer reads to know what the client can reach.
 */
export const oauthClientSchema = z
  .strictObject({
    /** The shipped public client id. Not a secret. Absent: nothing ships — the owner brings their own client. */
    client_id: z.string().min(1).optional(),
    client_secret: z
      .never({
        error:
          "client_secret never appears in a manifest — a shipped client is public (PKCE, §2.6); a provider that needs a secret goes through the broker, and a bring-your-own secret is a per-instance secret",
      })
      .optional(),
    pkce: z.boolean(),
    redirect: z.enum(OAUTH_REDIRECTS),
    bring_your_own: z
      .literal("allowed", { error: "every OAuth connection accepts a bring-your-own client (§2.6) — the only value is allowed" })
      .default("allowed"),
    authorize_url: httpsUrl,
    token_url: httpsUrl,
    scopes: z.array(z.string().regex(/^\S+$/, "a scope has no whitespace")).min(1, "declare the scopes — they are what a reviewer reads"),
  })
  .superRefine((c, ctx) => {
    if (c.redirect === "loopback" && c.pkce !== true) {
      ctx.addIssue({ code: "custom", path: ["pkce"], message: "a loopback redirect is a public client — pkce must be true" });
    }
  });

export type OAuthClient = z.infer<typeof oauthClientSchema>;

// --- connection-type pieces (assembled into the manifest in manifest.ts) -------

const fieldCommon = {
  key: fieldKey,
  label: z.string().min(1),
  help: z.string().optional(),
  required: z.boolean().default(true),
};

const choiceOption = z.strictObject({ value: z.string().min(1), label: z.string().min(1) });

/**
 * One config field of a connection type, discriminated by its kind. A field
 * of an unknown kind is refused (the vocabulary is closed), and a `secret`
 * field can never carry a default — a value in a manifest is a published
 * secret.
 */
export const connectionFieldSchema = z.discriminatedUnion(
  "kind",
  [
    z.strictObject({ ...fieldCommon, kind: z.literal("text"), default: z.string().optional() }),
    z.strictObject({
      ...fieldCommon,
      kind: z.literal("secret"),
      default: z.never({ error: "a secret field never has a default — a value in a manifest is a published secret" }).optional(),
    }),
    z.strictObject({ ...fieldCommon, kind: z.literal("variable") }),
    z.strictObject({ ...fieldCommon, kind: z.literal("url"), default: z.url().optional() }),
    z
      .strictObject({ ...fieldCommon, kind: z.literal("choice"), options: z.array(choiceOption).min(1), default: z.string().optional() })
      .superRefine((f, ctx) => {
        const values = f.options.map((o) => o.value);
        if (new Set(values).size !== values.length) ctx.addIssue({ code: "custom", path: ["options"], message: "choice values are unique" });
        if (f.default !== undefined && !values.includes(f.default)) {
          ctx.addIssue({ code: "custom", path: ["default"], message: `default "${f.default}" is not one of the options` });
        }
      }),
    z.strictObject({ ...fieldCommon, kind: z.literal("oauth"), oauth: oauthClientSchema }),
  ],
  {
    error: (iss) =>
      iss.code === "invalid_union" && (iss as { note?: string }).note === "No matching discriminator"
        ? `unknown field kind ${JSON.stringify((iss.input as { kind?: unknown } | undefined)?.kind)} — one of ${FIELD_KINDS.join(", ")}`
        : undefined,
  },
);

export type ConnectionField = z.infer<typeof connectionFieldSchema>;

/** A tool a connection type offers, with the group that decides its default treatment. No mode: the mode is the owner's (DEFAULT_TOOL_MODE). */
export const connectionTypeToolSchema = z.strictObject({
  group: z.enum(TOOL_GROUPS),
  description: z.string().optional(),
});

/**
 * What runs a connection of this type. `native`: the type's own handler
 * (NATIVE_REACH) — what a data-only extension, like a known MCP service, uses.
 * `builtin`: product code in `packages/connections`, named by module.
 * `bridge`: an existing bridge (`eventkit`, `apple-mail`), reached over its
 * HTTP MCP. Code from an extension never runs inside the console (§2.7):
 * process extensions are designed in §5 and are not a value here.
 */
export const connectionImplementationSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("native") }),
  z.strictObject({ kind: z.literal("builtin"), module: kebab }),
  z.strictObject({ kind: z.literal("bridge"), bridge: kebab }),
]);

export type ConnectionImplementation = z.infer<typeof connectionImplementationSchema>;

/** The connection-type manifest's body, beside `name`, `type` and `schema` (manifest.ts). */
export const connectionTypeShape = {
  /** Which connection type this provider provides (§2.6). Not `type` — that is every manifest's kind marker, and `agent` is both a manifest type and a connection type. */
  provides: z.enum(CONNECTION_TYPES),
  transports: z.array(z.enum(REACH_CLASSES)).min(1),
  fields: z.array(connectionFieldSchema).default([]),
  capabilities: z.array(z.string()).default([]),
  tools: z.record(toolName, connectionTypeToolSchema).default({}),
  /** The sync (a collector unit) that reads connections of this type; its default schedule lives in that unit's manifest (§2.5). */
  sync: kebab.optional(),
  implementation: connectionImplementationSchema.default({ kind: "native" }),
};

/** The cross-field rules of a connection-type manifest, run by its schema's superRefine. */
export function refineConnectionType(
  m: { name: string; provides: ConnectionType; transports: ReachClass[]; fields: ConnectionField[]; capabilities: string[]; implementation: ConnectionImplementation },
  ctx: z.RefinementCtx,
): void {
  if (m.name === CUSTOM_PROVIDER) {
    ctx.addIssue({ code: "custom", path: ["name"], message: `"${CUSTOM_PROVIDER}" is reserved for connections configured by hand` });
  }
  m.capabilities.forEach((c, i) => {
    const why = capabilityIssue(m.provides, c);
    if (why) ctx.addIssue({ code: "custom", path: ["capabilities", i], message: why });
  });
  if (new Set(m.capabilities).size !== m.capabilities.length) {
    ctx.addIssue({ code: "custom", path: ["capabilities"], message: "capabilities are listed once each" });
  }
  if (new Set(m.transports).size !== m.transports.length) {
    ctx.addIssue({ code: "custom", path: ["transports"], message: "transports are listed once each" });
  }
  const keys = m.fields.map((f) => f.key);
  keys.forEach((k, i) => {
    if (keys.indexOf(k) !== i) ctx.addIssue({ code: "custom", path: ["fields", i, "key"], message: `field key "${k}" is declared twice` });
  });
  if (m.implementation.kind === "native") {
    const speaks = NATIVE_REACH[m.provides];
    if (speaks.length === 0) {
      ctx.addIssue({
        code: "custom",
        path: ["implementation"],
        message: `${m.provides} has no native handler — a ${m.provides} provider is builtin product code or a bridge`,
      });
    }
    for (const t of m.transports) {
      if (speaks.length > 0 && !speaks.includes(t)) {
        ctx.addIssue({ code: "custom", path: ["transports"], message: `the native ${m.provides} handler does not speak ${t} — it speaks ${speaks.join(", ")}` });
      }
    }
  }
}

// --- the connection file (.metistry/connections/<name>.yaml) -------------------

/**
 * `{{ secret.x }}` and `{{ variable.x }}` — the only two things a connection
 * value may template (§2.14, C118). Anything else in double braces is refused
 * rather than passed through as text a later step might expand.
 */
const TEMPLATE_REF = /\{\{\s*([^{}\s.]+)\.([^{}\s]+)\s*\}\}|\{\{[^{}]*\}\}/g;

/** The secret and variable names a value references, and any template it cannot. */
export function templateRefs(value: string): { secrets: string[]; variables: string[]; invalid: string[] } {
  const out = { secrets: [] as string[], variables: [] as string[], invalid: [] as string[] };
  for (const m of value.matchAll(TEMPLATE_REF)) {
    const [whole, ns, ref] = m;
    if (ns === "secret" && ref && /^[a-z][a-z0-9_]*$/.test(ref)) out.secrets.push(ref);
    else if (ns === "variable" && ref && /^[a-z][a-z0-9_]*$/.test(ref)) out.variables.push(ref);
    else out.invalid.push(whole);
  }
  return out;
}

/** The authentication shortcut on an HTTP reach. A bare string is shorthand: `auth: oauth` is `{ scheme: oauth }`. */
export const httpAuthSchema = z.preprocess(
  (v) => (typeof v === "string" ? { scheme: v } : v),
  z.discriminatedUnion(
    "scheme",
    [
      z.strictObject({ scheme: z.literal("none") }),
      z.strictObject({ scheme: z.literal("bearer"), secret: secretName }),
      z.strictObject({ scheme: z.literal("basic"), username: z.string().min(1), secret: secretName }),
      /** `header` as the service spells it — Linear's personal key is `Authorization: <API_KEY>`, no Bearer. */
      z.strictObject({ scheme: z.literal("api_key"), header: headerName, secret: secretName }),
      /** The token comes from the provider's `oauth` field; `field` names it when the type has more than one. */
      z.strictObject({ scheme: z.literal("oauth"), field: fieldKey.optional() }),
    ],
    {
      error: (iss) =>
        iss.code === "invalid_union" && (iss as { note?: string }).note === "No matching discriminator"
          ? `unknown auth scheme — one of ${AUTH_SCHEMES.join(", ")}`
          : undefined,
    },
  ),
);

export type HttpAuth = z.infer<typeof httpAuthSchema>;

const httpReach = z.strictObject({
  url: z.string().regex(/^(https?:\/\/|\{\{)/, "an HTTP reach is an http(s) URL, or a {{ variable.x }} that holds one"),
  auth: httpAuthSchema.default({ scheme: "none" }),
  query: z.record(z.string().min(1), z.string()).default({}),
  headers: z.record(headerName, z.string()).default({}),
  timeout_s: z.number().positive().optional(),
});

const commandReach = z.strictObject({
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  cwd: z.string().optional(),
  /** Given to this command only; a secret here is never written to disk (screen-09 §10.5). */
  env: z.record(envName, z.string()).default({}),
  runs_on: z.enum(["host", "container"]).default("host"),
});

const pathReach = z.strictObject({
  path: z.string().min(1),
  include: z.array(z.string()).default([]),
  skip: z.array(z.string()).default([]),
  watch: z.boolean().default(false),
});

/** Exactly one of `http`, `command`, `path` (C118). */
export const reachSchema = z
  .strictObject({ http: httpReach.optional(), command: commandReach.optional(), path: pathReach.optional() })
  .superRefine((r, ctx) => {
    const given = REACH_CLASSES.filter((c) => r[c] !== undefined);
    if (given.length !== 1) {
      ctx.addIssue({ code: "custom", message: `reach is exactly one of ${REACH_CLASSES.join(", ")} — got ${given.length ? given.join(", ") : "none"}` });
    }
  });

export type Reach = z.infer<typeof reachSchema>;

/** The class of a (valid) reach. */
export function reachClassOf(r: Reach): ReachClass {
  return r.http ? "http" : r.command ? "command" : "path";
}

/** An `oauth` field's value on a connection: where the token is kept, and a bring-your-own client, each a secret reference. */
const oauthConfigValue = z.strictObject({
  token: z.string(),
  client_id: z.string().optional(),
  client_secret: z.string().optional(),
});

const connectionToolPolicy = z.strictObject({
  group: z.enum(TOOL_GROUPS),
  mode: z.enum(TOOL_MODES).default(DEFAULT_TOOL_MODE),
});

/** Every string value in a connection file that may carry a template, with its path. */
function templatedValues(c: {
  reach: Reach;
  config: Record<string, string | z.infer<typeof oauthConfigValue>>;
}): { path: (string | number)[]; value: string }[] {
  const out: { path: (string | number)[]; value: string }[] = [];
  const add = (path: (string | number)[], value: string | undefined) => {
    if (value !== undefined) out.push({ path, value });
  };
  const { http, command, path } = c.reach;
  if (http) {
    add(["reach", "http", "url"], http.url);
    for (const [k, v] of Object.entries(http.query)) add(["reach", "http", "query", k], v);
    for (const [k, v] of Object.entries(http.headers)) add(["reach", "http", "headers", k], v);
    if (http.auth.scheme === "basic") add(["reach", "http", "auth", "username"], http.auth.username);
  }
  if (command) {
    add(["reach", "command", "command"], command.command);
    command.args.forEach((a, i) => add(["reach", "command", "args", i], a));
    add(["reach", "command", "cwd"], command.cwd);
    for (const [k, v] of Object.entries(command.env)) add(["reach", "command", "env", k], v);
  }
  if (path) {
    add(["reach", "path", "path"], path.path);
    path.include.forEach((p, i) => add(["reach", "path", "include", i], p));
    path.skip.forEach((p, i) => add(["reach", "path", "skip", i], p));
  }
  for (const [k, v] of Object.entries(c.config)) {
    if (typeof v === "string") add(["config", k], v);
    else for (const [part, s] of Object.entries(v)) add(["config", k, part], s as string | undefined);
  }
  return out;
}

/**
 * `.metistry/connections/<name>.yaml` — one connection, written only by the
 * CLI (M13). Secrets and variables are NAMES; a value never appears here. A
 * name used in a value (`{{ secret.x }}`) or by the auth shortcut must be
 * listed in `secrets` / `variables`, because those lists are what the grant
 * check and the egress guard read. Syncs for the connection live in
 * `scheduled.yaml` (§2.5), never here.
 */
export const connectionFileSchema = z
  .strictObject({
    name: kebab,
    type: z.enum(CONNECTION_TYPES),
    /** A connection-type id (a registry name), or `custom`. */
    provider: kebab,
    description: z.string().optional(),
    reach: reachSchema,
    secrets: z.array(secretName).default([]),
    variables: z.array(variableName).default([]),
    /** Values for the provider's config fields, keyed by field key. A `custom` connection has none. */
    config: z.record(fieldKey, z.union([z.string(), oauthConfigValue])).default({}),
    /** The owner's per-tool policy: the tool's group and its mode (default Ask). */
    tools: z.record(toolName, connectionToolPolicy).default({}),
    /** Off: the assistant and syncs only. On: agents may reach it through the proxy, per their grants (C115). */
    offer_to_agents: z.boolean().default(false),
  })
  .superRefine((c, ctx) => {
    for (const list of ["secrets", "variables"] as const) {
      if (new Set(c[list]).size !== c[list].length) ctx.addIssue({ code: "custom", path: [list], message: `${list} are listed once each` });
    }
    for (const { path, value } of templatedValues(c)) {
      const refs = templateRefs(value);
      for (const bad of refs.invalid) {
        ctx.addIssue({ code: "custom", path, message: `${bad} is not a reference a connection takes — only {{ secret.name }} and {{ variable.name }}` });
      }
      for (const s of refs.secrets) {
        if (!c.secrets.includes(s)) ctx.addIssue({ code: "custom", path, message: `secret "${s}" is used but not listed in secrets` });
      }
      for (const v of refs.variables) {
        if (!c.variables.includes(v)) ctx.addIssue({ code: "custom", path, message: `variable "${v}" is used but not listed in variables` });
      }
    }
    const auth = c.reach.http?.auth;
    if (auth && "secret" in auth && !c.secrets.includes(auth.secret)) {
      ctx.addIssue({ code: "custom", path: ["reach", "http", "auth", "secret"], message: `secret "${auth.secret}" is used but not listed in secrets` });
    }
    if (c.provider === CUSTOM_PROVIDER) {
      const speaks = NATIVE_REACH[c.type];
      if (speaks.length === 0) {
        ctx.addIssue({ code: "custom", path: ["provider"], message: `a ${c.type} connection needs a connection type — a custom one has nothing to run it` });
      } else if (!speaks.includes(reachClassOf(c.reach))) {
        ctx.addIssue({ code: "custom", path: ["reach"], message: `a custom ${c.type} connection is reached by ${speaks.join(" or ")}` });
      }
      if (Object.keys(c.config).length > 0) {
        ctx.addIssue({ code: "custom", path: ["config"], message: "a custom connection has no config fields — its settings are its reach" });
      }
    }
  });

export type ConnectionFile = z.infer<typeof connectionFileSchema>;

export type ConnectionFileResult = { ok: true; connection: ConnectionFile } | { ok: false; errors: string[] };

/** Validate a parsed connection file. Never throws. */
export function validateConnectionFile(input: unknown): ConnectionFileResult {
  const parsed = connectionFileSchema.safeParse(input);
  if (parsed.success) return { ok: true, connection: parsed.data };
  return { ok: false, errors: parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`) };
}

/** A string that is exactly one `{{ <ns>.<name> }}` reference, or undefined. */
function soleRef(value: string, ns: "secret" | "variable"): string | undefined {
  const m = /^\{\{\s*(secret|variable)\.([a-z][a-z0-9_]*)\s*\}\}$/.exec(value);
  return m && m[1] === ns ? m[2] : undefined;
}

/**
 * The rules that join a (valid) connection file to its provider's (valid)
 * connection-type manifest. `type` is the registry's unit for `provider`, or
 * undefined when none is installed — the connection is then `absent`, naming
 * the missing unit (§2.7), and nothing is deleted. Empty = consistent.
 *
 * The one that matters most: a tool the type declares keeps the type's group.
 * The group decides how a tool is treated, so a file that relabels a
 * `changes` tool as `reads` is refused, not believed.
 */
export function connectionIssues(c: ConnectionFile, type: ConnectionTypeManifest | undefined): string[] {
  if (c.provider === CUSTOM_PROVIDER) return [];
  if (!type) return [`provider "${c.provider}" is not installed — the connection is absent until it is`];
  const issues: string[] = [];
  if (type.provides !== c.type) issues.push(`provider "${type.name}" provides ${type.provides}, not ${c.type}`);
  const reach = reachClassOf(c.reach);
  if (!type.transports.includes(reach)) issues.push(`reach: ${type.name} is reached by ${type.transports.join(" or ")}, not ${reach}`);

  const fields = new Map(type.fields.map((f) => [f.key, f]));
  for (const key of Object.keys(c.config)) if (!fields.has(key)) issues.push(`config.${key}: ${type.name} has no field "${key}"`);
  for (const f of type.fields) {
    const value = c.config[f.key];
    if (value === undefined) {
      if (f.required && !("default" in f && f.default !== undefined)) issues.push(`config.${f.key}: required by ${type.name}`);
      continue;
    }
    if (f.kind === "oauth") {
      if (typeof value === "string") {
        issues.push(`config.${f.key}: an oauth field is { token, client_id?, client_secret? }, each a {{ secret.name }}`);
        continue;
      }
      for (const [part, v] of Object.entries(value)) {
        if (v !== undefined && !soleRef(v, "secret")) issues.push(`config.${f.key}.${part}: must be a {{ secret.name }} reference`);
      }
      continue;
    }
    if (typeof value !== "string") {
      issues.push(`config.${f.key}: a ${f.kind} field takes a string`);
      continue;
    }
    if (f.kind === "secret" && !soleRef(value, "secret")) {
      issues.push(`config.${f.key}: a secret field's value is a {{ secret.name }} reference, never text`);
    } else if (f.kind === "variable" && !soleRef(value, "variable")) {
      issues.push(`config.${f.key}: a variable field's value is a {{ variable.name }} reference`);
    } else if (f.kind === "choice" && !f.options.some((o) => o.value === value)) {
      issues.push(`config.${f.key}: "${value}" is not one of ${f.options.map((o) => o.value).join(", ")}`);
    }
  }

  const auth = c.reach.http?.auth;
  if (auth?.scheme === "oauth") {
    const oauthKeys = type.fields.filter((f) => f.kind === "oauth").map((f) => f.key);
    if (auth.field !== undefined && !oauthKeys.includes(auth.field)) {
      issues.push(`reach.http.auth.field: ${type.name} has no oauth field "${auth.field}"`);
    } else if (auth.field === undefined && oauthKeys.length !== 1) {
      issues.push(
        oauthKeys.length === 0
          ? `reach.http.auth: ${type.name} declares no oauth field to sign in with`
          : `reach.http.auth.field: ${type.name} has ${oauthKeys.length} oauth fields — name one (${oauthKeys.join(", ")})`,
      );
    }
  }

  for (const [tool, policy] of Object.entries(c.tools)) {
    const declared = type.tools[tool];
    if (declared && declared.group !== policy.group) {
      issues.push(`tools.${tool}: ${type.name} declares it ${declared.group} — a connection cannot relabel it ${policy.group}`);
    } else if (!declared && type.provides !== "mcp" && Object.keys(type.tools).length > 0) {
      issues.push(`tools.${tool}: ${type.name} has no tool "${tool}"`);
    }
  }
  return issues;
}
