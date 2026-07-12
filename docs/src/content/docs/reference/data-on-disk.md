---
title: Data on disk
description: What Chamber persists under its data home and the board payload it publishes
sidebar:
  order: 6
---

Chamber is a Keelson rib, so it persists everything under its own per-rib data
home. The home path is the value the harness hands the rib at boot, captured
from the `getDataDir` seam: `{keelson-home}/rib-chamber/`. Everything below is
relative to that home.

```text
{keelson-home}/rib-chamber/
├── minds/
│   └── {slug}/
├── rooms/
│   └── {slug}/
├── lenses/
│   └── {id}/
├── lenses-html/
│   └── {id}/
│       ├── lens.html
│       └── meta.json
├── room-draft.json
├── digest.json
├── brief-watermark.json
└── pending-genesis.json
```

The four subdirectories hold one entry per Mind, room, board lens, and HTML
lens. Three of the JSON files at the home root are durable singletons: the
Convene draft, the standing digest, and the briefing watermark. The fourth,
`pending-genesis.json`, is a transient marker that exists only while a genesis
is in flight.

## A Mind

A Mind lives in `minds/{slug}/`. The directory name is the authoritative slug:
if `mind.json` carries a divergent `slug`, the directory name wins on read.

| File | Origin | Contents |
|---|---|---|
| `mind.json` | authored | the `MindRecord` (see below) |
| `SOUL.md` | authored | a Persona / Mission / Voice document |
| `AGENT.md` | seeded | operating doctrine for a room turn |
| `memory.md` | seeded, then reflected | durable memory, starts empty; rewritten by the close-only reflection pass |
| `rules.md` | seeded | operating rules, starts empty; operator-authored only |
| `log.md` | seeded, then reflected | a log: one genesis entry, one line appended per reflection |

`mind.json` is a `MindRecord`:

```json
{
  "slug": "moneypenny",
  "name": "Moneypenny",
  "role": "Chief of Staff",
  "voice": "Miss Moneypenny",
  "persona": "Chief of Staff: briefings, priorities, follow-through",
  "createdAt": "2026-06-23T12:00:00.000Z"
}
```

`persona` is the roster tagline, one line, not the Persona section from
`SOUL.md`. `model` and `provider` are optional. Genesis writes them when provided
via workflow inputs, and the roster card's model picker can update or clear the
pin later. `tools` is an optional array of capability slugs, written only when
non-empty. `identitySlot` (a host identity-tone slot, an integer 0 through 4,
assigned once at genesis) is written only when set. `SOUL.md` holds
the three named sections. `memory.md` and `rules.md`
are seeded as empty templates and `log.md` with a single genesis line; all three
are ordinary inspectable files you can edit. `memory.md` and `log.md` are also
written by the rib: when a room closes, each Mind that spoke runs a reflection turn
that rewrites its `memory.md` in place and appends one line to `log.md` (see
[How minds remember](../../design/how-minds-remember/)). `rules.md` is
operator-authored only, never written by reflection. `memory.md` is capped at 4000
characters, and a reflection that would exceed the cap is rejected with the prior
memory kept; `log.md` keeps the newest 50 entries, each at most 280 characters.

### Slug rules

A slug is lowercase kebab, ASCII alphanumerics and hyphens, starting with an
alphanumeric, capped at 48 characters. `slugify` derives it from the name;
`assertSafeSlug` is the path-traversal guard and rejects anything outside that
shape (no `/`, no `..`). The same guard runs before any read or write keyed by
slug.

## A room

A room lives in `rooms/{slug}/` as two or three files depending on strategy:
current state, an append-only log, and, for magentic rooms, a task ledger.

```text
rooms/{slug}/
├── room.json
├── transcript.jsonl
└── ledger.json          # magentic rooms only
```

`room.json` is the `Room` record, rewritten each turn and read directly. It is
not rebuilt from the transcript; only its `turnIndex` cursor is reconcilable from
the transcript on resume:

