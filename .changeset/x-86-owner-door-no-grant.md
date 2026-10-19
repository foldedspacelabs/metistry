---
"@metistry-apps/macos": patch
---

Fix: Settings ▸ Secrets no longer offers Grant rows for an owner-door secret
(`github_write`). The tool already refuses any connection or agent grant for
it, so the rows could only fail; the pane now says the secret is read only
through its own door, and keeps its Sent Only To hosts, Replace and Delete.
