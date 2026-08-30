#!/usr/bin/env node
// Host-side enrollment (§4.2): shell access to the host IS the root of
// trust. Mints a one-time, 10-minute passkey enrollment code and prints
// the URL to open on the device. (`metistry enroll` wraps this later;
// QR rendering arrives with packages/cli.)
// Also mints owner access tokens: `pnpm enroll --owner-token "<label>"`.

import { mintEnrollmentCode, mintOwnerToken } from "../dist/auth-store.js";
import { makePool } from "../dist/db.js";

const pool = makePool();
const origin = process.env.METISTRY_ORIGIN ?? "http://127.0.0.1:8080";

const flag = process.argv.indexOf("--owner-token");
if (flag !== -1) {
  const label = process.argv[flag + 1] ?? "cli";
  const token = await mintOwnerToken(pool, label);
  console.log(`owner token (${label}) — store it now; it is not retrievable later:\n${token}`);
} else {
  const code = await mintEnrollmentCode(pool);
  console.log(`open on the device to enroll (valid 10 min, single use):\n${origin}/#enroll=${code}`);
}
await pool.end();
