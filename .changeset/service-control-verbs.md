---
"@foldedspacelabs/metistry-cli": minor
---

`metistry restart|stop|start [<service>…]` and `metistry logs <service>
[--lines N] [--follow]` — the CLI can now act on individual services in
either deployment shape (launchctl kickstart/bootout/bootstrap on the
launchd shape, `docker compose restart|stop|start|logs` on the compose
shape), reusing `up`'s own knowledge of which services are host jobs vs.
containers rather than a second table. No args = every service the current
shape runs; `--json` on `restart`/`stop`/`start` prints
`[{service, action, ok, detail}, …]` for the Mac app's menu bar, which now
calls these verbs instead of shelling out to launchctl/docker itself. An
unknown service name fails with the list of known ones.
