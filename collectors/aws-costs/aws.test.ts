import { describe, expect, it } from "vitest";
import { signV4 } from "./sigv4.js";
import { run } from "./run.js";

describe("sigv4", () => {
  it("matches AWS's published GET example (IAM ListUsers, 2015-08-30)", () => {
    const h = signV4(
      {
        method: "GET",
        url: "https://iam.amazonaws.com/?Action=ListUsers&Version=2010-05-08",
        headers: { host: "iam.amazonaws.com", "content-type": "application/x-www-form-urlencoded; charset=utf-8" },
        body: "",
        region: "us-east-1",
        service: "iam",
        now: new Date("2015-08-30T12:36:00Z"),
      },
      { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY" },
    );
    expect(h["x-amz-date"]).toBe("20150830T123600Z");
    expect(h.authorization).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/iam/aws4_request, SignedHeaders=content-type;host;x-amz-date, Signature=5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7",
    );
  });

  it("adds the session token header when present and signs it", () => {
    const h = signV4(
      { method: "POST", url: "https://ce.us-east-1.amazonaws.com/", headers: { host: "ce.us-east-1.amazonaws.com" }, body: "{}", region: "us-east-1", service: "ce", now: new Date("2026-09-06T00:00:00Z") },
      { accessKeyId: "a", secretAccessKey: "s", sessionToken: "tok" },
    );
    expect(h["x-amz-security-token"]).toBe("tok");
    expect(h.authorization).toContain("SignedHeaders=host;x-amz-date;x-amz-security-token");
  });
});

function fakeDb() {
  const q: { text: string; values: unknown[] }[] = [];
  return { q, async query(text: string, values: unknown[] = []) { q.push({ text, values }); return { rows: [] }; } };
}

describe("aws-costs collector", () => {
  it("degrades absent without credentials", async () => {
    const db = fakeDb();
    expect(await run(db, {})).toBe(0);
    expect(db.q).toHaveLength(0);
  });

  it("replaces the trailing window with per-service daily rows, skipping zeros", async () => {
    const db = fakeDb();
    let sent: any;
    const fetchFn = (async (_url: string, init: any) => {
      sent = { headers: init.headers, body: JSON.parse(init.body) };
      return {
        ok: true,
        json: async () => ({
          ResultsByTime: [
            { TimePeriod: { Start: "2026-09-03", End: "2026-09-04" }, Groups: [
              { Keys: ["Amazon Simple Storage Service"], Metrics: { UnblendedCost: { Amount: "0.1234", Unit: "USD" } } },
              { Keys: ["AWS Lambda"], Metrics: { UnblendedCost: { Amount: "0", Unit: "USD" } } },
            ] },
            { TimePeriod: { Start: "2026-09-04", End: "2026-09-05" }, Groups: [
              { Keys: ["Amazon Route 53"], Metrics: { UnblendedCost: { Amount: "0.5", Unit: "USD" } } },
            ] },
          ],
        }),
      };
    }) as unknown as typeof fetch;
    const n = await run(db, { aws: { accessKeyId: "a", secretAccessKey: "s" }, fetchFn, now: new Date("2026-09-06T15:00:00Z") });
    expect(n).toBe(2);
    expect(sent.body.TimePeriod).toEqual({ Start: "2026-09-03", End: "2026-09-06" });
    expect(sent.headers["x-amz-target"]).toBe("AWSInsightsIndexService.GetCostAndUsage");
    expect(sent.headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=a\/20260906\/us-east-1\/ce\/aws4_request/);
    const texts = db.q.map((x) => x.text);
    expect(texts[0]).toBe("BEGIN");
    expect(texts[1]).toMatch(/^DELETE FROM metrics/);
    expect(db.q[1]!.values).toEqual(["aws.cost_usd", "2026-09-03", "2026-09-06"]);
    expect(texts.filter((t) => t.startsWith("INSERT INTO metrics"))).toHaveLength(2);
    expect(db.q[2]!.values[3]).toBe(JSON.stringify({ service: "Amazon Simple Storage Service", day: "2026-09-03" }));
    expect(texts.at(-1)).toBe("COMMIT");
  });

  it("rolls back and surfaces an HTTP failure (runner records it)", async () => {
    const db = fakeDb();
    const fetchFn = (async () => ({ ok: false, status: 403, text: async () => "AccessDenied" })) as unknown as typeof fetch;
    await expect(run(db, { aws: { accessKeyId: "a", secretAccessKey: "s" }, fetchFn })).rejects.toThrow(/HTTP 403/);
    expect(db.q.map((x) => x.text)).toEqual([]); // failed before the transaction opened
  });
});
