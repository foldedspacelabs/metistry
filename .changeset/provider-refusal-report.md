---
"@metistry-apps/assistant": patch
"@foldedspacelabs/metistry-core": patch
---

**A provider that refuses the account becomes one Needs You report, not retries.** A `402` (out of credits) or `401`/`403` (the key) from the provider a turn is assigned to is no longer tried again — not by the stale-session fallback, not by a crew's attempts. The message fails with the provider's own words instead of *that turn failed*, and one `report` is raised per (provider, error class) while one waits: *openrouter: out of credits — top up at https://openrouter.ai/settings/credits; N turns waiting*. While it waits the provider is paused — its turns are held (`inbound_messages.status = 'held'`), counted on the report, and released oldest first when the report is dismissed or a later turn gets through (one is tried every ten minutes). And every chat completion now carries `max_tokens`: an assignment's new `max_output_tokens` in `compute.yaml`, default 8192, which a provider's `request:` block may lower but never raise — so a turn no longer reserves the model's whole 65,536-token window.
