// Regenerates `test/fixtures/generate/recording.jsonl` from the fake models,
// after `pnpm --filter @metistry-apps/eval build`:
//
//   node --experimental-strip-types test/helpers/record-fake-generation.ts
//
// The recording is what `generate.test.ts` replays; it changes only when the
// prompts or the fakes do, and this script is how it changes.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { recordingFetch } from "../../dist/complexity.js";
import { generateComplexityFixtures } from "../../dist/generate.js";
import { FAKE_RELABELLER, FAKE_WRITER, fakeGeneratorFetch } from "./fake-generator-models.ts";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "..", "fixtures", "generate", "recording.jsonl");
const lines: string[] = [];
const fetchFn = recordingFetch(fakeGeneratorFetch(FAKE_RELABELLER), (call) => lines.push(JSON.stringify(call)));
const result = await generateComplexityFixtures({ config: { baseUrl: "https://fake.invalid/v1", writer: FAKE_WRITER, relabeller: FAKE_RELABELLER }, fetchFn });
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${lines.join("\n")}\n`);
process.stdout.write(`${lines.length} recorded call(s) → ${out}; kept ${result.kept.length}, pile ${result.pile.length}, dropped ${result.dropped.length}\n`);
