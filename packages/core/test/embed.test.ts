import { describe, expect, it } from "vitest";
import { EmbedClient, EmbedUnavailableError, chunkMarkdown, vectorLiteral, type FetchLike } from "../src/embed.js";

const para = (n: number, word: string) => Array.from({ length: n }, () => word).join(" ");

describe("chunkMarkdown", () => {
  it("splits on headings and carries the breadcrumb into every chunk", () => {
    const md = ["intro line", "", "# Sleep", "", "body about sleep", "", "## Protocol", "", "wind down at ten"].join("\n");
    const chunks = chunkMarkdown(md);
    expect(chunks.map((c) => c.heading)).toEqual([null, "Sleep", "Sleep > Protocol"]);
    expect(chunks[0]!.text).toBe("intro line");
    expect(chunks[2]!.text).toBe("Sleep > Protocol\n\nwind down at ten");
    expect(chunks.map((c) => c.index)).toEqual([0, 1, 2]);
  });

  it("pops the heading stack back to the right ancestor", () => {
    const md = "# A\n\na\n\n## B\n\nb\n\n### C\n\nc\n\n## D\n\nd\n";
    expect(chunkMarkdown(md).map((c) => c.heading)).toEqual(["A", "A > B", "A > B > C", "A > D"]);
  });

  it("does not read headings inside fenced code", () => {
    const md = "# Real\n\ntext\n\n```sh\n# not a heading\necho hi\n```\n\nmore text\n";
    const chunks = chunkMarkdown(md);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.heading).toBe("Real");
    expect(chunks[0]!.text).toContain("# not a heading");
  });

  it("packs paragraphs to the target and overlaps the tail", () => {
    const md = `${para(30, "alpha")}\n\n${para(30, "bravo")}\n\n${para(30, "charlie")}`;
    const chunks = chunkMarkdown(md, { targetChars: 300, overlapChars: 60 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.text.length).toBeLessThanOrEqual(360);
    // the tail of chunk n reappears at the head of chunk n+1
    const tail = chunks[0]!.text.slice(-20);
    expect(chunks[1]!.text.startsWith(chunks[0]!.text.slice(-60).trimStart().slice(0, 10))).toBe(true);
    expect(chunks[1]!.text).toContain(tail.trim().split(" ")[0]!);
  });

  it("hard-splits a paragraph longer than a whole chunk", () => {
    const chunks = chunkMarkdown("x".repeat(1200), { targetChars: 300, overlapChars: 50 });
    expect(chunks.length).toBeGreaterThanOrEqual(4);
    expect(chunks.map((c) => c.index)).toEqual(chunks.map((_, i) => i));
    expect(chunks.every((c) => c.text.length <= 300)).toBe(true);
  });

  it("is deterministic: identical input gives identical indices and text", () => {
    const md = "# H\n\n" + para(200, "word") + "\n\n## H2\n\n" + para(200, "other");
    expect(chunkMarkdown(md)).toEqual(chunkMarkdown(md));
  });

  it("returns nothing for empty or heading-only input", () => {
    expect(chunkMarkdown("")).toEqual([]);
    expect(chunkMarkdown("# Only a heading\n\n   \n")).toEqual([]);
  });
});

describe("EmbedClient", () => {
  const vec = (n: number) => Array.from({ length: 4 }, () => n);

  function stub(handler: (body: { model: string; input: string[] }) => unknown, ok = true, status = 200): { fetchImpl: FetchLike; calls: string[][] } {
    const calls: string[][] = [];
    const fetchImpl: FetchLike = async (_url, init) => {
      const body = JSON.parse(init.body) as { model: string; input: string[] };
      calls.push(body.input);
      const payload = handler(body);
      return { ok, status, text: async () => JSON.stringify(payload), json: async () => payload };
    };
    return { fetchImpl, calls };
  }

  it("batches requests and preserves order", async () => {
    const { fetchImpl, calls } = stub((b) => ({ embeddings: b.input.map((_, i) => vec(i)) }));
    const client = new EmbedClient({ dim: 4, batch: 2, fetchImpl });
    const out = await client.embed(["a", "b", "c", "d", "e"]);
    expect(calls).toEqual([["a", "b"], ["c", "d"], ["e"]]);
    expect(out).toHaveLength(5);
  });

  it("turns a transport failure into EmbedUnavailableError", async () => {
    const fetchImpl: FetchLike = async () => {
      throw new Error("connect ECONNREFUSED 127.0.0.1:11434");
    };
    await expect(new EmbedClient({ fetchImpl }).embedOne("x")).rejects.toBeInstanceOf(EmbedUnavailableError);
  });

  it("rejects a wrong-dimension vector rather than storing it", async () => {
    const { fetchImpl } = stub(() => ({ embeddings: [[1, 2]] }));
    await expect(new EmbedClient({ dim: 4, fetchImpl }).embedOne("x")).rejects.toThrow(/4-dimension/);
  });

  it("reports a non-2xx (model not pulled) as unavailable", async () => {
    const { fetchImpl } = stub(() => ({ error: 'model "nomic-embed-text" not found' }), false, 404);
    await expect(new EmbedClient({ fetchImpl }).embedOne("x")).rejects.toThrow(/404/);
  });
});

describe("vectorLiteral", () => {
  it("renders pgvector's literal form", () => {
    expect(vectorLiteral([1, -0.5, 0])).toBe("[1,-0.5,0]");
  });
});
