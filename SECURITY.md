# Security policy

Metistry is built so that its security survives full code visibility
(invariant 8 in `CLAUDE.md`): every boundary authenticates as if it were
internet-exposed, and every door ships with its misuse tests. A way around
one of those boundaries is exactly the report we want.

## Reporting a vulnerability

**Report privately through GitHub:** on this repository, open the
**Security** tab and choose **Report a vulnerability** (GitHub's private
vulnerability reporting). Please do not open a public issue, pull request or
discussion for a suspected vulnerability.

A useful report says what you did, what happened, what you expected, and the
version (`metistry --version`, or the Mac app's About window). A failing test
or a minimal reproduction is the best form of all.

What to expect:

- an acknowledgement within a week;
- a fix, or a reasoned decision, discussed with you in the private advisory;
- credit in the advisory and the release notes, if you want it.

There is **no bug bounty** — Metistry is free software maintained by one
person, and there is no budget to pay one.

## Scope

In scope: this repository's code and its release artifacts — the Mac app
(DMG and its Sparkle feed), the runtime packs, the npm packages under
`@foldedspacelabs/metistry-*` and the container images.

Out of scope: an instance someone runs themselves (Metistry operates no
service), third-party MCP servers or model providers you connect to it, and
findings that need an attacker who already controls the owner's Mac account.

## Supported versions

Only the latest release receives security fixes. Metistry is pre-1.0; update
through the Mac app or `metistry update`.
