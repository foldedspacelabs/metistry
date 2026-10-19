// The proxy listener's rate limiter (plan §2.23, X-111) — the pure pieces:
// which address a request is limited under, the fixed window per client and
// the ceiling over all of them, one `first` per burst, and the bound on how
// many clients are held. The same rules at the server's door, with the 429s
// and the audit rows they leave, are proxy-limits.integration.test.ts.
import { describe, expect, it } from "vitest";
import { clientKeyOf, DEFAULT_PROXY_LIMITS, MAX_TRACKED_CLIENTS, RateLimiter, Toll } from "../src/rate-limit.js";

/** A limiter on a clock the test turns by hand. */
function limiter(perClient: number, global: number, windowMs = 60_000) {
  let t = 1_000_000;
  const l = new RateLimiter({ clientHeader: "x-forwarded-for", perClient, global, windowMs }, () => t);
  return { l, tick: (ms: number) => (t += ms) };
}

describe("clientKeyOf — the address the PROVIDER wrote, never the one the client claims", () => {
  it("reads the last entry of the header: the hop nearest to us appended it", () => {
    expect(clientKeyOf({ "x-forwarded-for": "203.0.113.7" }, "x-forwarded-for", "127.0.0.1")).toBe("203.0.113.7");
    // a client that sent its own X-Forwarded-For has it in FRONT of the provider's entry
    expect(clientKeyOf({ "x-forwarded-for": "10.0.0.1, 198.51.100.4, 203.0.113.7" }, "x-forwarded-for", "127.0.0.1")).toBe("203.0.113.7");
    expect(clientKeyOf({ "x-forwarded-for": " 2001:DB8::1 " }, "x-forwarded-for", "127.0.0.1")).toBe("2001:db8::1");
    // node joins repeated headers with ", " but hands some as arrays: the last value's last entry either way
    expect(clientKeyOf({ "x-forwarded-for": ["10.0.0.1", "203.0.113.9"] } as never, "x-forwarded-for", "127.0.0.1")).toBe("203.0.113.9");
  });

  it("takes the configured header, whatever its case, and nothing else", () => {
    const h = { "x-forwarded-for": "10.0.0.1", "cf-connecting-ip": "203.0.113.5" };
    expect(clientKeyOf(h, "CF-Connecting-IP", "127.0.0.1")).toBe("203.0.113.5");
    expect(clientKeyOf(h, "x-forwarded-for", "127.0.0.1")).toBe("10.0.0.1");
  });

  it("**with no header the peer stands in** — on the proxy listener the provider's own loopback dial, so everyone shares one bucket (and the ceiling bounds it)", () => {
    expect(clientKeyOf({}, "x-forwarded-for", "127.0.0.1")).toBe("127.0.0.1");
    expect(clientKeyOf({ "x-forwarded-for": "" }, "x-forwarded-for", "127.0.0.1")).toBe("127.0.0.1");
    expect(clientKeyOf({ "x-forwarded-for": " , ," }, "x-forwarded-for", "127.0.0.1")).toBe("127.0.0.1");
    // the Unix socket has no peer address at all
    expect(clientKeyOf({}, "x-forwarded-for", undefined)).toBe("peer");
    expect(clientKeyOf({}, "x-forwarded-for", "")).toBe("peer");
  });

  it("is bounded: a header can never write a kilobyte into a runs row", () => {
    expect(clientKeyOf({ "x-forwarded-for": "a".repeat(5000) }, "x-forwarded-for", "127.0.0.1")).toHaveLength(64);
  });
});

