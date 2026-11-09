// T7-5 — push and enrolment in the PWA (screen 18 §6, §7.4; design-build-plan
// §2.17). What the ticket names, held here:
//
// - **A notification carries type and title only, never a secret.** sw.js is
//   run as the browser runs it — its listeners, fed push events — and what it
//   hands `showNotification` is read back: three fields of the payload are
//   read and no others, and nothing key-shaped survives (core's own
//   `looksLikeKey` is the oracle, so the worker's copy of its shapes cannot
//   drift from it quietly).
// - **No alert()**: not one call in the PWA, and the wall, the ask and
//   Settings say every outcome on the page.
// - **Ask in context**: never on first launch — only once something waits in
//   Needs You, and the permission prompt only from the owner's tap.
// - **The install sheet**: three steps on iPhone; Chrome and Edge's own
//   prompt, offered once from More.
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { looksLikeKey } from "@foldedspacelabs/metistry-core";
import { ASK_KEY, INSTALL_KEY, PUSH_WORDS, askFor, deviceOf, installOffer, mountNotify, pushState } from "../web/notify.js";
import { mountNeedsYou, needsYouRoute } from "../web/needs-you.js";
import { withRequestShape } from "../src/server.js";
import { fakeBrowser, settle } from "./pwa-fake-dom.js";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const SW = read("../web/sw.js");
const APP = read("../web/app.js");
const HTML = read("../web/index.html").replace(/<!--[\s\S]*?-->/g, "");

afterEach(() => vi.unstubAllGlobals());

// ---------------------------------------------------------------------------
// The service worker, run
// ---------------------------------------------------------------------------

const ORIGIN = "https://console.example.test";

interface Shown { title: string; options: Record<string, unknown> }
interface Client { url: string; focus: ReturnType<typeof vi.fn>; postMessage: ReturnType<typeof vi.fn> }

/** Evaluate sw.js against a fake `self`, the way a browser installs it: its listeners, and what they call. */
function worker({ windows = [] as Client[] } = {}) {
  const listeners: Record<string, ((e: unknown) => void)[]> = {};
  const shown: Shown[] = [];
  const opened: string[] = [];
  const self = {
    location: new URL(ORIGIN + "/sw.js"),
    addEventListener: (type: string, fn: (e: unknown) => void) => { (listeners[type] ??= []).push(fn); },
    registration: { showNotification: async (title: string, options: Record<string, unknown>) => { shown.push({ title, options }); } },
    clients: {
      matchAll: async () => windows,
      openWindow: async (url: string) => { opened.push(url); return null; },
      claim: async () => {},
    },
    skipWaiting: () => {},
  };
  new Function("self", SW)(self);
  const fire = async (type: string, event: Record<string, unknown>) => {
    const waits: Promise<unknown>[] = [];
    for (const fn of listeners[type] ?? []) fn({ ...event, waitUntil: (p: Promise<unknown>) => waits.push(p) });
    await Promise.all(waits);
  };
  return {
    shown,
    opened,
    /** A push whose payload is `payload` (JSON), or whose body is not JSON at all. */
    push: (payload: unknown) => fire("push", { data: { json: () => (typeof payload === "string" ? JSON.parse(payload) : payload) } }),
    tap: (data: unknown) => fire("notificationclick", { notification: { data, close() {} } }),
  };
}

/** Every string a notification put on screen or in its data. */
const onScreen = (n: Shown) => JSON.stringify(n);

// Key shapes, one per pattern core refuses — each a value a card title could
// carry if an agent copied it there. Each is assembled here rather than
// written whole, so no secret scanner mistakes a fake for a leak.
const k = (...parts: string[]) => parts.join("");
const KEYS = [
  k("sk-", "ant-api03-", "AbCdEfGhIjKlMnOpQrStUvWx"),
  k("sk_", "live_", "4eC39HqLyjWDarjtT1zdp7dc"),
  k("ghp_", "16C7e42F292c6912E7710c838347Ae178B4a"),
  k("github_pat_", "11ABCDEFG0123456789_abcdefghijklmnop"),
  k("glpat-", "xxxxXXXXxxxxXXXXxxxx"),
  k("xoxb-", "1234567890-abcdefghij"),
  k("AKIA", "IOSFODNN7EXAMPLE"),
  k("AIza", "SyD-9tSrke72PouQMnMX-a7eZSW0jkFMBWY"),
  k("ya29.", "a0AfH6SMBx3c4d5e6f7g8h9i0j"),
  k("lin_api_", "abcdefghijklmnopqrstuv"),
  k("apk_", "abcdefghijklmnop1234"),
  k("hf_", "abcdefghijklmnopqrstuvwxyz"),
  k("npm_", "abcdefghijklmnopqrstuvwxyz0123456789"),
  k("eyJhbGciOiJIUzI1NiJ9", ".", "eyJzdWIiOiIxMjM0NTY3ODkwIn0", ".", "dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U"),
  k("Bearer ", "abcdef0123456789"),
  k("https://admin:", "hunter2secret", "@db.example.com/prod"),
  k("https://api.example.com/v1?access_token=", "abcdef123456"),
  "Q3f9ZkP2mX7tL1vR8wN4bY6cJ0hD5sGa", // no prefix: judged by its randomness
  "0123456789abcdef0123456789abcdef", // hex
];
const CODES = ["your code is 482913", "card 4111 1111 1111 1111"];

