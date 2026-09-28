import { intEnv, optionalEnv, requireEnv, resolveUrl } from "@foldedspacelabs/metistry-core";
import { DEFAULT_HELPER_TIMEOUT_MS, Helper } from "./helper.js";
import { makeBridge } from "./index.js";

// The helper is a SEPARATE launchd service (TCC root binary); we only connect.
// Standalone-usable (§4.16): config from env only.
const helper = new Helper(optionalEnv("METISTRY_LC_SOCKET", "/tmp/metistry-live-capture.sock"), intEnv("METISTRY_LC_HELPER_TIMEOUT_MS", DEFAULT_HELPER_TIMEOUT_MS));

// Where an ended session's transcript goes (T8-2b): the console's POST
// /capture, from this Mac — so a compose install's `http://console:8080` is
// read from the host's side (core's one resolver). No inbox token, no
// delivery: transcripts stay under the capture directory and `check` says so.
const inboxToken = optionalEnv("METISTRY_LIVE_CAPTURE_INBOX_TOKEN", "");
const consoleUrl = resolveUrl(
  optionalEnv("METISTRY_LC_CONSOLE_URL", optionalEnv("METISTRY_CONSOLE_URL", `http://127.0.0.1:${intEnv("METISTRY_CONSOLE_PORT", 8080)}`)),
  { shape: "launchd", vantage: "host" },
);

const server = makeBridge(helper, {
  token: requireEnv("METISTRY_BRIDGE_TOKEN_LIVE_CAPTURE"),
  controlToken: requireEnv("METISTRY_LIVE_CAPTURE_CONTROL_TOKEN"),
  ...(inboxToken ? { delivery: { consoleUrl, inboxToken } } : {}),
});

const host = optionalEnv("METISTRY_LC_HOST", "127.0.0.1");
const port = intEnv("METISTRY_LC_PORT", 7815);
server.listen(port, host, () => console.log(`live-capture bridge on ${host}:${port}; transcripts ${inboxToken ? `to ${consoleUrl}/capture` : "kept on this Mac (no METISTRY_LIVE_CAPTURE_INBOX_TOKEN)"}`));

// The owner's Stop delivers at once (index.ts). This loop is for every other
// end — the ten-hour stop, the disk, a failed wake, a crash the helper found
// when it restarted — and for a console that was down or refused: whatever is
// owed goes on the next pass. Once at start, then every minute.
const deliverer = server.deliverer;
if (deliverer) {
  const sweep = () =>
    void deliverer.sweep().then(
      (s) => s.last_error && console.log(`live-capture delivery: ${s.owed} owed — ${s.last_error}`),
      (err) => console.log(`live-capture delivery: ${err instanceof Error ? err.message : String(err)}`),
    );
  sweep();
  // limit: fixed — a minute is soon enough for a transcript nobody is waiting on, and costs one socket round trip when nothing is owed
  setInterval(sweep, 60_000).unref();
}
