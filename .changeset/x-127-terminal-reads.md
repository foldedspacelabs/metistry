---
"@foldedspacelabs/metistry-cli": patch
---

X-127: every terminal read in the CLI behaves like `secrets set`. `connect-repo --auth token` no longer tells the owner a token is "never echoed" while the terminal echoes it: in a terminal it prompts on stderr and reads one hidden line (`stdin-value.ts`'s `readHiddenLine`); piped, it is read to EOF as before. `console call --body -` and `agents define --prompt-file -` — a body and a prompt are neither secret nor one line — now say on stderr, never stdout, that the input ends with Ctrl-D, and keep the echo; piped stdin is unchanged. `compute providers add`'s stale "then Ctrl-D" line now says what happens (pipe the key, or paste it at the hidden prompt). `readStdin` moves to `stdin-value.ts` (still exported from the package), and a `Terminal` seam lets a test hand in a fake one.
