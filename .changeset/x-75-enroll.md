---
"@foldedspacelabs/metistry-cli": minor
"@foldedspacelabs/metistry-core": minor
"@metistry-apps/console": patch
---

`metistry enroll` — add a phone (plan §2.22, M19). Mints a one-time,
ten-minute passkey enrolment code on this Mac and prints
`<first METISTRY_ORIGIN entry>/#enroll=<code>`; `--json` writes exactly one
document `{url, code_id, origin, expires_at}`; `--cancel <code_id>` expires
an unused code at once. It refuses BEFORE minting — and writes no row — when
the phone cannot complete the ceremony against that origin: a loopback host
(every install's default), `http:`, an IP literal, or an origin this Mac
cannot reach within 5 s or that names another instance; each refusal in its
own words, naming `METISTRY_ORIGIN` and the fix. No HTTP route mints a code
(a test holds the route table to it). Core gains `enrollment-codes.ts`
(mint / peek / consume / cancel) and `owner-tokens.ts` (mint / check /
register) so the console, the CLI and `enroll.mjs` run one implementation;
the console's `mintEnrollmentCode` now returns `{code, code_id, expires_at}`.
