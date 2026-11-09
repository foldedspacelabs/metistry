#!/usr/bin/env node
// Host-side enrollment (§4.2): shell access to the host IS the root of
// trust. Mints a one-time, 10-minute passkey enrollment code and prints
// the URL to open on the device. `metistry enroll` is the verb for this
// (plan §2.22, M19) — it checks METISTRY_ORIGIN first and refuses an origin
// a phone cannot complete the ceremony against; this script stays for the
// compose shape and for `--owner-token`, and its enrolment path calls the
// SAME `mintEnrollmentCode` (packages/core), so the two can never disagree.
// Also mints owner access tokens: `pnpm enroll --owner-token "<label>"`.

import { mintEnrollmentCode, mintOwnerToken } from "../dist/auth-store.js";
import { makePool } from "../dist/db.js";

const pool = makePool();
const origin = (process.env.METISTRY_ORIGIN ?? "http://127.0.0.1:8080").split(",")[0].trim().replace(/\/+$/, "");

const flag = process.argv.indexOf("--owner-token");
if (flag !== -1) {
  const label = process.argv[flag + 1] ?? "cli";
  const token = await mintOwnerToken(pool, label);
  console.log(`owner token (${label}) — store it now; it is not retrievable later:\n${token}`);
} else {
  const minted = await mintEnrollmentCode(pool);
  console.log(`open on the device to enroll (valid 10 min, single use):\n${origin}/#enroll=${minted.code}`);
  console.log(`code id ${minted.code_id} — \`metistry enroll --cancel ${minted.code_id}\` kills it early`);
}
await pool.end();
