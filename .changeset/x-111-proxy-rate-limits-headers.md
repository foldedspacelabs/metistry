---
"@metistry-apps/console": minor
---

The console's proxy listener is ready for the internet (plan §2.23, X-111).
Every answer it gives without a session — the PWA shell, `GET /health`, `GET
/api/identity`, the four passkey ceremonies, a wrong `Host`, and every `401`
— is rate-limited per client and under a global ceiling: `429 rate_limited`
with `Retry-After`, and one `runs` row (`kind=auth, tool=rate_limited`) per
refused burst. The client is the last entry of the provider's client-address
header (`METISTRY_CONSOLE_PROXY_CLIENT_HEADER`, default `x-forwarded-for`),
read on the proxy listener alone and for limiting alone — no credential
decision reads any forwarded header, and a request a credential admits is
never limited. Limits: `METISTRY_CONSOLE_PROXY_CLIENT_LIMIT` (120),
`METISTRY_CONSOLE_PROXY_GLOBAL_LIMIT` (1200), per
`METISTRY_CONSOLE_PROXY_WINDOW_S` (60). Every proxy-listener answer also
carries HSTS (no preload), a CSP written for the shell, `X-Content-Type-Options:
nosniff`, `Referrer-Policy: no-referrer` and `X-Frame-Options: DENY`. The main
listener is unchanged: no limit, no headers, and a forwarded-address header
there changes nothing.
