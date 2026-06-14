---
applyTo: "src/boards/**"
---

Board builders for the agent-authored lenses (roster, room transcript). They
produce canvas `board` views that publish **fail closed** — bound keys are
guarded by `validate` (`expectView`) and workflow node `output_schema`.

Flag in this directory:

- Any hand-coded UI or React — these emit a canvas `board` data structure, not
  components.
- A builder that can emit a malformed board (missing `view: "board"`, a section of
  the wrong shape) that would be silently dropped by `validate` on publish rather
  than rejected loudly.
- Unbounded growth in a board rendered every turn (for example an ever-growing
  transcript with no cap) on a hot publish path.
