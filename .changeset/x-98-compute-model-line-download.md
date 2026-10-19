---
"@metistry-apps/macos": patch
---

Agents and Compute, three small gaps (X-98). The Agents model dropdown labels a model with the one line the Compute pane writes (name, provider, the provider's tag), not `model — provider`: both ask the same `ComputeModelLine`, so a model reads the same wherever the catalogue is absent. The wizard's key note now describes the T4-18 path: the key is one of this instance's own secrets, granted to its provider, and compute.yaml holds only a reference to it. A model download in the Compute pane shows its size and progress as the CLI printed them (nothing is invented when it prints none) and offers Cancel Download, which ends the CLI process that started it (`ProcessCommandRunner` now terminates its child when the calling task is cancelled).