describe("a notification carries type and title only, never a secret", () => {
  it("reads type, title and url — a body, actions, an image or data in the payload never reach the notification", async () => {
    const w = worker();
    await w.push({
      type: "Decision",
      title: "Renew the studio lease",
      body: "the landlord's portal password is hunter2",
      actions: [{ action: "approve", title: "Approve" }],
      image: "https://tracker.example/pixel.png",
      requireInteraction: true,
      data: { url: "/", secret: "x" },
      url: "/#/needs-you",
    });
    expect(w.shown).toHaveLength(1);
    const [n] = w.shown;
    expect(n!.title).toBe("Decision");
    expect(n!.options.body).toBe("Renew the studio lease");
    expect(Object.keys(n!.options).sort()).toEqual(["body", "data", "icon"]);
    expect(n!.options.data).toEqual({ url: "/#/needs-you" });
    expect(onScreen(n!)).not.toMatch(/hunter2|Approve|pixel|secret/);
  });

  it.each(KEYS)("a key in a title or a type is blanked before it is shown: %s", async (key) => {
    const w = worker();
    await w.push({ type: `Report ${key}`, title: `Rotate ${key} before Friday` });
    const [n] = w.shown;
    expect(onScreen(n!)).not.toContain(key);
    expect(looksLikeKey(n!.title), n!.title).toBe(false);
    expect(looksLikeKey(String(n!.options.body)), String(n!.options.body)).toBe(false);
    expect(n!.options.body).toMatch(/^Rotate .*•••.* before Friday$/);
  });

  it.each(CODES)("a one-time code or a card number is blanked: %s", async (text) => {
    const w = worker();
    await w.push({ type: "Needs You", title: text });
    expect(w.shown[0]!.options.body).not.toMatch(/\d{4}/);
    expect(w.shown[0]!.options.body).toContain("•••");
  });

  it("an ordinary title passes as it was written", async () => {
    const w = worker();
    const titles = [
      "Approve the 2026 budget for the platform-team-roadmap-review",
      "Review PR #412 before 3:30 PM",
      "Calendar 3f2504e0-4f89-11d3-9a0c-0305e82c3301 wants a new name",
    ];
    for (const title of titles) await w.push({ type: "Review", title });
    expect(w.shown.map((n) => n.options.body)).toEqual(titles);
  });

  it("each is one line, clipped — and a key straddling the clip is still blanked", async () => {
    const w = worker();
    await w.push({ type: "Question\nwith a second line", title: `${"a ".repeat(54)}${KEYS[2]} and more` });
    const [n] = w.shown;
    expect(n!.title).toBe("Question with a second line");
    const body = String(n!.options.body);
    expect(Array.from(body).length).toBeLessThanOrEqual(120);
    expect(body).not.toMatch(/ghp_|16C7e42F/);
    await w.push({ type: "x".repeat(80), title: "t" });
    expect(Array.from(w.shown[1]!.title)).toHaveLength(40);
    expect(w.shown[1]!.title.endsWith("…")).toBe(true);
  });

  it("a payload from a console that predates `type` shows its title alone — never its body", async () => {
    const w = worker();
    await w.push({ title: "Reply", body: `Here is the API key you asked for: ${KEYS[0]}`, url: "/" });
    expect(w.shown[0]).toMatchObject({ title: "Reply", options: { body: "" } });
    expect(onScreen(w.shown[0]!)).not.toContain("sk-ant");
  });

  it("an unreadable payload still shows one notification, and says nothing but the product's name", async () => {
    const w = worker();
    await w.push("{not json");
    await w.push(null);
    await w.push({ type: 42, title: { nested: KEYS[0] } });
    expect(w.shown.map((n) => [n.title, n.options.body])).toEqual([["Metistry", ""], ["Metistry", ""], ["Metistry", ""]]);
  });

  it("a link anywhere but this origin opens the app instead", async () => {
    const w = worker();
    const off = ["https://evil.example/", "//evil.example/x", "/\\evil.example", "javascript:alert(1)", "data:text/html,x", "relative/path", 7];
    for (const url of off) await w.push({ type: "t", title: "t", url });
    expect(w.shown.map((n) => (n.options.data as { url: string }).url)).toEqual(off.map(() => "/"));
    await w.push({ type: "t", title: "t", url: "/#/rooms/work/12?x=1" });
    expect((w.shown.at(-1)!.options.data as { url: string }).url).toBe("/#/rooms/work/12?x=1");
  });
});

