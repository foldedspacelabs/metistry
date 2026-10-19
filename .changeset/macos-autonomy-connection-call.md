---
"@metistry-apps/macos": patch
---

Fix: the permissions editor carries every autonomy kind core has — `connection_call`, the fifth, included, with core's own ceiling (`propose` at every level, never `allow`). The app's `AgentAutonomy` had four kinds, so a stored `connection_call: deny` was dropped on read and absent from the `PUT /api/agents/:id/autonomy` body — and the body **replaces** the record, so editing a folder, a project or another kind's mode silently turned asking back on, a widening the confirm sheet never listed. Now the record is read whole (a kind this build does not know rides back unchanged), the body sends it whole, `widenings` names `actions.connection_call deny → propose` like the others, the editor draws the fifth row and offers only the modes the kind can reach. Tests: a stored deny survives an unrelated edit; the fifth kind's widening, ceiling and defaults match core's cases; an unknown sixth kind round-trips; the editor draws a row per kind.
