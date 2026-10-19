---
"@foldedspacelabs/metistry-cli": minor
---

The Tailscale adapter (plan §2.23, X-106) — Funnel by default, tailnet as the
alternative. `metistry remote set tailscale` brings a node onto the owner's
tailnet, signs it in through Tailscale's own login page (completion read from
`BackendState`, never a credential), surfaces each one-click approval page
(HTTPS, Funnel) as the flow's one step, runs `tailscale funnel` (or `serve`)
to the console's PROXY listener — never the main port — and waits for the
public name, then for the origin to answer from this Mac, before the record is
written. The node is the owner's running Tailscale app when there is one, else
X-112's bundled unprivileged `tailscaled` (userspace networking, state 0700
under the instance, its own launchd job, named `metistry-<instance>`), behind
one switch (`--use-app` / `--bundled`). Funnel refuses to configure unless
the proxy listener answers with X-111's hardening headers. Doctor gains the
Tailscale rows (node, signed in, state dir, HTTPS, Funnel, the live handler —
`failed` at the main port — public name, key expiry); revoke resets the
handler, logs the bundled node out, stops it and removes its state, and names
the admin-console entry left for the owner. `launchd.ts` gains
`renderAgentPlist`; the upstream classifier moves to `remote/upstream.ts`.
