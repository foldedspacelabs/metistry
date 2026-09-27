---
"@foldedspacelabs/metistry-cli": patch
---

`metistry console session --stdio` attaches to stdin before it resolves the console target and token, so a request line written the moment the process is spawned (the Mac app's `SessionConsoleCallTransport`) is held and answered instead of being lost and left to time out. A refusal (no token, a non-loopback console) still sends none of the held lines, writes nothing to stdout and never prints the token.
