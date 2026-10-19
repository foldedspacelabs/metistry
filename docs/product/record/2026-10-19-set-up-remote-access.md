- 2026-10-19 — **Setting up remote access is one guided flow, and the phone is
  offered only once this Mac is proven published.** The setup wizard gains a
  Remote Access step between Services and Door, and Settings gains a Remote
  Access pane before Devices; both run the same flow. It opens on the
  question — how should your phone reach this Mac? — with None preselected and
  Tailscale (any browser, through Funnel) marked as the recommended way; a
  provider whose adapter has not shipped is listed and says *Not yet
  available*. Choosing a provider shows, before anything runs, what the CLI
  found and what set-up would change; one button then runs the CLI's own
  ceremony — fetching the provider's tool, opening the provider's own sign-in
  page in the browser, surfacing each one-click approval page the provider
  asks for, pointing it at this Mac, waiting for the public name and for the
  address to answer from here, writing the record, and only then undoing the
  previous choice — with the flow showing where it is and every link it
  printed, and cancellable throughout. The check that follows is said as
  *answers from this Mac*, never as reaching the phone: a Mac on the same
  tailnet can reach a Funnel name without the internet, so the proof from
  outside stays Add a Phone's *Opened on your phone* — which is why Add a
  Phone… appears only after the check passes. Switching away from a provider,
  and Turn Off, confirm first with what the old provider's revoke undoes, what
  is left to remove at the provider, and which phones stop signing in — all in
  the CLI's own words — and Devices marks each passkey bound to a host that is
  no longer configured. The app talks to no provider itself: every act is one
  of a closed set of exact `metistry remote` command shapes, a pasted token
  rides on the command's standard input and is refused in every argument
  spelling, and the switching ceremony belongs to the CLI, which the app only
  drives and shows.
