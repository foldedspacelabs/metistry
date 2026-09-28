// The connection model (§2.6) and the connection-type manifest (§2.7):
// the closed vocabularies are refusals with tests, not sentences (U3).
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import {
  CONNECTION_CAPABILITIES,
  FIELD_KINDS,
  capabilityIssue,
  connectionIssues,
  templateRefs,
  validateConnectionFile,
  type ConnectionFile,
} from "../src/connections.js";
import { validateManifest, type ConnectionTypeManifest } from "../src/manifest.js";

// The Google Calendar row of §2.6 — calendar; read, write_own, rsvp; OAuth
// through Metistry's shipped public client or the owner's own — as the
// connection-type manifest T4-14 will ship. The client id is a placeholder.
const GOOGLE_CALENDAR = `
schema: 1
name: google-calendar
type: connection-type
provides: calendar
description: Google Calendar, through Metistry's public OAuth client or your own
transports: [http]
fields:
  - key: account
    kind: oauth
    label: Google account
    oauth:
      client_id: 000000000000-placeholder.apps.googleusercontent.com
      pkce: true
      redirect: loopback
      bring_your_own: allowed
      authorize_url: https://accounts.google.com/o/oauth2/v2/auth
      token_url: https://oauth2.googleapis.com/token
      scopes: [https://www.googleapis.com/auth/calendar.events]
  - key: calendar_id
    kind: text
    label: Calendar
    default: primary
capabilities: [read, write_own, rsvp]
tools:
  list_events: { group: reads }
  create_event: { group: changes }
  respond_invitation: { group: changes }
implementation: { kind: builtin, module: google-calendar }
`;

const googleCalendar = () => parseYaml(GOOGLE_CALENDAR) as Record<string, unknown>;

function errorsOf(input: unknown): string {
  const r = validateManifest(input);
  if (r.ok) throw new Error("expected the manifest to be refused");
  return r.errors.join("\n");
}

function asType(input: unknown): ConnectionTypeManifest {
  const r = validateManifest(input);
  if (!r.ok) throw new Error(r.errors.join("\n"));
  if (r.manifest.type !== "connection-type") throw new Error(`not a connection type: ${r.manifest.type}`);
  return r.manifest;
}

const oauthOf = (m: Record<string, unknown>) => ((m.fields as Record<string, unknown>[])[0] as { oauth: Record<string, unknown> }).oauth;
const withOauth = (patch: Record<string, unknown>, drop: string[] = []) => {
  const m = googleCalendar();
  const oauth = { ...oauthOf(m), ...patch };
  for (const k of drop) delete oauth[k];
  (m.fields as Record<string, unknown>[])[0] = { ...(m.fields as Record<string, unknown>[])[0], oauth };
  return m;
};

