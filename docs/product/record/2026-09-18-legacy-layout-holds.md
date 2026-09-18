- 2026-09-18 — **Your existing setup keeps working until you choose to move
  it — and the promise is now tested rather than asserted.** The new folder
  shape came with a sentence saying an older setup would keep running until you
  ran the one command that moves it. Checked against a copy of a real older
  setup, it wasn't true: the app was looking for your settings in the new place
  and quietly falling back to the defaults it ships with, so it reported no
  model provider while your own file named one, could not tell you the
  assistant's name, and would have started a second, empty database beside your
  real one the next time you brought the system up. Two of those were safety
  rather than inconvenience: on an older setup the files that define how the
  system behaves had fallen out of the protected set, so the assistant could
  have edited its own rules, and the same files — plus the whole of the working
  directory the database lives in — were being swept into your searchable notes.
  Both are closed, and closed the way this project closes things: at the tool,
  so the write is refused rather than discouraged. Everything that reads your
  setup now checks which shape it is in first, one look at the folder, and the
  answer holds for both. And because compatibility nobody tests is not
  compatibility, the update command now stops — before it downloads anything —
  if it is about to move an unmigrated setup onto a version past the line that
  was tested against it, and prints the single command that brings it up to
  date. The move stays yours to make, on your own day.
