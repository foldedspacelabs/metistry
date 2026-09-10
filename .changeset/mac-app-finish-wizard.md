---
"@metistry-apps/macos": minor
---

The Mac app finishes its first run. All seven wizard steps now do something:
step 1 installs the bundled runtime to a writable product directory, step 5 sets
the deployment shape after showing you what it would do, step 6 enrols a passkey
or says precisely why this install's origin cannot host a native one, and step 7
guides the Claude sign-in in a real terminal and watches for the token to land.
Settings gains a working "Start at login", and shows the instance id, the
assistant's name, the versions and the secret list by asking the CLI rather than
by reading its files.
