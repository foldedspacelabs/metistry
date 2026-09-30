// T7-6 — Settings in the PWA (design-build-plan §2.3, §2.17; screen 18 §5):
// §2.3's table as a grouped list, budgets and devices writable, and **every
// `local` route's control absent** — a Mac-only row is its reason, never a
// button. That the route also refuses if called anyway is
// pwa-settings.integration.test.ts (a real passkey session against the gate),
// beside reach-gate.integration.test.ts (F-13's own misuse tests).
//
// Built first against the recorded fixtures (U9), mounted in the fake DOM the
// other views use (pwa-fake-dom.ts).
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CLIENT_API, isLocalRoute, routeKey, servedRoute } from "@foldedspacelabs/metistry-core";
import {
  MAC_ONLY_ROUTES,
  OFFLINE_SETTING,
  SETTINGS_GROUPS,
  devicesRowsHtml,
  limitSummary,
  macRowHtml,
  mountSettings,
  secretsRowsHtml,
} from "../web/settings.js";
import { viewsFor } from "../web/live.js";
import { type Call, FakeEl, control, fakeBrowser } from "./pwa-fake-dom.js";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const fixture = (name: string) => (JSON.parse(read(`../../macos/tests/kit/fixtures/${name}.json`)) as { body: Record<string, unknown> }).body;
const WEB = fileURLToPath(new URL("../web/", import.meta.url));
const HTML = read("../web/index.html").replace(/<!--[\s\S]*?-->/g, "");
const SETTINGS_SRC = read("../web/settings.js");

/** The recorded reads, by path; a passkey session's whoami, this device being session 2. */
const RECORDED: Record<string, Record<string, unknown>> = {
  "/api/identity": fixture("get-api-identity"),
  "/api/whoami": { ...fixture("get-api-whoami"), via: "passkey_session", session_id: 2 },
  "/api/status": fixture("get-api-status"),
  "/api/compute": fixture("get-api-compute"),
  "/api/projects": fixture("get-api-projects"),
  "/api/devices": fixture("get-api-devices"),
  "/api/connections": fixture("get-api-connections"),
  "/api/secrets": fixture("get-api-secrets"),
  "/api/vault/status": fixture("get-api-vault-status"),
};

/** A browser answering every read from the recordings and every write with `write`. */
function mounted({ offline = false, write = () => ({ body: { ok: true } }), reads = {} }: { offline?: boolean; write?: (c: Call) => { status?: number; body: unknown }; reads?: Record<string, { status?: number; body: unknown }> } = {}) {
  const b = fakeBrowser({
    respond: (c) => (c.method === "GET" ? (reads[c.path] ?? { body: RECORDED[c.path] ?? {} }) : write(c)),
  });
  const shown: unknown[] = [];
  const notify = { settings: vi.fn(async () => {}) };
  const view = mountSettings({ $: b.$, api: b.api, show: (v: string) => { shown.push(v); }, notify, offline: () => offline });
  const page = () => b.$("settings-head").innerHTML + b.$("settings-rest").innerHTML;
  const click = (data: Record<string, string>) => b.$("settings").fire("click", { target: control(data) });
  /** A form's submit, as the delegated listener sees it: the form found by `closest`. */
  const submit = (data: Record<string, string>) => {
    const form = Object.assign(new FakeEl(), { dataset: data });
    const target = Object.assign(new FakeEl(), { closest: (sel: string) => (sel === "form[data-form]" ? form : null) });
    return b.$("settings").fire("submit", { target, preventDefault() {} });
  };
  return { b, view, shown, notify, page, click, submit };
}

afterEach(() => vi.unstubAllGlobals());

// ---------------------------------------------------------------------------

