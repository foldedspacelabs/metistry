// X-78 — the phone's half of Add a Phone (design-build-plan §2.22, *The phone,
// in order*): the PWA reads `#enroll=<code>` once and takes it out of the
// address bar and history; a standalone launch shows sign-in, never the
// enrolment wall; after enrolling in an iPhone's Safari the wall hands on to
// T7-5's install sheet, whose last line says when notifications are asked.
//
// apps/console/web is a browser app with no DOM harness here (and none is
// added), so, as in pwa-shell.test.ts, the top-level declarations are lifted
// out of app.js by name and evaluated against a fake window; the markup is
// read from index.html itself. A rename makes a lift throw rather than letting
// a test pass vacuously.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { deviceOf, installOffer } from "../web/notify.js";
import { FakeEl } from "./pwa-fake-dom.js";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const SRC = read("../web/app.js");
const HTML = read("../web/index.html").replace(/<!--[\s\S]*?-->/g, "");

/** Lift a top-level `const NAME = …`, `let NAME = …` or `[async] function NAME(…) {…}` out of app.js. */
function lift(name: string): string {
  const lines = SRC.split("\n");
  const start = lines.findIndex((l) => new RegExp(`^(?:const|let) ${name}\\b|^(?:async )?function ${name}\\(`).test(l));
  if (start === -1) throw new Error(`app.js no longer declares ${name} — update this test with the rename`);
  let depth = 0;
  for (let i = start; i < lines.length; i++) {
    for (const ch of lines[i]!) {
      if ("([{".includes(ch)) depth++;
      else if (")]}".includes(ch)) depth--;
    }
    if (depth <= 0) return lines.slice(start, i + 1).join("\n");
  }
  throw new Error(`could not find the end of ${name} in app.js`);
}

const readEnrollCode = new Function("deviceOf", `${lift("readEnrollCode")}; return readEnrollCode;`)(deviceOf) as (win: unknown) => string | null;
const afterEnroll = new Function("installOffer", `${lift("afterEnroll")}; return afterEnroll;`)(installOffer) as (device: unknown) => "install" | "home";
const AUTH_WORDS = new Function(`${lift("AUTH_WORDS")}; return AUTH_WORDS;`)() as Record<string, string>;

const SAFARI_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1";
const CODE = "k7f3ab9c0d1e2f3a4b5c6d7e8f901234";

/**
 * A window with its address bar and history: `replaceState` rewrites the entry
 * the page is on, `pushState` would add one. Every URL the history ever held
 * is kept, so a test can say the code is in none of them.
 */
function fakeWindow({ hash = "", standalone = false, ua = SAFARI_UA }: { hash?: string; standalone?: boolean; ua?: string } = {}) {
  const location = { hash, pathname: "/", search: "", get href() { return `https://m.example${this.pathname}${this.search}${this.hash}`; } };
  const entries: string[] = [location.href];
  const apply = (url: string) => {
    const i = url.indexOf("#");
    location.hash = i === -1 ? "" : url.slice(i);
    const path = i === -1 ? url : url.slice(0, i);
    const q = path.indexOf("?");
    location.pathname = q === -1 ? path : path.slice(0, q);
    location.search = q === -1 ? "" : path.slice(q);
  };
  const history = {
    replaceState: vi.fn((_s: unknown, _t: string, url: string) => { apply(url); entries[entries.length - 1] = location.href; }),
    pushState: vi.fn((_s: unknown, _t: string, url: string) => { apply(url); entries.push(location.href); }),
  };
  const navigator = { userAgent: ua, platform: "iPhone", maxTouchPoints: 5, standalone };
  const win = { location, history, navigator, matchMedia: (q: string) => ({ matches: q.includes("display-mode: standalone") && standalone }) };
  return { win, location, history, entries };
}

