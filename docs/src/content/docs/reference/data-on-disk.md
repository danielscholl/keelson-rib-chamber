---
title: Data on disk
description: What Chamber persists under its data home and the board payload it publishes
sidebar:
  order: 6
---

Chamber is a Keelson rib, so it persists everything under its own per-rib data
home. The home path is the value the harness hands the rib at boot, captured
from the `getDataDir` seam: `<keelson-home>/rib-chamber/`. Everything below is
relative to that home.

```text
<keelson-home>/rib-chamber/
├── minds/
│   └── <slug>/
├── rooms/
│   └── <slug>/
├── lenses/
│   └── <id>/
├── room-draft.json
└── brief-watermark.json
```

The three subdirectories hold one entry per Mind, room, and lens. The two
JSON files at the home root are small singletons: the Convene draft and the
briefing watermark.

## A Mind

A Mind lives in `minds/<slug>/`. The directory name is the authoritative slug:
if `mind.json` carries a divergent `slug`, the directory name wins on read.

| File | Origin | Contents |
|---|---|---|
| `mind.json` | authored | the `MindRecord` (see below) |
| `SOUL.md` | authored | a Persona / Mission / Voice document |
| `AGENT.md` | seeded | operating doctrine for a room turn |
| `memory.md` | seeded | working memory, starts empty |
| `rules.md` | seeded | operating rules, starts empty |
| `log.md` | seeded | a log, with one genesis entry |

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
via workflow inputs, and the roster **Set model…** action can update or clear the
pin later. `tools` is an optional array of capability slugs, written only when
non-empty. `SOUL.md` holds the three named sections; the seeded docs carry
placeholder text until a Mind earns real content.

### Slug rules

A slug is lowercase kebab, ASCII alphanumerics and hyphens, starting with an
alphanumeric, capped at 48 characters. `slugify` derives it from the name;
`assertSafeSlug` is the path-traversal guard and rejects anything outside that
shape (no `/`, no `..`). The same guard runs before any read or write keyed by
slug.

## A room

A room lives in `rooms/<slug>/` as two files: current state and an append-only
log.

```text
rooms/<slug>/
├── room.json
└── transcript.jsonl
```

`room.json` is the `Room` record, rewritten each turn and reconcilable from the
transcript:

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

`status` is one of `active`, `stopped`, or `done`. `topic`, `config`, and
`pending` are optional. `round` is stored, not derived, so a director override
or moderator pick can perturb rotation without losing the round count.

`transcript.jsonl` is one `TurnEntry` per line, append-only:

```json
{
  "messageId": "…",
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

## A lens

A lens lives in `lenses/<id>/lens.json`. There is no transcript sibling: a lens
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

The watermark drives the briefing substance gate: it records what the footer
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
re-authored lens reads as changed. `briefPromoted` tracks whether the footer
currently holds a promoted briefing (`true`) or the quiet board (`false`). A
missing or torn file reads as empty, so a cold start treats everything as new
and unpromoted.

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
- [Keelson snapshots](https://danielscholl.github.io/keelson/docs/reference/snapshots/): the canvas board contract and renderer.
