---
"@foldedspacelabs/metistry-cli": minor
"@metistry-apps/macos": minor
---

X-107: Set Up Remote Access — the guided flow, the wizard step and Settings ▸
Remote Access (plan §2.23). The Mac app gains a **Remote Access** step between
Services and Door and a **Remote Access** pane in ACCESS before Devices, both
one flow over `metistry remote` (M20): choose (None preselected, Tailscale —
Any browser marked Recommended, unshipped providers listed as *Not yet
available*), then the CLI's own ceremony — the pack, the provider's sign-in
page in the browser, each approval page, the handler, the public name, the
wait for the origin to answer, the protected write, the old provider's revoke
— shown step by step from the lines the CLI prints, with every link it printed
offered to open again; then **Check** (`remote test`, said as *answers from
this Mac*, never as reaching the phone) and only then **Add a Phone…**. The
pane adds **Test** and **Turn Off**, whose confirm names what the provider's
revoke undoes, what is left for the owner at the provider, and which phones
stop signing in — in the CLI's own preview words. A switch away from a
provider confirms the same way before `--yes`. The management runner's M20 row
is a closed grammar of exact argv shapes, never a prefix: a pasted token is
the command's stdin and refused in every argv spelling. Devices marks a
passkey whose host is no longer a configured origin. The CLI: with `--json`,
`remote set`'s step notes and the preview line go to stderr so stdout is the
one document, and the preview carries `revoked` (what the old provider's
revoke would undo) and `stranding` (the sentence about the phones a switch
strands).