/** Paint the wall the way app.js does, with the code the launch read. */
function wall(enrollCode: string | null, ua = SAFARI_UA) {
  const els = new Map<string, FakeEl>();
  const $ = (id: string) => {
    if (!els.has(id)) els.set(id, new FakeEl(id));
    return els.get(id)!;
  };
  const paint = new Function(
    "$", "live", "closeSheet", "chrome", "SECTIONS", "deviceName", "navigator", "enrollCode",
    `let signedIn = true; let current = "today"; ${lift("showAuth")} showAuth(); return { signedIn, current };`,
  ) as (...a: unknown[]) => { signedIn: boolean; current: string | null };
  const deviceName = new Function(`${lift("deviceName")}; return deviceName;`)() as (ua: string) => string;
  const state = paint($, { stop() {} }, () => {}, () => {}, ["today", "chat"], deviceName, { userAgent: ua }, enrollCode);
  return { $, state };
}

// ---------------------------------------------------------------------------
// The link's code: read once, gone from location and history
// ---------------------------------------------------------------------------

describe("the enrolment code is not in location or history after it is read (§2.22 step 1)", () => {
  it("reads the code, and the same history entry is rewritten without it — nothing is pushed", () => {
    const { win, location, history, entries } = fakeWindow({ hash: `#enroll=${CODE}` });
    expect(readEnrollCode(win)).toBe(CODE);
    expect(location.hash).toBe("");
    expect(location.href).toBe("https://m.example/");
    expect(history.replaceState).toHaveBeenCalledTimes(1);
    expect(history.pushState).not.toHaveBeenCalled();
    expect(entries).toEqual(["https://m.example/"]); // one entry, and it does not carry the code
    expect(entries.join(" ")).not.toContain(CODE);
  });

  it("keeps the path and query, drops only the hash the link carried", () => {
    const { win, location } = fakeWindow({ hash: `#enroll=${CODE}` });
    location.pathname = "/index.html";
    location.search = "?utm=phone";
    readEnrollCode(win);
    expect(location.href).toBe("https://m.example/index.html?utm=phone");
  });

  it("the code is read once: a second read of the same window finds nothing", () => {
    const { win } = fakeWindow({ hash: `#enroll=${CODE}` });
    expect(readEnrollCode(win)).toBe(CODE);
    expect(readEnrollCode(win)).toBe(null);
  });

  it("a launch with no link rewrites nothing, and a hash route is left for its view", () => {
    for (const hash of ["", "#/needs-you/42", "#/artifacts/a1", "#/rooms/work/c3"]) {
      const { win, location, history } = fakeWindow({ hash });
      expect(readEnrollCode(win)).toBe(null);
      expect(location.hash).toBe(hash);
      expect(history.replaceState).not.toHaveBeenCalled();
    }
  });

  it("app.js reads the code through this function at load, and nowhere else reads the hash for it", () => {
    expect(SRC).toMatch(/^let enrollCode = readEnrollCode\(window\);/m);
    expect(SRC.match(/get\("enroll"\)/g)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// The wall: enrolment in Safari, sign-in in the installed app
// ---------------------------------------------------------------------------

describe("the wall a launch shows", () => {
  it("Safari, opened from the link: the enrolment wall, this device's name prefilled", () => {
    const { win } = fakeWindow({ hash: `#enroll=${CODE}` });
    const { $, state } = wall(readEnrollCode(win));
    expect($("auth").hidden).toBe(false);
    expect($("auth-msg").textContent).toBe("Enroll This Device");
    expect($("enroll-form").hidden).toBe(false);
    expect($("enroll-btn").hidden).toBe(false);
    expect($("enroll-label").value).toBe("iPhone");
    expect(state.signedIn).toBe(false);
  });

  it("a standalone launch shows sign-in, never the enrolment wall — even with a code in the URL, which is still removed", () => {
    for (const standalone of [{ standalone: true }, { standalone: false }]) {
      const { win, location, history } = fakeWindow({ hash: `#enroll=${CODE}`, ...standalone });
      // navigator.standalone (Safari's own flag) and the display-mode media query say the same thing; either is enough
      if (!standalone.standalone) win.matchMedia = () => ({ matches: true });
      const code = readEnrollCode(win);
      expect(code).toBe(null);
      expect(location.hash).toBe("");
      expect(history.replaceState).toHaveBeenCalledTimes(1);
      const { $ } = wall(code);
      expect($("auth-msg").textContent).toBe("Sign In");
      expect($("enroll-form").hidden).toBe(true);
      expect($("enroll-btn").hidden).toBe(true);
      expect($("login-btn").hidden).toBe(false);
    }
  });

  it("a standalone launch with no link is the same sign-in wall", () => {
    const { win } = fakeWindow({ standalone: true });
    const { $ } = wall(readEnrollCode(win));
    expect($("auth-msg").textContent).toBe("Sign In");
    expect($("enroll-btn").hidden).toBe(true);
  });

  it("sign-in is the existing login ceremony — the installed app never enrols a second passkey", () => {
    const login = /\$\("login-btn"\)\.onclick = [\s\S]*?\n\}\);/.exec(SRC)?.[0] ?? "";
    expect(login).toContain('"/auth/login/start"');
    expect(login).toContain('"/auth/login/finish"');
    expect(login).toContain("startAuthentication(");
    expect(login).not.toContain("enroll");
  });
});

// ---------------------------------------------------------------------------
// After enrolling: the install sheet in Safari, home in the installed app
// ---------------------------------------------------------------------------

describe("after a successful enrolment (§2.22 step 3)", () => {
  const PHONE_TAB = { ios: "iPhone", standalone: false, pushable: false, permission: "unsupported" };
  const PAD_TAB = { ios: "iPad", standalone: false, pushable: false, permission: "unsupported" };
  const PHONE_APP = { ios: "iPhone", standalone: true, pushable: true, permission: "default" };
  const DESKTOP = { ios: null, standalone: false, pushable: true, permission: "default" };

  it("an iPhone's or iPad's Safari hands on to the install sheet; the installed app and a desktop browser go home", () => {
    expect(afterEnroll(PHONE_TAB)).toBe("install");
    expect(afterEnroll(PAD_TAB)).toBe("install");
    expect(afterEnroll(PHONE_APP)).toBe("home");
    expect(afterEnroll(DESKTOP)).toBe("home");
  });

  it("the wall's enrol step goes home, then opens T7-5's sheet by that rule — no second sheet, no alert", () => {
    const enrol = /\$\("enroll-btn"\)\.onclick = [\s\S]*?\n\}\);/.exec(SRC)?.[0] ?? "";
    expect(enrol).toContain("enrollCode = null;");
    expect(enrol.indexOf("show(HOME)")).toBeGreaterThan(-1);
    expect(enrol.indexOf('show("install"')).toBeGreaterThan(enrol.indexOf("show(HOME)"));
    expect(enrol).toMatch(/afterEnroll\(device\) === "install"/);
    expect(enrol).toContain("`Install on ${device.ios}`"); // the title notify.js gives the same sheet
    expect(enrol).not.toContain("alert(");
    expect(enrol).not.toContain("history."); // the code left the URL when it was read, not here
  });

  it("the install sheet's last line says notifications are asked the first time something needs you", () => {
    const sheet = /<section id="install" hidden>[\s\S]*?<\/section>/.exec(HTML)?.[0] ?? "";
    const steps = [...sheet.matchAll(/<li>([\s\S]*?)<\/li>/g)].map((m) => m[1]!.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim());
    expect(steps).toHaveLength(3);
    expect(steps[2]).toMatch(/^Open Metistry from your Home Screen and sign in\./);
    expect(steps[2]).toMatch(/notifications the first time something needs you/);
    expect(sheet).not.toMatch(/turn notifications on there/); // setup no longer asks the owner to go and turn them on
  });

  it("the refusals keep AUTH_WORDS — no new wording beyond the sheet's line", () => {
    expect(AUTH_WORDS).toEqual({
      code: "This link has expired or was already used. Make a new one on your Mac.",
      enroll: "This device couldn't be enrolled. The link may have expired — make a new one on your Mac.",
      signin: "Sign-in didn't work. Try again.",
      cancelled: "No passkey was used. Try again when you're ready.",
      network: "Can't reach Metistry. Check the connection and try again.",
    });
    const auth = /<section id="auth" hidden>[\s\S]*?<\/section>/.exec(HTML)?.[0] ?? "";
    expect(auth).toContain("<h2 id=\"auth-msg\">Sign In</h2>");
    expect(auth).toContain("Enroll This Device");
    expect(auth).toContain("Sign In with Passkey");
  });
});