describe("§2.3's table as a grouped list", () => {
  it("the Mac's panes in its order, with Agents, Scheduled and Vault where they read — Notifications between, this device's", () => {
    expect(SETTINGS_GROUPS.map((g) => g.title)).toEqual([
      "Instance", "Services", "Compute", "Updates", "Account",
      "Agents", "Scheduled", "Connections", "Secrets", "Variables", "Sessions", "Vault", "This Mac",
    ]);
    const section = /<section id="settings" hidden>[\s\S]*?<\/section>/.exec(HTML)?.[0] ?? "";
    expect(section.indexOf('id="settings-head"')).toBeLessThan(section.indexOf("<h3>Notifications</h3>"));
    expect(section.indexOf("<h3>Notifications</h3>")).toBeLessThan(section.indexOf('id="settings-rest"'));
    for (const id of ["push-status", "push-enable", "push-test"]) expect(section, id).toContain(`id="${id}"`);
  });

  it("mounted against the recordings: every group paints, the assistant's name is templated, nothing is left reading", async () => {
    const m = mounted();
    await m.view.settings();
    const page = m.page();
    for (const g of SETTINGS_GROUPS) expect(page, g.title).toContain(`<h3>${g.title}</h3>`);
    expect(page).not.toContain("Reading ");
    expect(page).toContain("Aide's Model");
    expect(page).toContain("gemma");
    expect(page).toContain("Metistry 0.11.0");
    expect(page).toContain("all 2 healthy");
    expect(page).toContain("github_write");
    expect(page).toContain("sent only to api.github.com");
    expect(page).toContain("2 ahead · 0 behind");
    expect(page).toContain("The last push failed");
    expect(m.notify.settings).toHaveBeenCalled();
    expect(SETTINGS_SRC).not.toMatch(/\bMetis\b/);
  });

  it("a read that fails is said in its group in the server's words; the others still paint, and so do the Mac-only rows", async () => {
    const m = mounted({ reads: { "/api/compute": { status: 503, body: { error: { code: "not_available", message: "compute is not reachable from this console" } } } } });
    await m.view.settings();
    const compute = /<ul class="group settings-group" id="set-compute"[\s\S]*?<\/ul>/.exec(m.page())?.[0] ?? "";
    expect(compute).toContain("Couldn't read compute");
    expect(compute).toContain("compute is not reachable from this console");
    expect(compute).toContain("On the Mac — where prompts and keys go");
    expect(compute).toContain("Metistry"); // the project's daily budget reads /api/projects, not compute
    expect(m.page()).toContain("This Device");
  });

  it("a secret's row is its name, hosts and last use — a value in the body is never painted", () => {
    const html = secretsRowsHtml([{ name: "k", hosts: ["h.example"], present: true, last_used: null, value: "sk-live-DO-NOT-SHOW" }]);
    expect(html).not.toContain("sk-live");
    expect(html).toContain("sent only to h.example");
  });

  it("server text is output-encoded", () => {
    const html = devicesRowsHtml([{ id: "1", label: "<img src=x onerror=alert(1)>", last_seen_at: null, revoked: false }], null);
    expect(html).not.toContain("<img");
  });
});

// ---------------------------------------------------------------------------

