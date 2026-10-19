// No console code mints an enrolment code (plan §2.22, X-75). The route table
// has no row for it (packages/core's client-api test) and the conformance
// test holds the server to that table; this file closes the last gap — a
// handler that mints as a side effect of some other route. The function
// exists in the console's store only as a re-export for the two callers that
// are allowed to use it: `metistry enroll` (packages/cli) and
// scripts/enroll.mjs, both of which run on the Mac with shell access, which is
// the root of trust for a first passkey (plan §4.2).
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = fileURLToPath(new URL("../src/", import.meta.url));

function* sources(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) yield* sources(p);
    else if (/\.(ts|js|mjs)$/.test(entry.name)) yield p;
  }
}

describe("the console never mints an enrolment code", () => {
  it("no source file calls mintEnrollmentCode — the store only re-exports it", () => {
    const callers: string[] = [];
    for (const file of sources(SRC)) {
      const text = readFileSync(file, "utf8");
      if (/\bmintEnrollmentCode\s*\(/.test(text)) callers.push(file.slice(SRC.length));
    }
    expect(callers).toEqual([]);
  });

  it("no source file writes auth_enrollment_codes itself — every touch goes through core's one module", () => {
    const writers: string[] = [];
    for (const file of sources(SRC)) {
      const text = readFileSync(file, "utf8");
      if (/\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+auth_enrollment_codes\b/i.test(text)) writers.push(file.slice(SRC.length));
    }
    expect(writers).toEqual([]);
  });
});
