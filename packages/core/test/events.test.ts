// The live-changes catalogue (design-build-plan §2.20): ids, never bodies,
// and nothing an agent can subscribe to.
import { describe, expect, it } from "vitest";
import { CAPABILITIES, EVENTS_CAPABILITY, EVENTS_ROUTE, EVENT_CATALOGUE, EVENT_REACH, EVENT_TYPES, isEventType, matchRoute, type ClientEvent, type EventPayloads } from "../src/index.js";

describe("the event catalogue", () => {
  it("has one row per type, in the declared order", () => {
    expect(EVENT_CATALOGUE.map((e) => e.type)).toEqual([...EVENT_TYPES]);
  });

  it("reaches the owner and nobody else", () => {
    expect(EVENT_REACH).toBe("owner");
    for (const e of EVENT_CATALOGUE) expect(e.reach, e.type).toBe("owner");
  });

  it("carries ids, names and counts — never a field that could hold a body", () => {
    // Every payload field is an id, a name, a count or a state token. A field
    // called text, body, content, payload, row or title would be the stream
    // carrying what the routes are there to gate.
    for (const e of EVENT_CATALOGUE) {
      const fields = e.payload.replace(/[{}?\s]/g, "").split(/[,|]/).filter(Boolean);
      for (const f of fields) {
        expect(f, e.type).toMatch(/^([a-z_]+_id|thread|kind|waiting|changed|state|name|connection|file|scope|version)$/);
        expect(f, e.type).not.toMatch(/text|body|content|payload|row|title|note|message$/);
      }
    }
  });

  it("is advertised as the `events` capability", () => {
    expect(EVENTS_CAPABILITY).toBe("events");
    expect(CAPABILITIES).toContain(EVENTS_CAPABILITY);
  });

  it("recognises its own types and nothing else", () => {
    expect(isEventType("work.changed")).toBe(true);
    expect(isEventType("work.deleted")).toBe(false);
    expect(isEventType(42)).toBe(false);
  });

  it("types each payload", () => {
    const e: ClientEvent<"message.new"> = { id: "7", type: "message.new", data: { message_id: 12, thread: "default" } };
    const thread: EventPayloads["thread.changed"][] = [{ work_id: 3 }, { artifact_id: "art_01J" }];
    expect(e.data.message_id).toBe(12);
    expect(thread).toHaveLength(2);
  });
});

describe("the event catalogue against the table", () => {
  it("streams on an owner row of the table", () => {
    const [method, path] = EVENTS_ROUTE.split(" ") as [string, string];
    const r = matchRoute(method, path)!.route;
    expect(r.reach).toEqual(["owner"]);
    expect(r.principals).not.toContain("agent");
  });

  it("every route an event sends a client to is a GET in the table", () => {
    for (const e of EVENT_CATALOGUE) {
      for (const [, method, target] of e.refetch.matchAll(/`(GET) ([^`?]+)(?:\?[^`]*)?`/g)) {
        expect(matchRoute(method!, target!), `${e.type} → ${method} ${target}`).toBeDefined();
      }
    }
  });
});
