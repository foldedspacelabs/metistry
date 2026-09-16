// PoC-19 measurement harness. Zero dependencies (no new deps for a PoC), so
// the JSON Schema check below is hand-rolled over exactly the keywords the
// three cases use — enough to prove the model's output obeys the schema the
// CALLER supplied, which is the whole question.
//
//   node bench.mjs                                   # Apple FM on :7841
//   node bench.mjs --base-url http://127.0.0.1:1234/v1 --model google/gemma-4-e4b --label lmstudio
//
// Writes runs/<label>.jsonl (one row per request) and prints the summary table.

const args = Object.fromEntries(
  process.argv.slice(2).flatMap((a, i, all) => (a.startsWith("--") ? [[a.slice(2), all[i + 1]]] : [])),
);
const baseUrl = args["base-url"] ?? "http://127.0.0.1:7841/v1";
const model = args.model ?? "apple/foundation-model";
const label = args.label ?? "applefm";
const n = Number(args.n ?? 20);

// ---------------------------------------------------------------- the 3 cases

const classificationSchema = {
  type: "object",
  properties: {
    category: { type: "string", enum: ["todo", "event", "idea", "link", "note"], description: "The single best category." },
    has_action: { type: "boolean", description: "true ONLY if the item states a concrete task the user must personally do." },
    action: { type: "string", description: "A short imperative action phrase of at most 8 words, or the empty string." },
  },
  required: ["category", "has_action", "action"],
  additionalProperties: false,
};

const meetingSchema = {
  type: "object",
  properties: {
    summary: { type: "string", description: "One sentence." },
    attendees: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 6, description: "People named." },
    action_items: {
      type: "array",
      minItems: 1,
      maxItems: 4,
      items: {
        type: "object",
        properties: {
          owner: { type: "string" },
          task: { type: "string" },
          due: { type: "string", description: "A day name, or the empty string." },
          priority: { type: "string", enum: ["low", "medium", "high"] },
        },
        required: ["owner", "task", "due", "priority"],
        additionalProperties: false,
      },
    },
  },
  required: ["summary", "attendees", "action_items"],
  additionalProperties: false,
};

const cases = [
  {
    id: "a-text",
    what: "plain text, no schema",
    system: "Answer in one short sentence.",
    user: "What is the capital of France?",
    schema: null,
  },
  {
    id: "b-classify",
    what: "3-field classification schema",
    system: "You classify short personal-inbox capture items.",
    user: "grocery: pick up milk and bread tomorrow before 6pm",
    schema: classificationSchema,
  },
  {
    id: "c-nested",
    what: "nested schema with two arrays",
    system: "You extract structure from a short meeting note.",
    user: "Standup Tuesday: Priya will ship the export fix by Thursday, Sam is blocked on the VPN, and we agreed to move the retro to Friday.",
    schema: meetingSchema,
  },
];

// ------------------------------------------------------- hand-rolled validator

function validate(schema, value, path = "$", errs = []) {
  if (schema.enum) {
    if (!schema.enum.includes(value)) errs.push(`${path}: ${JSON.stringify(value)} not one of ${schema.enum.join("|")}`);
    return errs;
  }
  switch (schema.type) {
    case "object": {
      if (value === null || typeof value !== "object" || Array.isArray(value)) return errs.push(`${path}: not an object`), errs;
      for (const k of schema.required ?? []) if (!(k in value)) errs.push(`${path}.${k}: required but missing`);
      if (schema.additionalProperties === false)
        for (const k of Object.keys(value)) if (!(k in (schema.properties ?? {}))) errs.push(`${path}.${k}: not in the schema`);
      for (const [k, sub] of Object.entries(schema.properties ?? {})) if (k in value) validate(sub, value[k], `${path}.${k}`, errs);
      return errs;
    }
    case "array": {
      if (!Array.isArray(value)) return errs.push(`${path}: not an array`), errs;
      if (schema.minItems != null && value.length < schema.minItems) errs.push(`${path}: ${value.length} items < minItems ${schema.minItems}`);
      if (schema.maxItems != null && value.length > schema.maxItems) errs.push(`${path}: ${value.length} items > maxItems ${schema.maxItems}`);
      value.forEach((v, i) => validate(schema.items, v, `${path}[${i}]`, errs));
      return errs;
    }
    case "string":
      if (typeof value !== "string") errs.push(`${path}: not a string`);
      return errs;
    case "boolean":
      if (typeof value !== "boolean") errs.push(`${path}: not a boolean`);
      return errs;
    case "integer":
      if (!Number.isInteger(value)) errs.push(`${path}: not an integer`);
      return errs;
    case "number":
      if (typeof value !== "number") errs.push(`${path}: not a number`);
      return errs;
    default:
      return errs;
  }
}

// ------------------------------------------------------------------- the runs

const pct = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
const round = (x) => Math.round(x * 10) / 10;

const rows = [];
const summary = [];

for (const c of cases) {
  const body = {
    model,
    messages: [
      { role: "system", content: c.system },
      { role: "user", content: c.user },
    ],
    ...(c.schema ? { response_format: { type: "json_schema", json_schema: { name: c.id, strict: true, schema: c.schema } } } : {}),
  };

  const latencies = [];
  let ok = 0,
    schemaValid = 0;
  const outputs = new Set();

  for (let i = 0; i < n; i++) {
    const t0 = performance.now();
    let content = null,
      error = null,
      usage = null,
      xm = null;
    try {
      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (!res.ok) error = JSON.stringify(json).slice(0, 300);
      else {
        content = json.choices?.[0]?.message?.content ?? "";
        usage = json.usage ?? null;
        xm = json.x_metistry ?? null;
      }
    } catch (e) {
      error = String(e);
    }
    const ms = performance.now() - t0;
    latencies.push(ms);

    let valid = null,
      errs = [];
    if (content !== null) {
      ok++;
      outputs.add(content.trim());
      if (c.schema) {
        try {
          errs = validate(c.schema, JSON.parse(content));
          valid = errs.length === 0;
        } catch (e) {
          valid = false;
          errs = [`not JSON: ${e.message}`];
        }
        if (valid) schemaValid++;
      }
    }
    rows.push({ label, case: c.id, i, ms: round(ms), ok: content !== null, valid, errs, content, usage, x_metistry: xm, error });
    process.stdout.write(content === null ? "x" : valid === false ? "!" : ".");
  }
  process.stdout.write("\n");

  const sorted = [...latencies].sort((a, b) => a - b);
  summary.push({
    case: c.id,
    what: c.what,
    n,
    ok: `${ok}/${n}`,
    schema_valid: c.schema ? `${schemaValid}/${n}` : "n/a",
    distinct_outputs: outputs.size,
    p50_ms: round(pct(sorted, 50)),
    p95_ms: round(pct(sorted, 95)),
    min_ms: round(sorted[0]),
    max_ms: round(sorted[sorted.length - 1]),
  });
}

const { writeFileSync, mkdirSync } = await import("node:fs");
mkdirSync("runs", { recursive: true });
writeFileSync(`runs/${label}.jsonl`, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");

console.log(`\n${label} — ${baseUrl} — model ${model}`);
console.table(summary);
writeFileSync(`runs/${label}-summary.json`, JSON.stringify(summary, null, 2) + "\n");