describe("tap opens that card", () => {
  it("in the window already open: focused, and told the page — no second window", async () => {
    const win: Client = { url: ORIGIN + "/", focus: vi.fn(async () => {}), postMessage: vi.fn() };
    const w = worker({ windows: [win] });
    await w.tap({ url: "/#/needs-you" });
    expect(win.focus).toHaveBeenCalledOnce();
    expect(win.postMessage).toHaveBeenCalledWith({ type: "metistry.open", url: "/#/needs-you" });
    expect(w.opened).toEqual([]);
  });

  it("with no window open, a new one at that page; a tampered link opens the app", async () => {
    const other: Client = { url: "https://elsewhere.example/", focus: vi.fn(), postMessage: vi.fn() };
    const w = worker({ windows: [other] });
    await w.tap({ url: "/#/needs-you" });
    await w.tap({ url: "https://evil.example/phish" });
    await w.tap(undefined);
    expect(w.opened).toEqual(["/#/needs-you", "/", "/"]);
    expect(other.focus).not.toHaveBeenCalled();
  });

  it("the page routes the message: Needs You with its card open, a card's room or artifact, else home", () => {
    expect(APP).toMatch(/e\.data\?\.type === "metistry\.open" && signedIn\) openLink\(e\.data\.url\)/);
    expect(APP).toMatch(/const request = needsYouRoute\(hash\);\n\s*if \(request\) \{ needsYou\.open\(request\.id\); return show\("triage"\); \}/);
    // a cold start from the tap opens the same card
    expect(APP).toMatch(/const request = needsYouRoute\(location\.hash\);\n\s*if \(request\) \{ needsYou\.open\(request\.id\);/);
  });

  it("a push's link names its card (X-32): #/needs-you/<id> is that card, #/needs-you the queue, anything else not Needs You", () => {
    expect(needsYouRoute("#/needs-you/42")).toEqual({ id: "42" });
    expect(needsYouRoute("#/needs-you")).toEqual({ id: null });
    for (const h of ["#/needs-you/", "#/needs-you/0", "#/needs-you/4x", "#/needs-you/1/../2", "#/needs-youx", "#/rooms/work/1", "", undefined]) {
      expect(needsYouRoute(h), String(h)).toBeNull();
    }
  });

  it("the card a link names is open when Needs You loads; one answered since the push leaves the queue showing", async () => {
    const row = (id: number) => withRequestShape({ id, ts: "2026-09-30T08:00:00.000Z", kind: "decision", source_agent: "a", trust: "internal", payload: { title: `ask ${id}`, options: ["Yes", "No"] }, decision: "pending" });
    const b = fakeBrowser({ respond: () => ({ body: { proposals: [row(5), row(6)] } }) });
    const view = mountNeedsYou({ $: b.$, api: b.api, setNeeds: () => {}, show: () => {} });
    view.open("6");
    await view.load();
    expect(b.$("triage").classList.contains("has-detail")).toBe(true);
    expect(b.$("triage-detail").hidden).toBe(false);
    expect(b.$("triage-detail").innerHTML).toContain("ask 6");
    expect(b.$("triage-detail").innerHTML).not.toContain("ask 5");
    await view.load(); // asked once: the next load keeps what the owner has open, and opens nothing new

    const later = fakeBrowser({ respond: () => ({ body: { proposals: [row(5)] } }) });
    const queue = mountNeedsYou({ $: later.$, api: later.api, setNeeds: () => {}, show: () => {} });
    queue.open("6"); // answered on the Mac since the push
    await queue.load();
    expect(later.$("triage").classList.contains("has-detail")).toBe(false);
    expect(later.$("triage-detail").hidden).toBe(true);
    expect(later.$("proposal-list").innerHTML).toContain("ask 5");
  });
});

