// Two FAKE models for the generator's tests — SYNTHETIC throughout, never an
// eval fixture. The "writer" answers each class request with numbered
// placeholder messages whose lengths follow the same schedule in every class
// (so length says nothing about the label); the "relabeller" reads the class
// name back out of each placeholder and disagrees on a fixed schedule — an
// adjacent class every eleventh item, the opposite class every seventeenth,
// no answer at all for a `moderate` seventeenth (there is no class two apart
// from the middle one). Deterministic, so a recording of it replays exactly
// and the checked-in `fixtures/generate/recording.jsonl` is reproducible:
//
//   node --experimental-strip-types test/helpers/record-fake-generation.ts
//
// No import from `src/`: the recorder script runs this file under Node's type
// stripping, outside vitest.

const NAMES = ["simple", "moderate", "demanding"] as const;
type Name = (typeof NAMES)[number];

const filler = (n: number, seed: string): string => Array.from({ length: n }, (_, i) => `${seed}${i}`).join(" ");

/** Words for item k, the same in every class: eight long, eight short, the rest 10–32. */
function lengthFor(k: number): number {
  if (k < 8) return 45;
  if (k < 16) return 6;
  return 10 + (k % 23);
}

export function fakeWriterItems(label: Name, count: number, d08: number): Array<{ text: string; d08: boolean }> {
  const plain = count - d08;
  const items: Array<{ text: string; d08: boolean }> = [];
  for (let k = 0; k < plain; k++) {
    const head = `synthetic ${label} item ${k}`;
    const words = Math.max(lengthFor(k), 4);
    items.push({ text: words > 4 ? `${head} ${filler(words - 4, `${label[0]}${k}w`)}` : head, d08: false });
  }
  for (let k = 0; k < d08; k++) items.push({ text: `synthetic d08 ${label} item ${k} ${filler(2 + (k % 4), `x${k}`)}`, d08: true });
  // one exact duplicate, so the generator's dedupe has something to drop
  if (label === "simple" && items.length > 0) items.push({ ...items[0]! });
  return items;
}

const ADJACENT: Record<Name, Name> = { simple: "moderate", moderate: "demanding", demanding: "moderate" };
const OPPOSITE: Partial<Record<Name, Name>> = { simple: "demanding", demanding: "simple" };

/** The relabeller's class for one placeholder, or `null` for "no answer". */
export function fakeRelabel(text: string): Name | null {
  const m = /^synthetic (d08 )?(simple|moderate|demanding) item (\d+)/.exec(text);
  if (!m) return null;
  const label = m[2] as Name;
  const k = Number(m[3]);
  if (m[1]) return label; // D08-class: the models agree; the pile takes them anyway
  if (k > 0 && k % 17 === 0) return OPPOSITE[label] ?? null;
  if (k > 0 && k % 11 === 0) return ADJACENT[label];
  return label;
}

interface ChatBody {
  model: string;
  messages: Array<{ role: string; content: string }>;
}

/**
 * A `fetch` that plays both models. The writer is whichever model id the
 * request names that is not the relabeller's; the request's own text says
 * which class and how many.
 */
export function fakeGeneratorFetch(relabellerModel: string): typeof fetch {
  return (async (_url: string, init: { body?: unknown }) => {
    const body = JSON.parse(String(init.body)) as ChatBody;
    const user = body.messages.find((m) => m.role === "user")?.content ?? "";
    let reply: unknown;
    if (body.model === relabellerModel) {
      const labels: Array<{ i: number; label: Name }> = [];
      for (const line of user.split("\n")) {
        const m = /^(\d+)\. (".*")$/.exec(line);
        if (!m) continue;
        const label = fakeRelabel(JSON.parse(m[2]!) as string);
        if (label) labels.push({ i: Number(m[1]), label });
      }
      reply = { labels };
    } else {
      const count = Number(/Write (\d+) different messages/.exec(user)?.[1] ?? "0");
      const label = /call "(simple|moderate|demanding)"/.exec(user)?.[1] as Name | undefined;
      const d08 = Number(/Exactly (\d+) of them must be/.exec(user)?.[1] ?? "0");
      if (!label) throw new Error(`fake writer: no class in the request: ${user.slice(0, 120)}`);
      reply = { items: fakeWriterItems(label, count, d08) };
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(reply) } }] }), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
}

export const FAKE_WRITER = "google/gemma-4-fake";
export const FAKE_RELABELLER = "qwen/qwen-4-fake";
