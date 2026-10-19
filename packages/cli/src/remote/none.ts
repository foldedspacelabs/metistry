// None — the default, and the only provider every install has (plan §2.23).
//
// Nothing is exposed: `METISTRY_ORIGIN` stays the loopback origin `init`
// wrote, the proxy listener answers for no host, Add a Phone refuses naming
// Settings ▸ Remote Access (§2.22), and there is no PWA, no web push, no
// capture Shortcut from the phone. A home-network-only mode is deliberately
// not offered: a passkey needs HTTPS and a stable name, which a LAN address
// lacks.
//
// Its `configure` and `revoke` do nothing and succeed; its one doctor row is
// `ok` — an install that exposes nothing is correct, and the row says what
// that means for the phone in the product's voice.

import { runCheck } from "@foldedspacelabs/metistry-core";
import type { Configured, Detection, RemoteContext, RemoteProvider, RemoteRow, Revoked } from "./provider.js";

/** The one sentence None's row carries (§2.23, "Doctor rows"). */
export const NONE_ROW_INFO = "Remote access: none. Your phone can't reach this Mac. Choose a way in Settings ▸ Remote Access.";

export const none: RemoteProvider = {
  id: "none",
  label: "None",

  async detect(ctx: RemoteContext): Promise<Detection> {
    // nothing to have, nothing to sign in to; the only thing choosing it
    // changes is whatever the current provider exposes
    const current = ctx.record.provider;
    return {
      tool: { present: true, from: "in-process" },
      signed_in: null,
      would_change: current === "none" ? [] : [`stop exposing this Mac through ${current}${ctx.record.origin ? ` (${ctx.record.origin})` : ""} — METISTRY_ORIGIN becomes the loopback origin alone`],
    };
  },

  async configure(): Promise<Configured> {
    return { origin: null, settings: {} };
  },

  async status(): Promise<RemoteRow[]> {
    return [
      {
        kind: "remote",
        ...(await runCheck("remote", "deployment.yaml remote: none — nothing exposed, METISTRY_ORIGIN loopback only", async () => ({
          meta: { provider: "none", origin: null, info: NONE_ROW_INFO },
        }))),
      },
    ];
  },

  async revoke(): Promise<Revoked> {
    return { undone: [], left_for_owner: [] };
  },
};
