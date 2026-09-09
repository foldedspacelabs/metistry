import { fileURLToPath } from "node:url";
import { intEnv, optionalEnv, requireEnv } from "@foldedspacelabs/metistry-core";
import { Helper, defaultSpawner } from "./helper.js";
import { makeBridge } from "./index.js";

// standalone-usable by a stranger (§4.16): config from env only
const binary = optionalEnv("METISTRY_AFM_HELPER", fileURLToPath(new URL("../helper/afm-helper.app/Contents/MacOS/afm-helper", import.meta.url)));
const helper = new Helper(defaultSpawner(binary));
const server = makeBridge(helper, { token: requireEnv("METISTRY_BRIDGE_TOKEN_APPLE_FM") });

const host = optionalEnv("METISTRY_AFM_HOST", "127.0.0.1");
const port = intEnv("METISTRY_AFM_PORT", 7810);
server.listen(port, host, () => console.log(`apple-fm bridge on ${host}:${port} (helper: ${binary})`));