describe("connection-type manifests (§2.7)", () => {
  it("accepts the Google Calendar row of §2.6 as a connection-type (the ticket's acceptance)", () => {
    const m = asType(googleCalendar());
    expect(m.provides).toBe("calendar");
    expect(m.capabilities).toEqual(["read", "write_own", "rsvp"]);
    const account = m.fields[0];
    if (account?.kind !== "oauth") throw new Error("expected the oauth field first");
    expect(account.oauth).toMatchObject({ pkce: true, redirect: "loopback", bring_your_own: "allowed" });
    expect(account.oauth.scopes).toEqual(["https://www.googleapis.com/auth/calendar.events"]);
    expect(m.tools.respond_invitation?.group).toBe("changes");
  });

  it("accepts the other providers of §2.6's table", () => {
    const rows: Record<string, unknown>[] = [
      { name: "eventkit", provides: "calendar", capabilities: ["read", "write_own"], implementation: { kind: "bridge", bridge: "eventkit" } },
      { name: "ics", provides: "calendar", capabilities: ["read"], fields: [{ key: "feed_url", kind: "secret", label: "Feed address" }], implementation: { kind: "builtin", module: "ics" } },
      {
        name: "caldav",
        provides: "calendar",
        capabilities: ["read", "write_own", "rsvp"],
        fields: [
          { key: "server", kind: "url", label: "Server", default: "https://caldav.icloud.com" },
          { key: "username", kind: "text", label: "Username" },
          { key: "password", kind: "secret", label: "App password" },
        ],
        implementation: { kind: "builtin", module: "caldav" },
      },
      { name: "apple-mail", provides: "mail", capabilities: ["read"], implementation: { kind: "bridge", bridge: "apple-mail" } },
      { name: "imap", provides: "mail", capabilities: ["read", "draft"], fields: [{ key: "password", kind: "secret", label: "App password" }], implementation: { kind: "builtin", module: "imap" } },
      { name: "linear", provides: "tracker", capabilities: ["read", "create", "complete"], fields: [{ key: "api_key", kind: "secret", label: "Personal API key" }], implementation: { kind: "builtin", module: "linear" } },
      // a known MCP service is data only: the native MCP client runs it
      { name: "github", provides: "mcp", transports: ["http"], fields: [{ key: "token", kind: "secret", label: "Token" }] },
    ];
    for (const row of rows) {
      const r = validateManifest({ schema: 1, type: "connection-type", transports: ["http"], ...row });
      expect(r.ok, `${row.name as string}: ${r.ok ? "" : r.errors.join("; ")}`).toBe(true);
    }
  });

  it("**refuses an unknown capability**, naming the type's vocabulary", () => {
    const e = errorsOf({ ...googleCalendar(), capabilities: ["read", "delete_all"] });
    expect(e).toMatch(/capabilities\.1: unknown calendar capability "delete_all" — one of read, write_own, rsvp/);
    // and a capability of another type is not borrowed
    expect(errorsOf({ ...googleCalendar(), capabilities: ["draft"] })).toMatch(/unknown calendar capability "draft"/);
  });

  it("**refuses an unknown field kind**, naming the vocabulary", () => {
    const m = googleCalendar();
    (m.fields as unknown[]).push({ key: "pin", kind: "password", label: "PIN" });
    expect(errorsOf(m)).toMatch(new RegExp(`fields\\.2\\.kind: unknown field kind "password" — one of ${FIELD_KINDS.join(", ")}`));
  });

  it("refuses send on mail by name — nothing sends mail", () => {
    const imap = { schema: 1, name: "imap", type: "connection-type", provides: "mail", transports: ["http"], capabilities: ["read", "send"], implementation: { kind: "builtin", module: "imap" } };
    expect(errorsOf(imap)).toMatch(/mail: send is refused — nothing sends mail/);
    expect(capabilityIssue("mail", "send")).toMatch(/nothing sends mail/);
  });

  it("gives mcp, agent, api, feed and files no capabilities", () => {
    for (const t of ["mcp", "agent", "api", "feed", "files"] as const) {
      expect(CONNECTION_CAPABILITIES[t]).toEqual([]);
      expect(capabilityIssue(t, "read")).toMatch(/have no capabilities/);
    }
    expect(errorsOf({ schema: 1, name: "github", type: "connection-type", provides: "mcp", transports: ["http"], capabilities: ["read"] })).toMatch(
      /mcp connections have no capabilities/,
    );
  });

  it("keeps type as the kind marker: agent is a manifest type, so a connection type provides agent", () => {
    const devin = { schema: 1, name: "devin", type: "connection-type", provides: "agent", transports: ["http"] };
    expect(asType(devin).provides).toBe("agent");
    // `type: agent` is the crew manifest, never a connection type
    const r = validateManifest({ ...devin, type: "agent" });
    expect(r.ok).toBe(false);
  });

  it("refuses a missing or unknown schema version, naming it", () => {
    const { schema: _s, ...unversioned } = googleCalendar();
    expect(errorsOf(unversioned)).toMatch(/schema/);
    expect(errorsOf({ ...googleCalendar(), schema: 2 })).toMatch(/schema: 2 is not a version this Metistry reads \(it reads schema 1\)/);
  });

  it("refuses an unknown key rather than ignoring it", () => {
    expect(errorsOf({ ...googleCalendar(), capabilties: ["read"] })).toMatch(/capabilties/);
  });

  it("reserves the name custom", () => {
    expect(errorsOf({ ...googleCalendar(), name: "custom" })).toMatch(/"custom" is reserved/);
  });

  it("refuses a native calendar, mail or tracker — they have no native handler", () => {
    expect(errorsOf({ ...googleCalendar(), implementation: { kind: "native" } })).toMatch(/calendar has no native handler/);
    const { implementation: _i, ...defaulted } = googleCalendar();
    expect(errorsOf(defaulted)).toMatch(/calendar has no native handler/); // native is the default
  });

  it("refuses a transport the native handler does not speak", () => {
    const api = { schema: 1, name: "aws-costs", type: "connection-type", provides: "api", transports: ["command"] };
    expect(errorsOf(api)).toMatch(/the native api handler does not speak command/);
    expect(errorsOf({ ...api, transports: ["http", "http"] })).toMatch(/listed once/);
  });

  it("refuses a default on a secret field — a value in a manifest is a published secret", () => {
    const m = googleCalendar();
    (m.fields as unknown[]).push({ key: "key", kind: "secret", label: "Key", default: "sk-live-123" });
    expect(errorsOf(m)).toMatch(/a secret field never has a default/);
  });

  it("refuses a duplicate field key and a choice default outside its options", () => {
    const dup = googleCalendar();
    (dup.fields as unknown[]).push({ key: "calendar_id", kind: "text", label: "Again" });
    expect(errorsOf(dup)).toMatch(/field key "calendar_id" is declared twice/);
    const choice = googleCalendar();
    (choice.fields as unknown[]).push({ key: "view", kind: "choice", label: "View", options: [{ value: "day", label: "Day" }], default: "week" });
    expect(errorsOf(choice)).toMatch(/default "week" is not one of the options/);
  });

  it("refuses an unknown tool group", () => {
    expect(errorsOf({ ...googleCalendar(), tools: { list_events: { group: "writes" } } })).toMatch(/tools\.list_events\.group/);
  });
});