// ---------------------------------------------------------------------------
// No alert()
// ---------------------------------------------------------------------------

describe("no alert(): every outcome is a line on the page", () => {
  const WEB = fileURLToPath(new URL("../web/", import.meta.url));
  const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");

  it("no file of the PWA calls alert", () => {
    for (const f of readdirSync(WEB).filter((n) => n.endsWith(".js"))) {
      expect(code(read(`../web/${f}`)), f).not.toMatch(/(^|[^.\w])alert\s*\(|window\.alert\b/);
    }
  });

  it("the wall asks for the device's name as a field, not a prompt, and says a refusal under its buttons", () => {
    const enrol = /\$\("enroll-btn"\)\.onclick[\s\S]*?\n\}\);/.exec(APP)?.[0] ?? "";
    const signIn = /\$\("login-btn"\)\.onclick[\s\S]*?\n\}\);/.exec(APP)?.[0] ?? "";
    expect(enrol).toContain('$("enroll-label").value');
    for (const step of [enrol, signIn]) {
      expect(step).not.toMatch(/prompt\(|confirm\(/);
      expect(step).toMatch(/authSay\(AUTH_WORDS\./);
    }
    expect(HTML).toMatch(/<label for="enroll-label">Device name<\/label>\s*<input id="enroll-label" type="text"/);
    expect(HTML).toContain('<p id="auth-error" class="auth-error" role="alert"></p>');
  });

  it("a cancelled passkey sheet, a lost connection and a spent link each say what happened", () => {
    const lift = (name: string) => {
      const m = new RegExp(`^(?:const ${name} = \\{[\\s\\S]*?^\\};|function ${name}\\([\\s\\S]*?^\\})`, "m").exec(APP);
      if (!m) throw new Error(`app.js no longer declares ${name}`);
      return m[0];
    };
    const { authFailure, AUTH_WORDS, deviceName } = new Function(`${lift("AUTH_WORDS")}\n${lift("authFailure")}\n${lift("deviceName")}\nreturn { authFailure, AUTH_WORDS, deviceName };`)() as {
      authFailure: (step: string, err: unknown) => string;
      AUTH_WORDS: Record<string, string>;
      deviceName: (ua: string) => string;
    };
    expect(authFailure("enroll", Object.assign(new Error("x"), { name: "NotAllowedError" }))).toBe(AUTH_WORDS.cancelled);
    expect(authFailure("signin", new TypeError("Failed to fetch"))).toBe(AUTH_WORDS.network);
    expect(authFailure("enroll", new Error("boom"))).toBe(AUTH_WORDS.enroll);
    expect(AUTH_WORDS.code).toMatch(/expired or was already used/);
    expect(deviceName("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)")).toBe("iPhone");
    expect(deviceName("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)")).toBe("Mac");
    expect(deviceName("")).toBe("This Device");
  });
});

// ---------------------------------------------------------------------------
// Ask in context
// ---------------------------------------------------------------------------

const PHONE_TAB = { ios: "iPhone", standalone: false, pushable: false, permission: "unsupported" };
const PHONE_APP = { ios: "iPhone", standalone: true, pushable: true, permission: "default" };
const DESKTOP = { ios: null, standalone: false, pushable: true, permission: "default" };

