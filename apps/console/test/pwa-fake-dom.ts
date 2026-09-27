// Just enough of a browser to mount one of the PWA's view modules
// (apps/console/web/today.js, needs-you.js, work.js, knowledge.js, more.js)
// and drive it the way a finger
// does: elements that hold what the view writes and dispatch what the test
// sends, `matchMedia`, and a recording `api`. No DOM library — none is a
// dependency here (CLAUDE.md), and the views only touch what is below.
import { vi } from "vitest";

type Listener = (e: Record<string, unknown>) => unknown;

export class FakeEl {
  id: string;
  dataset: Record<string, string> = {};
  hidden = false;
  textContent = "";
  innerHTML = "";
  className = "";
  disabled = false;
  checked = false;
  value = "";
  clientWidth = 390;
  style: Record<string, string> = {};
  attrs: Record<string, string> = {};
  onclick: (() => unknown) | null = null;
  classes = new Set<string>();
  listeners: Record<string, Listener[]> = {};
  classList = {
    toggle: (c: string, on?: boolean) => {
      if (on ?? !this.classes.has(c)) this.classes.add(c);
      else this.classes.delete(c);
    },
    contains: (c: string) => this.classes.has(c),
  };
  constructor(id = "") {
    this.id = id;
  }
  setAttribute(k: string, v: string) { this.attrs[k] = v; }
  addEventListener(type: string, fn: Listener) { (this.listeners[type] ??= []).push(fn); }
  /** Deliver an event to every listener, and wait for what they started. */
  async fire(type: string, event: Record<string, unknown>) {
    await Promise.all((this.listeners[type] ?? []).map((fn) => fn(event)));
    await settle();
  }
  closest(): FakeEl | null { return null; }
  querySelector(): FakeEl | null { return null; }
  querySelectorAll(): FakeEl[] { return []; }
  setPointerCapture() {}
  focus() {}
}

/** Let every queued promise run: a view's handler awaits `api` and then repaints. */
export async function settle() {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
}

export interface Call { path: string; method: string; headers: Record<string, string>; body: unknown }

/**
 * Install `window`, `document` and `CSS` for one mount; `wide` is the answer
 * every `min-width` media query gets. Returns `$` over a lazily grown set of
 * elements, and the recording `api` — `respond` decides each answer.
 */
export function fakeBrowser({ wide = false, respond }: { wide?: boolean; respond: (c: Call) => { status?: number; body: unknown } }) {
  const els = new Map<string, FakeEl>();
  const $ = (id: string) => {
    if (!els.has(id)) els.set(id, new FakeEl(id));
    return els.get(id)!;
  };
  const doc = new FakeEl("document");
  const windowListeners: Record<string, Listener[]> = {};
  vi.stubGlobal("window", {
    matchMedia: (q: string) => ({ matches: q.includes("reduced-motion") ? false : q.includes("max-width") ? !wide : wide, addEventListener() {} }),
    addEventListener: (type: string, fn: Listener) => { (windowListeners[type] ??= []).push(fn); },
  });
  // a hash route (#/artifacts/…, #/rooms/work/…) is read from `location` and written through `history`
  const loc = { hash: "", pathname: "/", search: "" };
  vi.stubGlobal("location", loc);
  vi.stubGlobal("history", { replaceState: (_s: unknown, _t: string, url: string) => { loc.hash = url.includes("#") ? url.slice(url.indexOf("#")) : ""; } });
  vi.stubGlobal("document", Object.assign(doc, { activeElement: null }));
  vi.stubGlobal("CSS", { escape: (s: string) => s });
  const stored = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (k: string) => stored.get(k) ?? null, setItem: (k: string, v: string) => void stored.set(k, String(v)) });
  const calls: Call[] = [];
  const api = async (path: string, opts: { method?: string; headers?: Record<string, string>; body?: string } = {}) => {
    const call: Call = { path, method: opts.method ?? "GET", headers: opts.headers ?? {}, body: opts.body === undefined ? undefined : JSON.parse(opts.body) };
    calls.push(call);
    const { status = 200, body } = respond(call);
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  };
  /** Follow a link: set the hash, then tell whoever listens for it, as the browser would. */
  const go = async (hash: string) => {
    loc.hash = hash;
    await Promise.all((windowListeners.hashchange ?? []).map((fn) => fn({})));
    await settle();
  };
  return { $, api, calls, stored, loc, go, writes: () => calls.filter((c) => c.method !== "GET") };
}

/** A target whose `closest(selector)` answers from a table: what a click on a control inside a row looks like. */
export function target(match: Record<string, FakeEl | null>, extra: Partial<FakeEl> = {}) {
  const el = Object.assign(new FakeEl(), extra);
  el.closest = ((sel: string) => (sel in match ? match[sel] : null)) as FakeEl["closest"];
  return el;
}

/** An element carrying `data-*` — a button the view wrote, as the delegated listener finds it. */
export function control(data: Record<string, string>, extra: Partial<FakeEl> = {}) {
  const el = Object.assign(new FakeEl(), extra);
  el.dataset = { ...data };
  el.closest = ((sel: string) => (sel === "[data-act]" && data.act ? el : null)) as FakeEl["closest"];
  return el;
}
