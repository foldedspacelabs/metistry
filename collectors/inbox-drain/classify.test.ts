import { describe, expect, it } from "vitest";
import { classify } from "./run.js";

const base = { id: 1, path: "123-x.bin", mime: null, note: null, source: "http" };

describe("inbox-drain deterministic classifier", () => {
  it("bare urls", () => {
    expect(classify({ ...base, note: "https://example.com/a" }).kind).toBe("url");
  });
  it("action-verb todos", () => {
    expect(classify({ ...base, note: "remind me to renew the cert" }).kind).toBe("todo");
    expect(classify({ ...base, note: "buy milk" }).kind).toBe("todo");
  });
  it("images and documents by mime/extension", () => {
    expect(classify({ ...base, mime: "image/heic" }).kind).toBe("image");
    expect(classify({ ...base, path: "9-spec.pdf" }).kind).toBe("document");
  });
  it("defaults to note, records which rule fired", () => {
    const c = classify({ ...base, note: "an idea about routing" });
    expect(c.kind).toBe("note");
    expect(c.reason).toBeTruthy();
  });
  it("a url INSIDE prose is not promoted to url-kind (quoted-content lesson, PoC-14)", () => {
    expect(classify({ ...base, note: "sam sent https://x.com/y check later" }).kind).toBe("note");
  });
});