describe("RateLimiter — fixed windows per client, a ceiling over all of them", () => {
  it("answers a client its limit per window, then refuses it — `first` exactly once per burst", () => {
    const { l } = limiter(3, 100);
    expect(l.take("a")).toEqual({ ok: true });
    expect(l.take("a")).toEqual({ ok: true });
    expect(l.take("a")).toEqual({ ok: true });
    const fourth = l.take("a");
    expect(fourth).toMatchObject({ ok: false, scope: "client", first: true, limit: 3 });
    expect(l.take("a")).toMatchObject({ ok: false, scope: "client", first: false });
    expect(l.take("a")).toMatchObject({ ok: false, scope: "client", first: false });
    // another client is another bucket
    expect(l.take("b")).toEqual({ ok: true });
  });

  it("**the window turns and the client is answered again; a new burst is a new `first`**", () => {
    const { l, tick } = limiter(2, 100, 60_000);
    l.take("a");
    l.take("a");
    expect(l.take("a")).toMatchObject({ ok: false, first: true });
    tick(60_000);
    expect(l.take("a")).toEqual({ ok: true });
    expect(l.take("a")).toEqual({ ok: true });
    expect(l.take("a")).toMatchObject({ ok: false, first: true });
  });

  it("Retry-After is the whole seconds to the end of the window, at least 1", () => {
    // the clock starts at 1 000 000 ms = 40 s into a 60 s window → 20 s left
    const { l, tick } = limiter(1, 100, 60_000);
    l.take("a");
    expect(l.take("a")).toMatchObject({ ok: false, retryAfterS: 20 });
    tick(19_900);
    expect(l.take("a")).toMatchObject({ ok: false, retryAfterS: 1 });
  });

  it("**the ceiling refuses everyone once the listener has answered its total**, named `global`, `first` once — and a refused client never spends it", () => {
    const { l } = limiter(10, 5);
    for (let i = 0; i < 5; i++) expect(l.take(`c${i}`)).toEqual({ ok: true });
    expect(l.take("c5")).toMatchObject({ ok: false, scope: "global", first: true, limit: 5 });
    expect(l.take("c6")).toMatchObject({ ok: false, scope: "global", first: false });
    expect(l.exhausted("never-seen")).toBe(true);
  });

  it("a client past its own limit does not count against the ceiling: its refusals are not answers", () => {
    const { l } = limiter(2, 3);
    l.take("scanner");
    l.take("scanner");
    for (let i = 0; i < 50; i++) expect(l.take("scanner")).toMatchObject({ ok: false, scope: "client" });
    // two answers were given in total, not fifty-two: the ceiling of three has one left for everyone else
    expect(l.take("phone")).toEqual({ ok: true });
    expect(l.take("phone")).toMatchObject({ ok: false, scope: "global" });
  });

  it("the client's own limit is named before the ceiling where both would refuse", () => {
    const { l } = limiter(1, 1);
    l.take("a");
    expect(l.take("a")).toMatchObject({ scope: "client" });
    expect(l.take("b")).toMatchObject({ scope: "global" });
  });

  it("`exhausted` is a look, not a charge", () => {
    const { l } = limiter(2, 100);
    expect(l.exhausted("a")).toBe(false);
    l.take("a");
    expect(l.exhausted("a")).toBe(false);
    l.take("a");
    expect(l.exhausted("a")).toBe(true);
    expect(l.exhausted("a")).toBe(true); // asking did not spend anything either way
    expect(l.take("a")).toMatchObject({ ok: false, first: true });
  });

  it("**holds at most MAX_TRACKED_CLIENTS keys**: a header that varies cannot grow the map without bound, and the window's turn sweeps it", () => {
    const { l, tick } = limiter(10, 10_000_000, 60_000);
    for (let i = 0; i < MAX_TRACKED_CLIENTS + 500; i++) l.take(`k${i}`);
    expect(l.size).toBe(MAX_TRACKED_CLIENTS);
    // the earliest keys made room; the latest are still counted
    expect(l.exhausted(`k${MAX_TRACKED_CLIENTS + 499}`)).toBe(false);
    for (let i = 0; i < 10; i++) l.take("late");
    expect(l.exhausted("late")).toBe(true);
    tick(60_000);
    l.take("fresh");
    expect(l.size).toBe(1);
  });

  it("ships with the documented defaults", () => {
    expect(DEFAULT_PROXY_LIMITS).toEqual({ clientHeader: "x-forwarded-for", perClient: 120, global: 1200, windowMs: 60_000 });
  });
});

describe("Toll — one charge per request, however many gates ask", () => {
  it("takes once and answers the same verdict after", () => {
    const { l } = limiter(1, 100);
    const t = new Toll(l, "a");
    expect(t.charged).toBe(false);
    expect(t.exhausted()).toBe(false);
    expect(t.take()).toEqual({ ok: true });
    expect(t.take()).toEqual({ ok: true });
    expect(t.take()).toEqual({ ok: true }); // three asks, one answer spent
    expect(t.charged).toBe(true);
    expect(l.exhausted("a")).toBe(true); // the limit was 1 and exactly one was taken
    const next = new Toll(l, "a");
    expect(next.exhausted()).toBe(true);
    expect(next.take()).toMatchObject({ ok: false, first: true });
    expect(next.take()).toMatchObject({ ok: false, first: true }); // the same verdict, not a second refusal
  });
});
