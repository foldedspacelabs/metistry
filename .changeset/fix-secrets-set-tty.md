---
"@foldedspacelabs/metistry-cli": patch
---

Fix: `metistry secrets set|replace` no longer hangs when typed by hand in a
terminal. Both read the value's whole stdin to EOF, which a terminal never
sends after Enter — a script's pipe worked, but an owner typing the value
interactively would press Enter and the command would sit there until the
exec timeout killed it. Run with nothing piped in, they now prompt on
stderr and read one line with the terminal's echo off (backspace edits it,
Ctrl-C cancels, Ctrl-D on an empty line is an empty value); piped stdin is
unchanged.