describe("the OAuth client model (§2.6)", () => {
  it("**refuses a client_secret in a manifest**, by name", () => {
    expect(errorsOf(withOauth({ client_secret: "GOCSPX-abc" }))).toMatch(/client_secret never appears in a manifest/);
  });

  it("**refuses a loopback redirect without PKCE**", () => {
    expect(errorsOf(withOauth({ pkce: false }))).toMatch(/oauth\.pkce: a loopback redirect is a public client — pkce must be true/);
  });

  it("models the broker redirect, where the provider may not support PKCE", () => {
    expect(validateManifest(withOauth({ redirect: "broker", pkce: false })).ok).toBe(true);
    expect(errorsOf(withOauth({ redirect: "hosted" }))).toMatch(/oauth\.redirect/);
  });

  it("accepts only bring_your_own: allowed, and defaults to it", () => {
    expect(errorsOf(withOauth({ bring_your_own: "forbidden" }))).toMatch(/the only value is allowed/);
    const m = asType(withOauth({}, ["bring_your_own"]));
    expect(m.fields[0]?.kind === "oauth" && m.fields[0].oauth.bring_your_own).toBe("allowed");
  });

  it("accepts a type that ships no client id — the owner brings their own", () => {
    expect(validateManifest(withOauth({}, ["client_id"])).ok).toBe(true);
  });

  it("refuses an OAuth endpoint that is not https, or carries credentials", () => {
    expect(errorsOf(withOauth({ token_url: "http://oauth2.googleapis.com/token" }))).toMatch(/https only/);
    expect(errorsOf(withOauth({ authorize_url: "https://user:pw@accounts.google.com/auth" }))).toMatch(/never carries credentials/);
  });

  it("requires the scopes, so a reviewer can read them", () => {
    expect(errorsOf(withOauth({ scopes: [] }))).toMatch(/declare the scopes/);
    expect(errorsOf(withOauth({}, ["scopes"]))).toMatch(/scopes/);
  });
});

// The connection file of §2.6, as the plan writes it.
const WORK_CALENDAR = `
name: work-calendar
type: calendar
provider: google-calendar
reach: { http: { url: "https://www.googleapis.com/calendar/v3", auth: oauth } }
secrets: [google_calendar_token]
variables: []
config:
  account: { token: "{{ secret.google_calendar_token }}" }
tools:
  list_events:        { group: reads,   mode: on }
  respond_invitation: { group: changes, mode: ask }
offer_to_agents: false
`;

const workCalendar = () => parseYaml(WORK_CALENDAR) as Record<string, unknown>;

function conn(input: unknown): ConnectionFile {
  const r = validateConnectionFile(input);
  if (!r.ok) throw new Error(r.errors.join("\n"));
  return r.connection;
}

function fileErrors(input: unknown): string {
  const r = validateConnectionFile(input);
  if (r.ok) throw new Error("expected the connection file to be refused");
  return r.errors.join("\n");
}

const devin = (patch: Record<string, unknown> = {}) => ({
  name: "devin",
  type: "mcp",
  provider: "custom",
  reach: { http: { url: "https://mcp.devin.ai/mcp", auth: { scheme: "bearer", secret: "devin_api_key" } } },
  secrets: ["devin_api_key"],
  ...patch,
});

