---
"@foldedspacelabs/metistry-cli": patch
---

The Mac app gets Settings, a first-launch wizard, and a menu bar worth
opening. Settings lives in the `Settings` scene (⌘, and the app menu) with
six panes, and every value on them is a front for a file the CLI owns — the
app persists three pointers (active instance, recents, a developer runtime
override) and no configuration, asserted by a test over its whole defaults
domain. The product-directory preference is gone: a shipped app's product is
the runtime inside its own bundle. The wizard replaces the "First run" tab
group with a sheet over the same seven steps, Back/Continue/Skip, every
choice stating what it gets you and what it costs. The menu bar groups
components by doctor's own `kind` with Restart/Stop/Start/View Log per
component and Restart All/Stop All above them, refreshing on open and every
30s while open. The lifecycle verbs (`restart`, `stop`, `start`, `logs`) land
separately; until they do the app says "this CLI has no `restart` verb yet —
update it" rather than reporting a failed restart.