```json
{
  "slug": "room-lq2x-3",
  "name": "Moneypenny & Mycroft",
  "strategy": "sequential",
  "participants": ["moneypenny", "mycroft"],
  "status": "active",
  "turnBudget": 8,
  "turnIndex": 3,
  "round": 2,
  "createdAt": "2026-06-23T12:00:00.000Z"
}
```

`status` is one of `active`, `stopped`, or `done`. `topic`, `grounding`,
`config`, `pending`, `projectId`, and `coding` are optional. `grounding` is the
room's brief distinct from the free-text topic, a `{ sourceUrl?, criteria: string[] }`
object (the shared `Brief`); when it carries criteria, a design-bearing room runs
a cross-vendor fidelity check against them before it closes. `projectId` names
the keelson project the room targets (stored as the id, not the resolved path);
`coding` is the opt-in coding tier and requires a `projectId`, since the project
root is the confinement boundary for coding turns. `round` is stored, not
derived, so a director override or moderator pick can perturb rotation without
losing the round count.

`transcript.jsonl` is one `TurnEntry` per line, append-only:

```json
{
  "messageId": "…",
  "roomSlug": "room-lq2x-3",
  "turnIndex": 3,
  "round": 2,
  "from": "mycroft",
  "role": "agent",
  "parts": [{ "text": "…" }],
  "at": "2026-06-23T12:01:00.000Z"
}
```

`role` is `agent`, `director`, or `system`. `from` is stamped by the driver and
the driver alone: an agent's reply becomes `parts[0].text` and nothing more, so
a turn can never assert another speaker's identity, and a director message is
forced to `from: "director"` regardless of payload. `round` and `aborted` are
optional. Closed-room retention keeps the newest 25 closed rooms and prunes
older ones; active rooms are always kept.

