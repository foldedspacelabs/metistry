---
"@foldedspacelabs/metistry-core": minor
"@metistry-apps/console": minor
"@metistry-apps/assistant": minor
---

The router's policy can serve (T9-4, docs/ops/dynamic-router.md §7.3). `rules.yaml` `policy.mode: serve` is no longer refused at load; an install stays in `shadow` until its owner writes `serve`. At serve, on the rules' fall-through only, the console consults the policy before the message is filed, writes the route row first, and files the policy's route (`routed_by: "policy"`, `operation`, `tool_calls`, `policy_row`) — or answers a chosen `fast_path:<query>` itself; a choice whose row cannot be written, and every absent, failing, unmatched or bounded consultation, takes today's route byte for byte. The assistant reads `policy.caps` from its own copy of `rules.yaml`, builds the turn with the operation and the smaller of the row's and the file's `tool_calls`, and the engine enforces the operation's tool allow-list at the call (one fixed refusal, counted) and the `tool_calls`, `tokens` and cost caps between requests (`meta.stopped: max_tool_calls | max_tokens | max_budget`). A budget refusal of the policy's tier falls back once to the rules' default (`meta.route_fallback`). Core adds `operationTools()`.