/** Every request a PWA module makes to a literal path, with its method (GET unless the call says otherwise). */
function requestsIn(src: string): { method: string; path: string }[] {
  const out: { method: string; path: string }[] = [];
  for (const m of src.matchAll(/\b(?:api|net|fetch)\(\s*([`"'])(\/[^`"'\s]*)\1([^\n]*)/g)) {
    const method = /method: "([A-Z]+)"/.exec(m[3]!)?.[1] ?? "GET";
    out.push({ method, path: m[2]!.replaceAll(/\$\{[^}]*\}/g, "x").split("?")[0]! });
  }
  return out;
}

describe("**every `local` route's control is absent, and the route refuses if called anyway**", () => {
  const LOCAL = CLIENT_API.filter((r) => r.served && isLocalRoute(r)).map(routeKey);

  it("every served `local` route in the client API is one Mac-only row's, and no row names a route that is not `local`", () => {
    expect([...MAC_ONLY_ROUTES].sort()).toEqual([...LOCAL].sort());
    expect(new Set(MAC_ONLY_ROUTES).size).toBe(MAC_ONLY_ROUTES.length);
  });

  it("a Mac-only row is its reason and nothing to press — no button, form, field or link, not even a disabled one", () => {
    const rows = SETTINGS_GROUPS.flatMap((g) => g.rows.filter((r) => "mac" in r));
    expect(rows.length).toBeGreaterThanOrEqual(12);
    for (const r of rows) {
      const html = macRowHtml(r);
      expect(html, r.mac).toMatch(/^<li class="mac-only"><span class="k">[^<]+<\/span><span class="sub">On the Mac — [^<]+\.<\/span><\/li>$/);
      expect(html, r.mac).not.toMatch(/<button|<form|<input|<select|<a\b|href=|data-act|tabindex/);
    }
  });

  it("mounted: each Mac-only row is on the page as its reason, and pressing every control Settings draws never calls a `local` route", async () => {
    const m = mounted();
    await m.view.settings();
    for (const r of SETTINGS_GROUPS.flatMap((g) => g.rows.filter((x) => "mac" in x))) expect(m.page()).toContain(macRowHtml(r));
    // press everything there is, then everything that appears after (a confirmation, a form)
    const pressed = new Set<string>();
    for (let round = 0; round < 4; round++) {
      for (const tag of m.page().matchAll(/<button[^>]*data-act="([^"]+)"([^>]*)>/g)) {
        const data: Record<string, string> = { act: tag[1]! };
        for (const a of tag[2]!.matchAll(/data-([a-z]+)="([^"]*)"/g)) if (a[1] !== "needs") data[a[1]!] = a[2]!.replaceAll("&quot;", '"').replaceAll("&amp;", "&");
        const key = JSON.stringify(data);
        if (pressed.has(key) || data.act === "cancel") continue;
        pressed.add(key);
        await m.click(data);
      }
    }
    expect([...pressed].length).toBeGreaterThan(5);
    const reached = m.b.calls.map((c) => servedRoute(c.method, c.path)).filter((r) => r !== undefined);
    expect(reached.filter(isLocalRoute).map(routeKey)).toEqual([]);
    expect(m.b.writes().length).toBeGreaterThan(0); // it did press the doors it has
  });

  it("no module of the PWA calls a `local` route — read off every request in its source", () => {
    const modules = readdirSync(WEB).filter((f) => f.endsWith(".js"));
    expect(modules).toContain("settings.js");
    const requests = modules.flatMap((f) => requestsIn(read(`../web/${f}`)).map((r) => ({ ...r, file: f })));
    expect(requests.length).toBeGreaterThan(40); // not vacuous: the scan sees the PWA's requests…
    expect(requests).toContainEqual({ method: "POST", path: "/api/compute/budget", file: "settings.js" }); // …Settings' writes among them
    expect(requests).toContainEqual({ method: "PUT", path: "/api/projects/x", file: "settings.js" });
    const local = requests.filter((r) => {
      const row = servedRoute(r.method, r.path);
      return row !== undefined && isLocalRoute(row);
    });
    expect(local).toEqual([]);
  });

  it("the legacy doors are gone: no register, rotate, purge, restore or rollback anywhere in the page or its modules", () => {
    // what the code RUNS: comments aside, and settings.js's table, whose `local` lists name the routes it never offers
    const all = readdirSync(WEB).filter((f) => f.endsWith(".js")).map((f) => read(`../web/${f}`).replace(/^\s*\/\/.*$/gm, "").replace(/local: \[[^\]]*\]/g, "")).join("\n") + HTML;
    expect(all).not.toMatch(/\/rotate[`"']|\/api\/sessions\/purge|\/api\/knowledge\/restore|\/api\/vault\/rollback|\/assignment[`"']/);
  });
});

// ---------------------------------------------------------------------------

describe("budgets are writable — through POST /api/compute/budget and PUT /api/projects/:slug", () => {
  it("the instance's limit: Change opens its form in place; Save is the budget door with the fields given, and says so", async () => {
    const m = mounted({ write: () => ({ body: { ok: true, target: "budgets.instance", daily_usd: 5, monthly_usd: 60, action: "stop" } }) });
    await m.view.settings();
    expect(m.page()).toContain("No limit");
    await m.click({ act: "edit-limit", scope: "instance" });
    expect(m.page()).toContain('data-form="limit" data-scope="instance"');
    expect(m.page()).toContain('<option value="critical_only">Critical Only — Only turns marked critical may spend past the limit.</option>');
    expect(m.b.writes()).toEqual([]);
    m.b.$("lim-instance-daily").value = "5";
    m.b.$("lim-instance-monthly").value = "60";
    m.b.$("lim-instance-action").value = "stop";
    await m.submit({ form: "limit", scope: "instance" });
    expect(m.b.writes()).toEqual([{ path: "/api/compute/budget", method: "POST", headers: {}, body: { scope: "instance", action: "stop", daily: 5, monthly: 60 } }]);
    expect(m.b.$("settings-head").innerHTML).toContain("Saved. The engine holds every turn to it, before the call.");
    expect(m.page()).not.toContain('data-form="limit"');
  });

  it("a provider's limit is the same door with its scope; a blank field keeps what is set", async () => {
    const m = mounted();
    await m.view.settings();
    await m.click({ act: "edit-limit", scope: "provider:openrouter" });
    m.b.$("lim-provider-openrouter-daily").value = "";
    m.b.$("lim-provider-openrouter-monthly").value = "20";
    m.b.$("lim-provider-openrouter-action").value = "critical_only";
    await m.submit({ form: "limit", scope: "provider:openrouter" });
    expect(m.b.writes().map((c) => c.body)).toEqual([{ scope: "provider:openrouter", action: "critical_only", monthly: 20 }]);
  });

  it("nothing is sent that could only fail: no limit given where none is set, or a number that is not dollars", async () => {
    const m = mounted();
    await m.view.settings();
    await m.click({ act: "edit-limit", scope: "instance" });
    m.b.$("lim-instance-daily").value = "";
    m.b.$("lim-instance-monthly").value = "";
    await m.submit({ form: "limit", scope: "instance" });
    expect(m.page()).toContain("Not saved — give a daily or a monthly limit");
    m.b.$("lim-instance-daily").value = "-3";
    await m.submit({ form: "limit", scope: "instance" });
    expect(m.page()).toContain("Not saved — a limit is a number of dollars, 0 or more.");
    expect(m.b.writes()).toEqual([]);
  });

  it("a refusal is said in the server's own words", async () => {
    const m = mounted({ write: () => ({ status: 400, body: { error: { code: "invalid_request", message: "compute.yaml does not validate: budgets.instance.daily_usd" } } }) });
    await m.view.settings();
    await m.click({ act: "edit-limit", scope: "instance" });
    m.b.$("lim-instance-daily").value = "5";
    await m.submit({ form: "limit", scope: "instance" });
    expect(m.page()).toContain("compute.yaml does not validate: budgets.instance.daily_usd");
  });

  it("a project's daily budget: Change, Save — the project door with that one field; blank is no budget", async () => {
    const m = mounted();
    await m.view.settings();
    expect(m.page()).toContain("No daily budget");
    await m.click({ act: "edit-project", slug: "metistry" });
    m.b.$("proj-metistry-daily").value = "5";
    await m.submit({ form: "project", slug: "metistry" });
    await m.click({ act: "edit-project", slug: "metistry" });
    m.b.$("proj-metistry-daily").value = "";
    await m.submit({ form: "project", slug: "metistry" });
    expect(m.b.writes().map((c) => [c.method, c.path, c.body])).toEqual([
      ["PUT", "/api/projects/metistry", { daily_budget_usd: 5 }],
      ["PUT", "/api/projects/metistry", { daily_budget_usd: null }],
    ]);
  });

  it("a limit in one line, in the Mac's words", () => {
    expect(limitSummary({ daily_usd: 5, monthly_usd: 60, action: "stop" })).toBe("$5/day · $60/month · Stop");
    expect(limitSummary({ daily_usd: null, monthly_usd: 12.5, action: "critical_only" })).toBe("$12.50/month · Critical Only");
    expect(limitSummary({ daily_usd: null, monthly_usd: null, action: null })).toBe("No limit");
  });
});

// ---------------------------------------------------------------------------

describe("devices are writable — POST /api/devices/:id/revoke, confirmed in the page", () => {
  it("this device says so; Revoke asks in the page, naming the device and the cost, and only the act's own verb sends", async () => {
    const m = mounted({ write: () => ({ body: { revoked: true } }) });
    await m.view.settings();
    expect(m.page()).toMatch(/iPhone <span class="chip">This Device<\/span>/);
    await m.click({ act: "ask-revoke", id: "1" });
    expect(m.b.writes()).toEqual([]);
    expect(m.page()).toContain("Revoke iPhone? It is signed out now, and signing in again takes its passkey.");
    expect(m.page()).toContain('data-act="revoke" data-needs-connection>Revoke</button><button type="button" class="secondary" data-act="cancel" id="settings-confirm-cancel">Cancel</button>');
    await m.click({ act: "cancel" });
    expect(m.page()).not.toContain('data-act="revoke"');
    await m.click({ act: "revoke" }); // nothing is being confirmed: nothing is sent
    expect(m.b.writes()).toEqual([]);
    await m.click({ act: "ask-revoke", id: "1" });
    await m.click({ act: "revoke" });
    expect(m.b.writes().map((c) => [c.method, c.path])).toEqual([["POST", "/api/devices/1/revoke"]]);
    expect(m.page()).toContain("iPhone is signed out.");
  });

  it("revoking this device says what it costs here", async () => {
    const m = mounted();
    await m.view.settings();
    await m.click({ act: "ask-revoke", id: "2" });
    expect(m.page()).toContain("This is the device you are using — you are signed out here now");
  });

  it("Sign Out Everywhere lists every live device, then revokes each — this one last", async () => {
    const m = mounted({ write: () => ({ body: { revoked: true } }) });
    await m.view.settings();
    await m.click({ act: "ask-everywhere" });
    expect(m.page()).toContain("Sign out all 2 devices — iPhone (this one), iPhone? Each needs its passkey to sign in again.");
    expect(m.b.writes()).toEqual([]);
    await m.click({ act: "everywhere" });
    expect(m.b.writes().map((c) => c.path)).toEqual(["/api/devices/1/revoke", "/api/devices/2/revoke"]);
    expect(m.page()).toContain("Signed out of all 2 devices.");
  });

  it("no browser dialog in Settings: the device revoke's confirm() is gone from app.js, and settings.js has none", () => {
    const dialog = /(^|[^\w.$])(?:window\.)?(confirm|prompt|alert)\(/m;
    expect(SETTINGS_SRC.replace(/^\s*\/\/.*$/gm, "")).not.toMatch(dialog);
    expect(read("../web/app.js")).not.toContain("revoke this device session?");
  });
});

// ---------------------------------------------------------------------------

describe("offline (T7-4): a setting is not offered, and never waits", () => {
  it("every write control is held by the shell while the console cannot be reached", async () => {
    const m = mounted();
    await m.view.settings();
    await m.click({ act: "edit-limit", scope: "instance" });
    await m.click({ act: "cancel" });
    await m.click({ act: "ask-revoke", id: "1" });
    const buttons = [...m.page().matchAll(/<button[^>]*data-act="(edit-limit|edit-project|ask-revoke|ask-everywhere|revoke|everywhere)"[^>]*>/g)];
    expect(buttons.length).toBeGreaterThan(3);
    for (const b of buttons) expect(b[0], b[1]).toContain("data-needs-connection");
  });

  it("a tap that lands anyway opens nothing and sends nothing, and says so", async () => {
    const m = mounted({ offline: true });
    await m.view.settings();
    for (const data of [{ act: "edit-limit", scope: "instance" }, { act: "edit-project", slug: "metistry" }, { act: "ask-revoke", id: "1" }, { act: "ask-everywhere" }]) await m.click(data);
    expect(m.page()).not.toMatch(/data-form=|class="confirm"/);
    await m.submit({ form: "limit", scope: "instance" });
    expect(m.b.writes()).toEqual([]);
    expect(m.page()).toContain(OFFLINE_SETTING);
  });
});

describe("live (T7-7): Settings refetches on what changes it, and never under an open form", () => {
  it("a budget's state, the vault's sync, a config change and a connection's health each reach Settings", () => {
    for (const type of ["budget.state", "vault.sync", "config.changed", "connection.health"]) expect(viewsFor(type, {}), type).toContain("settings");
  });

  it("a refetch leaves an open form where it is", async () => {
    const m = mounted();
    await m.view.settings();
    await m.click({ act: "edit-limit", scope: "instance" });
    const reads = m.b.calls.length;
    await m.view.refresh();
    expect(m.b.calls.length).toBe(reads);
    expect(m.page()).toContain('data-form="limit"');
    await m.click({ act: "cancel" });
    await m.view.refresh();
    expect(m.b.calls.length).toBeGreaterThan(reads);
  });
});
