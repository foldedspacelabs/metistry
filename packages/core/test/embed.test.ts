import { describe, expect, it } from "vitest";
import {
  EMBED_DEFAULT_URL,
  EmbedClient,
  EmbedUnavailableError,
  LOCAL_MODEL_URL_VAR,
  OLLAMA_URL_VAR,
  apiRootOf,
  chunkMarkdown,
  resolveLocalModelUrl,
  vectorLiteral,
  type FetchLike,
} from "../src/embed.js";

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

  function stub(handler: (body: { model: string; input: string[] }) => unknown, ok = true, status = 200): { fetchImpl: FetchLike; calls: string[][]; urls: string[] } {
    const calls: string[][] = [];
    const urls: string[] = [];
    const fetchImpl: FetchLike = async (url, init) => {
      urls.push(url);
      const body = JSON.parse(init.body) as { model: string; input: string[] };
      calls.push(body.input);
      const payload = handler(body);
      return { ok, status, text: async () => JSON.stringify(payload), json: async () => payload };
    };
    return { fetchImpl, calls, urls };
  }

  /** OpenAI's shape — what LM Studio, Ollama's /v1 and llama-server all answer. */
  const openai = (vectors: number[][], withIndex = true) => ({ data: vectors.map((embedding, index) => (withIndex ? { index, embedding } : { embedding })) });

  it("posts the OpenAI-compatible /v1/embeddings, not Ollama's /api/embed", async () => {
    const { fetchImpl, urls } = stub(() => openai([vec(1)]));
    await new EmbedClient({ dim: 4, fetchImpl }).embedOne("x");
    expect(urls).toEqual([`${EMBED_DEFAULT_URL}/embeddings`]);
  });

  it("batches requests and preserves order", async () => {
    const { fetchImpl, calls } = stub((b) => openai(b.input.map((_, i) => vec(i))));
    const client = new EmbedClient({ dim: 4, batch: 2, fetchImpl });
    const out = await client.embed(["a", "b", "c", "d", "e"]);
    expect(calls).toEqual([["a", "b"], ["c", "d"], ["e"]]);
    expect(out).toHaveLength(5);
  });

  it("honours `index`, so a server that answers out of order cannot mis-pair a chunk with its vector", async () => {
    const { fetchImpl } = stub(() => ({ data: [{ index: 1, embedding: vec(9) }, { index: 0, embedding: vec(0) }] }));
    const out = await new EmbedClient({ dim: 4, fetchImpl }).embed(["first", "second"]);
    expect(out[0]).toEqual(vec(0));
    expect(out[1]).toEqual(vec(9));
  });

  it("accepts a response with no `index` at all, in wire order", async () => {
    const { fetchImpl } = stub(() => openai([vec(0), vec(1)], false));
    const out = await new EmbedClient({ dim: 4, fetchImpl }).embed(["a", "b"]);
    expect(out).toEqual([vec(0), vec(1)]);
  });

  it("turns a transport failure into EmbedUnavailableError", async () => {
    const fetchImpl: FetchLike = async () => {
      throw new Error("connect ECONNREFUSED 127.0.0.1:11434");
    };
    await expect(new EmbedClient({ fetchImpl }).embedOne("x")).rejects.toBeInstanceOf(EmbedUnavailableError);
  });

  it("rejects a wrong-dimension vector rather than storing it", async () => {
    const { fetchImpl } = stub(() => openai([[1, 2]]));
    await expect(new EmbedClient({ dim: 4, fetchImpl }).embedOne("x")).rejects.toThrow(/4-dimension/);
  });

  it("reports a non-2xx (model not pulled) as unavailable", async () => {
    const { fetchImpl } = stub(() => ({ error: { message: 'model "nomic-embed-text" not found' } }), false, 404);
    await expect(new EmbedClient({ fetchImpl }).embedOne("x")).rejects.toThrow(/404/);
  });
});

describe("resolveLocalModelUrl", () => {
  it("takes METISTRY_LOCAL_MODEL_URL over everything else, with no warning", () => {
    const r = resolveLocalModelUrl({ [LOCAL_MODEL_URL_VAR]: "http://127.0.0.1:8080/v1", [OLLAMA_URL_VAR]: "http://127.0.0.1:11434" }, "http://127.0.0.1:1234/v1");
    expect(r).toEqual({ url: "http://127.0.0.1:8080/v1", from: "env" });
  });

  it("still honours METISTRY_OLLAMA_URL, maps a bare host onto /v1, and says it is deprecated", () => {
    const r = resolveLocalModelUrl({ [OLLAMA_URL_VAR]: "http://127.0.0.1:11434" });
    expect(r.url).toBe("http://127.0.0.1:11434/v1");
    expect(r.from).toBe("alias");
    expect(r.warning).toMatch(/METISTRY_OLLAMA_URL is deprecated/);
    expect(r.warning).toContain(LOCAL_MODEL_URL_VAR);
  });

  it("does not append /v1 twice when the alias already names the API root", () => {
    expect(resolveLocalModelUrl({ [OLLAMA_URL_VAR]: "http://127.0.0.1:11434/v1/" }).url).toBe("http://127.0.0.1:11434/v1");
  });

  it("falls back to compute.yaml's first on_machine provider, then to a default Ollama", () => {
    expect(resolveLocalModelUrl({}, "http://127.0.0.1:1234/v1")).toEqual({ url: "http://127.0.0.1:1234/v1", from: "compute.yaml" });
    expect(resolveLocalModelUrl({})).toEqual({ url: EMBED_DEFAULT_URL, from: "default" });
    expect(EMBED_DEFAULT_URL).toMatch(/\/v1$/);
  });

  it("ignores an empty or whitespace-only variable rather than dialling nowhere", () => {
    expect(resolveLocalModelUrl({ [LOCAL_MODEL_URL_VAR]: "   ", [OLLAMA_URL_VAR]: "" }, undefined).from).toBe("default");
  });

  it("apiRootOf leaves a path alone and trims trailing slashes", () => {
    expect(apiRootOf("http://h:1/v1//")).toBe("http://h:1/v1");
    expect(apiRootOf("http://h:1/")).toBe("http://h:1/v1");
    expect(apiRootOf("not a url")).toBe("not a url");
  });
});

describe("vectorLiteral", () => {
  it("renders pgvector's literal form", () => {
    expect(vectorLiteral([1, -0.5, 0])).toBe("[1,-0.5,0]");
  });
});