`ledger.json` is present only for magentic rooms. It persists the `TaskLedger`
(the manager's goal, status, and task list) and is the sole durable artifact
the magentic driver needs to resume after a restart. Non-magentic rooms have no
ledger file.

## A lens

A lens lives in `lenses/{id}/lens.json`. There is no transcript sibling: a lens
is a single board record.

```json
{
  "id": "release-status",
  "board": { "view": "board", "title": "Release status", "sections": [] },
  "updatedAt": "2026-06-23T12:00:00.000Z",
  "scope": "status board",
  "maintainingMind": "moneypenny",
  "reason": "promoted the blocker"
}
```

This is a `LensRecord`. `id` and `board` are required. `updatedAt` is
server-stamped on every write, never agent-supplied. `scope`,
`maintainingMind`, and `reason` are optional provenance: each is spread in only
when present, so re-authoring a lens without a field clears the prior value.
Two more optional fields follow different rules: `kind: "exhibit"` marks a
tabled deliverable (absent means lens; `sourceRoom` beside it is the producing
room's slug, driver-witnessed and never agent-supplied), and `refresh`, a
living lens's re-compose backing shaped
`{ "workflow": "chamber-lens-refresh", "cadenceMs": 3600000 }`. It is
PRESERVED when a re-author omits it, PATCHED field-by-field when a re-author
supplies an object (only an explicit `refresh: null` clears it), and lens-only
(an exhibit save strips it). A malformed or fractional-cadence `refresh` block
folds to absent on read rather than hiding the record.

## An HTML lens

An HTML lens is a separate species from the board lens above: it holds a
self-contained HTML page rather than a structured board. It lives in
`lenses-html/{id}/` as a two-file record, one file for the markup and one for
the commit metadata.

```text
lenses-html/{id}/
├── lens.html
└── meta.json
```

`lens.html` carries the authored markup verbatim, kept out of JSON so a large
page never round-trips an encoder. `meta.json` is the `HtmlLensMeta`,
`{ id, title?, updatedAt }`: `title` names the panel head and is written only
when set, and `updatedAt` is server-stamped on every write. The store writes
`lens.html` first and `meta.json` second, because `meta.json` is the commit
record. A load or list skips any directory that has no `meta.json`, so a crash
between the two writes leaves an invisible partial rather than a half-written
lens.

## room-draft.json

The Convene draft is an exclusion set, not a selection list:

```json
{ "excluded": ["jarvis"] }
```

An empty or missing `excluded` array means every Mind is selected. The first
toggle deselects one Mind by adding its slug here; Convene resolves
participants as all current Minds minus this set, then clears the draft back to
all-selected.

## brief-watermark.json

The watermark drives the briefing substance gate: it records what the banner
has already accounted for, so a paid briefing turn runs only when something new
happened since the last one.

```json
{
  "ackedEndedRooms": ["room-lq2x-3"],
  "lensFingerprints": { "release-status": "2026-06-23T12:00:00.000Z" },
  "briefPromoted": true,
  "updatedAt": "2026-06-23T12:02:00.000Z"
}
```

`ackedEndedRooms` is the ended-room slugs the briefing has already covered.
`lensFingerprints` maps each lens `id` to its `updatedAt`, so a new or
re-authored lens reads as changed. `briefPromoted` tracks whether the banner
currently holds a promoted briefing (`true`) or the quiet board (`false`). A
missing or torn file reads as empty, so a cold start treats everything as new
and unpromoted.

## digest.json

The digest record drives the standing digest panel. It stores the last
agent-authored board and the Chamber fingerprint it was authored against:

```json
{
  "board": { "view": "board", "title": "Digest", "sections": [] },
  "fingerprint": "…"
}
```

The `chamber-digest` workflow gate diffs a fresh fingerprint against this to
decide whether the Chamber's state advanced since the last authoring; the
publish collector reads the board back to refresh the bound key every tick. A
missing or torn file degrades to null: the gate sees a changed subject and
the publish collector falls back to the cold-start board, following the same
fail-soft contract as `brief-watermark.json`.

## pending-genesis.json

Unlike the three durable singletons above, this file is a transient marker: the
author action writes it before the `chamber-genesis` workflow runs and clears it
on completion, so it exists only while a genesis is in flight. It drives the
roster boot card that shows the seat being taken.

```json
{
  "startedAt": "2026-06-23T12:00:00.000Z",
  "name": "Moneypenny",
  "role": "Chief of Staff"
}
```

`startedAt` drives the elapsed counter and the stall timeout. `name` and `role`
are optional: they are present when a starter archetype was authored (pinned as
workflow inputs) and absent for a freeform brief, where the boot card reads
`calibrating…` until the workflow fills them in. Only one marker exists at a
time, so a second author overwrites it. A missing, corrupt, or torn file reads
as no pending genesis, the same fail-soft contract the other root singletons
keep.

## The board payload

Every panel Chamber publishes is a canvas board. The shape is the harness's,
not Chamber's, so this is a sketch rather than the full contract:

```ts
{
  view: "board",
  title: string,
  header?: { status?: { label: string; tone: Tone } },
  sections: Section[]
}
```

A `Section` is one of four kinds: `stats`, `segments`, `rows`, or `cards`. The
tone vocabulary is `ok`, `warn`, `error`, `info`, `caution`, `brand`, `accent`,
and `neutral`. The board shape and its renderer belong to Keelson; see the
canvas and snapshot docs for the authoritative field list. Chamber's job is to
build these boards from the records above and publish them on its
[snapshot keys](../surface/).

## Related

- [The Chamber surface](../surface/): the snapshot keys these records publish to.
- [Minds and genesis](../../concepts/minds/): how a Mind directory is authored.
- [Rooms and strategies](../../concepts/rooms/): how the transcript is written.
- [How minds remember](../../design/how-minds-remember/): what rewrites `memory.md` and appends to `log.md`.
- [Keelson snapshots](https://danielscholl.github.io/keelson/docs/reference/snapshots/): the canvas board contract and renderer.
