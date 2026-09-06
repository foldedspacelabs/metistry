// AWS Signature Version 4 over node:crypto — the whole thing is ~50 lines
// of a stable, published algorithm, which is cheaper to own than the SDK's
// dependency tree (CLAUDE.md: boring primitives, ask before a dependency).
// Verified against AWS's published test vector in aws.test.ts.
import { createHash, createHmac } from "node:crypto";

export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

export interface SignInput {
  method: string;
  url: string; // absolute; query must already be canonical-ordered or empty
  headers: Record<string, string>; // lower-case keys; must include host
  body: string;
  region: string;
  service: string;
  now: Date;
}

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const hmac = (k: Buffer | string, s: string) => createHmac("sha256", k).update(s, "utf8").digest();

export function amzDate(d: Date): string {
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

/** Returns the headers to send: input headers + x-amz-date (+ token) + authorization. */
export function signV4(input: SignInput, creds: AwsCredentials): Record<string, string> {
  const u = new URL(input.url);
  const date = amzDate(input.now);
  const day = date.slice(0, 8);
  const headers: Record<string, string> = { ...input.headers, "x-amz-date": date };
  if (creds.sessionToken) headers["x-amz-security-token"] = creds.sessionToken;

  const signedNames = Object.keys(headers).sort();
  const canonicalHeaders = signedNames.map((k) => `${k}:${headers[k]!.trim().replace(/\s+/g, " ")}\n`).join("");
  const signedHeaders = signedNames.join(";");
  const canonicalQuery = [...u.searchParams.entries()]
    .map(([k, v]) => [encodeURIComponent(k), encodeURIComponent(v)] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  const canonicalRequest = [
    input.method.toUpperCase(),
    u.pathname || "/",
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    sha256(input.body),
  ].join("\n");

  const scope = `${day}/${input.region}/${input.service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", date, scope, sha256(canonicalRequest)].join("\n");
  const kDate = hmac(`AWS4${creds.secretAccessKey}`, day);
  const kRegion = hmac(kDate, input.region);
  const kService = hmac(kRegion, input.service);
  const kSigning = hmac(kService, "aws4_request");
  const signature = createHmac("sha256", kSigning).update(stringToSign, "utf8").digest("hex");

  headers.authorization =
    `AWS4-HMAC-SHA256 Credential=${creds.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return headers;
}