describe("ask in context — the first time something reaches Needs You, never on first launch", () => {
  it("nothing waiting: no ask, whatever the device", () => {
    for (const device of [PHONE_TAB, PHONE_APP, DESKTOP]) {
      expect(askFor({ waiting: 0, device, later: false, server: "present", subscribed: false })).toBe("none");
    }
  });

  it("something waiting: the ask — or, in an iPhone's Safari tab, the way to install", () => {
    expect(askFor({ waiting: 1, device: PHONE_APP, later: false, server: "present", subscribed: false })).toBe("ask");
    expect(askFor({ waiting: 3, device: DESKTOP, later: false, server: null, subscribed: false })).toBe("ask");
    expect(askFor({ waiting: 1, device: PHONE_TAB, later: false, server: "present", subscribed: false })).toBe("install");
  });

  it("never again after Not Now, where push cannot work, or where it is already on", () => {
    const base = { waiting: 2, later: false, server: "present", subscribed: false };
    expect(askFor({ ...base, device: PHONE_APP, later: true })).toBe("none");
    expect(askFor({ ...base, device: PHONE_APP, server: "absent" })).toBe("none");
    expect(askFor({ ...base, device: { ...DESKTOP, pushable: false, permission: "unsupported" } })).toBe("none");
    expect(askFor({ ...base, device: { ...DESKTOP, permission: "denied" } })).toBe("none");
    expect(askFor({ ...base, device: { ...DESKTOP, permission: "granted" }, subscribed: true })).toBe("none");
    // granted, but this device lost its subscription: ask to turn it back on
    expect(askFor({ ...base, device: { ...DESKTOP, permission: "granted" } })).toBe("ask");
  });

  it("the device is read the way Safari reports it — an iPad asking for the desktop site is still an iPad", () => {
    const win = (ua: string, extra: Record<string, unknown> = {}) => ({ navigator: { userAgent: ua, ...extra }, matchMedia: () => ({ matches: false }) });
    expect(deviceOf(win("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)"))).toMatchObject({ ios: "iPhone", standalone: false, pushable: false });
    expect(deviceOf(win("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", { platform: "MacIntel", maxTouchPoints: 5 })).ios).toBe("iPad");
    expect(deviceOf(win("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", { platform: "MacIntel", maxTouchPoints: 0 })).ios).toBeNull();
    // a touch screen alone is not an iPad: an Android phone on a Mac's platform string stays itself
    expect(deviceOf(win("Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/152 Mobile Safari/537.36", { platform: "MacIntel", maxTouchPoints: 5 })).ios).toBeNull();
    expect(deviceOf(win("x", { standalone: true })).standalone).toBe(true);
  });

  it("the permission prompt runs only from the owner's tap: a count arriving never asks the browser", async () => {
    const { requestPermission, ui, calls } = notifyHarness();
    ui.needs(0);
    await settle();
    expect(ui.$("push-ask").hidden).toBe(true);
    expect(calls.filter((c) => c.path === "/api/push/vapid-key")).toHaveLength(0); // nothing waits: not even a request
    ui.needs(2);
    await settle();
    expect(ui.$("push-ask").hidden).toBe(false);
    expect(ui.$("push-ask-on").hidden).toBe(false);
    expect(requestPermission).not.toHaveBeenCalled();
    await ui.$("push-ask-on").onclick!();
    await settle();
    expect(requestPermission).toHaveBeenCalledOnce();
    expect(ui.$("push-ask-status").textContent).toBe(PUSH_WORDS.on);
    expect(calls.map((c) => `${c.method} ${c.path}`)).toContain("POST /api/push/subscribe");
    expect(ui.$("push-ask").hidden).toBe(true);
  });

  it("Not Now is remembered on this device, and a closed permission prompt counts as one", async () => {
    const a = notifyHarness();
    a.ui.needs(1);
    await settle();
    a.ui.$("push-ask-later").onclick!();
    await settle();
    expect(a.stored.get(ASK_KEY)).toBe("later");
    expect(a.ui.$("push-ask").hidden).toBe(true);
    vi.unstubAllGlobals();
    const b = notifyHarness({ permission: "default" });
    b.ui.needs(1);
    await settle();
    await b.ui.$("push-ask-on").onclick!();
    await settle();
    expect(b.stored.get(ASK_KEY)).toBe("later");
    expect(b.ui.$("push-ask-status").textContent).toBe(PUSH_WORDS.dismissed);
  });

  it("a console with no push keys: the ask never shows, and Settings says why", async () => {
    const { ui } = notifyHarness({ vapid: { push: "absent" } });
    ui.needs(4);
    await settle();
    expect(ui.$("push-ask").hidden).toBe(true);
    await ui.settings();
    expect(ui.$("push-status").textContent).toBe(PUSH_WORDS.absent);
    expect(ui.$("push-enable").hidden).toBe(true);
  });
});

