import { intEnv, optionalEnv, requireEnv } from "@foldedspacelabs/metistry-core";
import { DEFAULT_HELPER_TIMEOUT_MS, Helper } from "./helper.js";
import { makeBridge } from "./index.js";

// The helper is a SEPARATE launchd service (TCC root binary); we only connect.
// Standalone-usable (§4.16): config from env only.
const helper = new Helper(optionalEnv("METISTRY_LC_SOCKET", "/tmp/metistry-live-capture.sock"), intEnv("METISTRY_LC_HELPER_TIMEOUT_MS", DEFAULT_HELPER_TIMEOUT_MS));
const server = makeBridge(helper, {
  token: requireEnv("METISTRY_BRIDGE_TOKEN_LIVE_CAPTURE"),
  controlToken: requireEnv("METISTRY_LIVE_CAPTURE_CONTROL_TOKEN"),
});

const host = optionalEnv("METISTRY_LC_HOST", "127.0.0.1");
const port = intEnv("METISTRY_LC_PORT", 7815);
server.listen(port, host, () => console.log(`live-capture bridge on ${host}:${port}`));
