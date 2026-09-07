---
"@foldedspacelabs/metistry-cli": minor
---

Two install verbs, terminal-first (the Mac app will drive the same ones):
`metistry connect-repo <url>` sets the instance repo's origin, obtains a
git credential the reconciler can push with unattended (GitHub device
flow, a PAT on stdin, or an ssh key) into the macOS login Keychain,
verifies with `ls-remote`, flushes the reconciler's queue and pushes; and
`metistry secrets sync|mint|list` makes the login Keychain the canonical
store (`metistry:<VAR>`) with `.env` generated from it. No secret reaches
argv, output, or `.git/config`.
