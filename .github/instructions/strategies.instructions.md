---
applyTo: "src/strategies/**"
---

Room turn-strategies. Each is a **pure** function: it reads room state (status,
participants, `turnIndex`/`turnBudget`, transcript, round) and returns the next
turn decision — `{ kind: "speak", mind }` or `{ kind: "end" }`. They are
registered in `index.ts`.

Flag in this directory:

- Any I/O, `await`, filesystem, network, or `console` call — strategies must stay
  pure; the driver (`src/room.ts`) owns all I/O.
- Any import of a provider, the host, or a side-effecting module. Strategy inputs
  arrive as plain room state; they don't fetch anything.
- A new strategy not registered in `index.ts`, or a missing terminal case — an
  inactive room, no participants, or a reached budget must return `end`, never
  loop forever or pick a phantom speaker.
