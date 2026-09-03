import { intEnv, optionalEnv, requireEnv } from "@foldedspacelabs/metistry-core";
import { Helper } from "./helper.js";
import { makeBridge } from "./index.js";

// The helper is a SEPARATE launchd service (TCC root binary); we only connect.
const helper = new Helper(optionalEnv("METISTRY_EK_SOCKET", "/tmp/metistry-eventkit.sock"));
const server = makeBridge(helper, { token: requireEnv("METISTRY_BRIDGE_TOKEN_EVENTKIT") });

const host = optionalEnv("METISTRY_EK_HOST", "127.0.0.1");
const port = intEnv("METISTRY_EK_PORT", 7811);
server.listen(port, host, () => console.log(`eventkit bridge on ${host}:${port}`));