describe("connection files (§2.6)", () => {
  it("accepts the plan's example; auth: oauth is shorthand; a tool's mode defaults to Ask", () => {
    const c = conn(workCalendar());
    expect(c.reach.http?.auth).toEqual({ scheme: "oauth" });
    expect(c.tools.list_events).toEqual({ group: "reads", mode: "on" });
    const unset = conn({ ...workCalendar(), tools: { list_events: { group: "reads" } } });
    expect(unset.tools.list_events?.mode).toBe("ask");
    expect(conn(devin({ reach: { http: { url: "https://mcp.devin.ai/mcp" } }, secrets: [] })).reach.http?.auth).toEqual({ scheme: "none" });
  });

  it("refuses a secret used in a value but not listed in secrets", () => {
    const e = fileErrors(devin({ reach: { http: { url: "https://mcp.devin.ai/mcp", headers: { "X-Org": "{{ secret.devin_org_key }}" } } } }));
    expect(e).toMatch(/reach\.http\.headers\.X-Org: secret "devin_org_key" is used but not listed in secrets/);
    expect(fileErrors(devin({ secrets: [] }))).toMatch(/reach\.http\.auth\.secret: secret "devin_api_key" is used but not listed/);
  });

  it("refuses a template that is not a secret or a variable", () => {
    const e = fileErrors(devin({ reach: { command: { command: "npx", args: ["{{ env.HOME }}"] } } }));
    expect(e).toMatch(/\{\{ env\.HOME \}\} is not a reference a connection takes/);
    expect(templateRefs("Bearer {{ secret.a }} {{variable.b}} {{ date }}")).toEqual({ secrets: ["a"], variables: ["b"], invalid: ["{{ date }}"] });
  });

  it("refuses a reach that is not exactly one of http, command, path", () => {
    expect(fileErrors(devin({ reach: {} }))).toMatch(/exactly one of http, command, path — got none/);
    expect(fileErrors(devin({ reach: { http: { url: "https://x.test" }, path: { path: "/tmp" } } }))).toMatch(/got http, path/);
    expect(fileErrors(devin({ reach: { http: { url: "file:///etc/passwd" } } }))).toMatch(/http\(s\) URL/);
  });

  it("refuses an auth scheme outside the five, and a scheme missing its secret", () => {
    expect(fileErrors(devin({ reach: { http: { url: "https://x.test", auth: "digest" } } }))).toMatch(/unknown auth scheme — one of none, bearer, basic, api_key, oauth/);
    expect(fileErrors(devin({ reach: { http: { url: "https://x.test", auth: "bearer" } } }))).toMatch(/auth\.secret/);
  });

  it("refuses a custom calendar, mail or tracker, and a custom reach the type's handler cannot use", () => {
    expect(fileErrors({ ...devin(), type: "calendar" })).toMatch(/a calendar connection needs a connection type/);
    expect(fileErrors({ ...devin(), reach: { path: { path: "/srv/x" } } })).toMatch(/a custom mcp connection is reached by http or command/);
    expect(conn({ ...devin(), reach: { command: { command: "npx", args: ["-y", "@example/mcp"] } }, secrets: [] }).provider).toBe("custom");
    expect(fileErrors({ ...devin(), config: { token: "x" } })).toMatch(/a custom connection has no config fields/);
  });

  it("refuses an unknown connection type or tool mode", () => {
    expect(fileErrors({ ...devin(), type: "chat" })).toMatch(/type/);
    expect(fileErrors({ ...devin(), tools: { run: { group: "reads", mode: "always" } } })).toMatch(/tools\.run\.mode/);
  });
});

