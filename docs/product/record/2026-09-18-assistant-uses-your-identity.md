- 2026-09-18 — **Your assistant answers as the assistant you named, and
  refuses to start if it cannot tell.** On the shape that runs without
  containers — the one the Mac app installs — the engine was looking for the
  file that holds your assistant's name, voice and model choices relative to
  the wrong folder: the product's own, not yours. Every candidate path missed,
  and it fell back silently to the placeholder identity that ships with the
  software. Nothing looked broken; replies arrived, under a name you never
  chose, with the model assignments and the routing rules you had written
  going unread. The fix is at the root rather than at the symptom: every
  service is now told where your setup lives and resolves its config from
  there, absolute, so no component's behaviour depends on which directory it
  happened to be started in — and it works the same on a setup that has not
  yet moved to the new folder shape. The safety mechanism is the second half:
  rather than degrade to the placeholder, the assistant now **stops with an
  explanation** when nothing tells it where your identity file is. Answering
  as someone else is the one failure you cannot see from the outside, so it
  is no longer possible to reach by accident. The confinement the engine runs
  under was widened by exactly four files, each granted by name — your
  identity, your prompt, your rules, your model assignments — and by nothing
  else: your notes are still unreachable from it, which a test proves by
  trying to read one from inside.