/** Mount notify.js on a desktop browser that grants (or dismisses) the prompt when asked. */
function notifyHarness({ permission = "granted", vapid = { key: "BPUBLIC" } as Record<string, unknown> } = {}) {
  const fb = fakeBrowser({
    respond: (c) => (c.path === "/api/push/vapid-key" ? { body: vapid } : c.path === "/api/push/test" ? { body: { result: "sent" } } : { body: { ok: true } }),
  });
  let current: string = "default";
  const requestPermission = vi.fn(async () => { current = permission; return permission; });
  const subscription: { value: unknown } = { value: null };
  const pushManager = {
    getSubscription: async () => subscription.value,
    subscribe: async () => { subscription.value = { endpoint: "https://push.example/1" }; return subscription.value; },
  };
  const serviceWorker = { register: async () => ({ pushManager }), getRegistration: async () => ({ pushManager }) };
  const nav = { userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/130", platform: "MacIntel", maxTouchPoints: 0, serviceWorker };
  const Notification = { requestPermission, get permission() { return current; } };
  const listeners: Record<string, ((e: unknown) => void)[]> = {};
  vi.stubGlobal("navigator", nav);
  vi.stubGlobal("Notification", Notification);
  vi.stubGlobal("window", {
    navigator: nav,
    Notification,
    PushManager: function PushManager() {},
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    addEventListener: (type: string, fn: (e: unknown) => void) => { (listeners[type] ??= []).push(fn); },
    alert: () => { throw new Error("window.alert was called"); },
  });
  const show = vi.fn();
  const ui = { ...mountNotify({ $: fb.$, api: fb.api, show }), $: fb.$ };
  return { ui, requestPermission, calls: fb.calls, stored: fb.stored, show, listeners };
}

// ---------------------------------------------------------------------------
// Install
// ---------------------------------------------------------------------------

describe("the install sheet: three steps on iPhone; the browser's own prompt, offered once from More", () => {
  it("iPhone in Safari: the sheet — installed already, nothing", () => {
    expect(installOffer({ device: PHONE_TAB, deferred: false, offered: false })).toBe("ios");
    expect(installOffer({ device: PHONE_APP, deferred: false, offered: false })).toBe("none");
  });

  it("Chrome and Edge: their own prompt while they hold one, and only until it has been offered", () => {
    expect(installOffer({ device: DESKTOP, deferred: true, offered: false })).toBe("prompt");
    expect(installOffer({ device: DESKTOP, deferred: true, offered: true })).toBe("none");
    expect(installOffer({ device: DESKTOP, deferred: false, offered: false })).toBe("none");
  });

  it("the sheet says Share, then Add to Home Screen, then open it", () => {
    const sheet = /<section id="install" hidden>[\s\S]*?<\/section>/.exec(HTML)?.[0] ?? "";
    const steps = [...sheet.matchAll(/<li>([\s\S]*?)<\/li>/g)].map((m) => m[1]!.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim());
    expect(steps).toHaveLength(3);
    expect(steps[0]).toMatch(/^Tap Share/);
    expect(steps[1]).toMatch(/^Choose Add to Home Screen/);
    expect(steps[2]).toMatch(/^Open Metistry from your Home Screen/);
    expect(sheet).toContain('<ol class="install-steps">');
  });

  it("the browser's prompt is held, not shown on launch, and offered from More exactly once", async () => {
    const h = notifyHarness();
    const prompt = vi.fn(async () => {});
    const event = { preventDefault: vi.fn(), prompt };
    expect(h.ui.$("install-group").hidden).toBe(true);
    for (const fn of h.listeners.beforeinstallprompt ?? []) fn(event);
    expect(event.preventDefault).toHaveBeenCalled();
    expect(prompt).not.toHaveBeenCalled();
    expect(h.ui.$("install-group").hidden).toBe(false);
    expect(h.ui.$("install-label").textContent).toBe("Install Metistry");
    await h.ui.$("install-row").onclick!();
    expect(prompt).toHaveBeenCalledOnce();
    expect(h.stored.get(INSTALL_KEY)).toBe("yes");
    expect(h.ui.$("install-group").hidden).toBe(true);
    for (const fn of h.listeners.beforeinstallprompt ?? []) fn({ preventDefault() {}, prompt });
    expect(h.ui.$("install-group").hidden).toBe(true);
  });

  it("Settings' state for a device reads as the owner would say it", () => {
    expect(pushState({ device: PHONE_TAB, server: "present", subscribed: false })).toBe("install");
    expect(pushState({ device: { ...DESKTOP, permission: "granted" }, server: "present", subscribed: true })).toBe("on");
    expect(pushState({ device: { ...DESKTOP, permission: "denied" }, server: "present", subscribed: false })).toBe("denied");
    expect(pushState({ device: DESKTOP, server: "present", subscribed: false })).toBe("off");
  });
});