describe("a connection joined to its connection type", () => {
  const type = () => asType(googleCalendar());

  it("is consistent for the plan's example", () => {
    expect(connectionIssues(conn(workCalendar()), type())).toEqual([]);
  });

  it("**refuses relabelling a changes tool as reads** — the group is the type's", () => {
    const c = conn({ ...workCalendar(), tools: { respond_invitation: { group: "reads", mode: "on" } } });
    expect(connectionIssues(c, type())).toEqual(["tools.respond_invitation: google-calendar declares it changes — a connection cannot relabel it reads"]);
  });

  it("refuses a tool the type does not have, except on an MCP server (tools are discovered)", () => {
    const c = conn({ ...workCalendar(), tools: { delete_calendar: { group: "changes" } } });
    expect(connectionIssues(c, type())).toEqual(['tools.delete_calendar: google-calendar has no tool "delete_calendar"']);
  });

  it("**basic sign-in only where the connection type declares it** (T4-13): refused on any other type and on a custom connection; accepted by CalDAV", () => {
    const shape = { schema: 1, type: "connection-type", transports: ["http"], implementation: { kind: "builtin" } };
    const caldav = asType({ ...shape, name: "caldav", provides: "calendar", capabilities: ["read", "rsvp"], auth: ["basic"], implementation: { kind: "builtin", module: "caldav" } });
    const linear = asType({ ...shape, name: "linear", provides: "tracker", capabilities: ["read"], implementation: { kind: "builtin", module: "linear" } });
    const basic = { scheme: "basic", username: "me@example.com", secret: "app_password" };
    const file = (provider: string, type: string, auth: unknown) => conn({ name: "x", type, provider, reach: { http: { url: "https://dav.example.com/", auth } }, secrets: ["app_password"] });
    expect(connectionIssues(file("caldav", "calendar", basic), caldav)).toEqual([]);
    expect(connectionIssues(file("linear", "tracker", basic), linear)).toEqual(["reach.http.auth: linear does not accept basic sign-in — only a connection type that declares it (auth: [basic]) does"]);
    expect(connectionIssues(file("custom", "mcp", basic), undefined)).toEqual([
      "reach.http.auth: basic sign-in is accepted only by a connection type that declares it (auth: [basic] — CalDAV's), not by a custom connection",
    ]);
    // a type that lists its schemes is held to exactly those
    expect(connectionIssues(file("caldav", "calendar", { scheme: "bearer", secret: "app_password" }), caldav)).toEqual(["reach.http.auth: caldav signs in with basic, not bearer"]);
    // and a type that lists none still takes every other scheme
    expect(connectionIssues(file("linear", "tracker", { scheme: "api_key", header: "Authorization", secret: "app_password" }), linear)).toEqual([]);
  });

  it("refuses text in a secret field — its value is a reference, never the secret", () => {
    const caldav = asType({
      schema: 1,
      name: "caldav",
      type: "connection-type",
      provides: "calendar",
      transports: ["http"],
      capabilities: ["read"],
      fields: [{ key: "password", kind: "secret", label: "App password" }],
      implementation: { kind: "builtin", module: "caldav" },
    });
    const base = { name: "icloud", type: "calendar", provider: "caldav", reach: { http: { url: "https://caldav.icloud.com" } } };
    expect(connectionIssues(conn({ ...base, config: { password: "abcd-efgh-ijkl-mnop" } }), caldav)).toEqual([
      "config.password: a secret field's value is a {{ secret.name }} reference, never text",
    ]);
    expect(connectionIssues(conn({ ...base, secrets: ["icloud_app_password"], config: { password: "{{ secret.icloud_app_password }}" } }), caldav)).toEqual([]);
    expect(connectionIssues(conn(base), caldav)).toEqual(["config.password: required by caldav"]);
  });

  it("names a missing provider — the connection is absent, nothing is deleted", () => {
    expect(connectionIssues(conn(workCalendar()), undefined)).toEqual(['provider "google-calendar" is not installed — the connection is absent until it is']);
  });

  it("refuses a connection whose type or reach the provider does not provide", () => {
    const c = conn({ ...workCalendar(), type: "mail" });
    expect(connectionIssues(c, type())).toContain("provider \"google-calendar\" provides calendar, not mail");
    const byCommand = conn({ ...workCalendar(), reach: { command: { command: "gcal" } } });
    expect(connectionIssues(byCommand, type())).toContain("reach: google-calendar is reached by http, not command");
  });

  it("holds an oauth field's token and bring-your-own client as secret references", () => {
    const byo = conn({
      ...workCalendar(),
      secrets: ["google_calendar_token", "my_client_id", "my_client_secret"],
      config: { account: { token: "{{ secret.google_calendar_token }}", client_id: "{{ secret.my_client_id }}", client_secret: "{{ secret.my_client_secret }}" } },
    });
    expect(connectionIssues(byo, type())).toEqual([]);
    const literal = conn({ ...workCalendar(), config: { account: { token: "ya29.literal-token" } } });
    expect(connectionIssues(literal, type())).toEqual(["config.account.token: must be a {{ secret.name }} reference"]);
    expect(fileErrors({ ...workCalendar(), config: { account: { token: "{{ secret.unlisted }}" } } })).toMatch(/secret "unlisted" is used but not listed/);
  });

  it("refuses config for a field the type does not have", () => {
    const c = conn({ ...workCalendar(), config: { ...(workCalendar().config as object), colour: "blue" } });
    expect(connectionIssues(c, type())).toEqual(['config.colour: google-calendar has no field "colour"']);
  });
});
