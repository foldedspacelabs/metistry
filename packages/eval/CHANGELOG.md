# @metistry-apps/eval

## 0.12.0

### Patch Changes

- 3c966aa: **Captures the rules cannot place are triaged by intent, locally, with the
  decision in `rules.yaml`.** `scoreChoice()` lands beside `completeJson()` —
  same provider resolution, same money rule, different request fields — and
  `inbox-drain` gains a third tier between its rules and its JSON-schema tier:
  one scored answer token over the closed intent enum, on-device, with a
  confidence. The model supplies a fact; a table in the collector and a threshold
  in the owner's own `.metistry/rules.yaml` decide what happens about it. Every
  verdict lands on the proposal and in a `runs` row, including the discarded
  ones. Both halves must be configured — a model in `compute.yaml`, a threshold
  in `rules.yaml` — and with either missing the drain is byte-identical to the
  build before this existed, which is a test rather than a promise.
  `metistry-eval intents` scores the owner's own labelled messages and **fits**
  the threshold to the pre-registered bar instead of anybody choosing one.
- Updated dependencies [2080ce5]
- Updated dependencies [7bf6db6]
- Updated dependencies [ac8a137]
- Updated dependencies [c69abc3]
- Updated dependencies [aafc41a]
- Updated dependencies [1edc2f7]
- Updated dependencies [56be405]
- Updated dependencies [d930fba]
- Updated dependencies [73977f8]
- Updated dependencies [a8ccdfc]
- Updated dependencies [87fc443]
  - @foldedspacelabs/metistry-core@0.12.0
  - @foldedspacelabs/metistry-mcp-brain@0.12.0

## 0.11.0

### Patch Changes

- Updated dependencies [4a778f9]
- Updated dependencies [4f43f9c]
- Updated dependencies [1bf5c76]
- Updated dependencies [5cc302d]
- Updated dependencies [b6586de]
- Updated dependencies [57ceb02]
  - @foldedspacelabs/metistry-mcp-brain@0.11.0

## 0.10.0

### Patch Changes

- Updated dependencies [7782cf4]
- Updated dependencies [8fc0e5e]
- Updated dependencies [0171bc0]
- Updated dependencies [7782cf4]
  - @foldedspacelabs/metistry-mcp-brain@0.10.0
  - @foldedspacelabs/metistry-tasks@0.10.0

## 0.9.1

### Patch Changes

- @foldedspacelabs/metistry-mcp-brain@0.9.1
  - @foldedspacelabs/metistry-tasks@0.9.1

## 0.9.0

### Patch Changes

- Updated dependencies [f57b3b0]
- Updated dependencies [76f82a2]
  - @foldedspacelabs/metistry-mcp-brain@0.9.0
  - @foldedspacelabs/metistry-tasks@0.9.0

## 0.8.1

### Patch Changes

- @foldedspacelabs/metistry-mcp-brain@0.8.1
  - @foldedspacelabs/metistry-tasks@0.8.1

## 0.8.0

### Patch Changes

- Updated dependencies [6aa64c2]
- Updated dependencies [f27e0af]
- Updated dependencies [6fd4c28]
- Updated dependencies [cde0691]
- Updated dependencies [23d72db]
- Updated dependencies [367f456]
  - @foldedspacelabs/metistry-mcp-brain@0.8.0
  - @foldedspacelabs/metistry-tasks@0.8.0
