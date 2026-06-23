---
title: Tools, commands, and actions
description: "The exact contract a chat agent, an operator, or the Chamber surface touches: chat tools, slash commands, the agents seam, and board action verbs"
sidebar:
  order: 4
---

Chamber exposes its capabilities to the harness as a Keelson rib: chat tools an
agent can call, slash commands an operator types, an agents seam that makes every
Mind enterable, and board action verbs the surface dispatches. This page is the
terse contract for all four. The behavior behind each entry lives in the concept
and guide pages; here are the exact names, schemas, and effects.

## Chat tools

Seven tools, registered together but gated on which host seams are wired (see
[Tool availability](#tool-availability)). Input fields are the Zod schemas; an
optional field is marked `?`.

| Tool | `state_changing` | `requires_confirmation` | Purpose | Input fields |
|---|---|---|---|---|
| `chamber_emit_genesis` | yes | no | Persist an authored Mind. Internal write seam for the `chamber-genesis` workflow, not a tool you call directly. | `name`, `role`, `voice`, `soul`, `tagline`, `tools?` |
| `chamber_emit_lens` | yes | no | Author a lens: render an agent-composed canvas board onto the surface as its own live panel. | `id`, `board`, `scope?`, `maintainingMind?`, `reason?` |
| `chamber_retire_lens` | yes | no | Permanently remove a lens, both its record and its live panel. Fails closed if no such lens. | `id` |
| `chamber_room_status` | no | no | Return a room's participants, status, turn count, and transcript so far. Read-only. | `room?` |
| `chamber_room_start` | yes | yes | Open a room where named Minds converse turn by turn. Dry-runs until `confirm` is set. | `participants`, `turnBudget?`, `name?`, `topic?`, `strategy?`, `moderator?`, `synthesizer?`, `minRounds?`, `maxSpeakerRepeats?`, `endVoteThreshold?`, `confirm?` |
| `chamber_room_say` | yes | no | Steer a live room: guide the next speaker, call on a Mind, or drop a director message. | `room?`, `direction?`, `callOn?`, `text?` |
| `chamber_room_stop` | yes | no | Stop a room, halting its turns. Reversible. | `room?` |

`chamber_room_start` is the only tool that requires confirmation, and the only one
with an in-payload dry-run gate. Without `confirm: true` it reports what it would
start and runs nothing, because every room turn is a billed agent call. See
[Rooms and strategies](../../concepts/rooms/) for the loop it guards.

### Field detail

The room-start schema is the one with constraints worth stating exactly:

- `participants` is an array of slugs, **minimum 2**. The schema counts raw
  entries; the start path de-duplicates and requires at least two distinct valid
  participants.
- `turnBudget` is an integer in **1..50**, **default 8**. The default is applied
  after parse, not as a schema default.
- `strategy` defaults to `sequential`. Setting `moderator` with no explicit
  strategy infers `group-chat`.
- `moderator` is required and validated only for `group-chat`; it must name a Mind
  that is not a participant.
- `synthesizer` is an optional closing-summary Mind for `group-chat`.
- `minRounds` and `maxSpeakerRepeats` are positive integers tuning moderated
  routing.
- `endVoteThreshold` is a number in `(0, 1)` tuning the `open-floor` close.

The steer schema requires at least one of its three intents:

- `chamber_room_say` takes `room?`, `direction?`, `callOn?`, `text?`, and refines
  to require **at least one** of `direction`, `callOn`, or `text`. A `callOn` is
  rejected up front unless it names a current participant.

The lens schema carries four optional provenance-bearing fields beyond the board:

- `chamber_emit_lens` takes `id` (1..64 chars, canonicalized), `board` (a canvas
  board view), `scope?` (1..40), `maintainingMind?` (1..40), and `reason?`
  (1..120). The `scope`, `maintainingMind`, and `reason` fields are the lens index
  card's optional provenance. See [Lenses](../../concepts/lenses/).

### Tool availability

Tool registration is conditional on the host seams the harness wires in:

- `chamber_emit_genesis` is **always present**.
- `chamber_emit_lens` and `chamber_retire_lens` need the **snapshot manager** and
  the **region registration** seams.
- The four room tools (`chamber_room_status`, `chamber_room_start`,
  `chamber_room_say`, `chamber_room_stop`) additionally need the **agent-turn**
  seam. See [The agent-turn seam](../../design/the-agent-turn-seam/).

When a seam is absent the corresponding tools are simply not in the returned set.

## Slash commands

Three commands, dispatched through the harness command surface. Names are bare in
the descriptor; the leading slash is the operator's typed form.

| Command | Argument | Completes | Effect |
|---|---|---|---|
| `/mind <slug>` | a Mind slug | yes (roster slugs filtered by prefix) | `open-agent` with the slug, or an inline `message` (no arg, or empty roster) |
| `/genesis <brief>` | a freeform brief | no | `run-workflow` `chamber-genesis` (brief rides as `$ARGUMENTS`) |
| `/lens <subject>` | a lens subject | no | `run-workflow` `chamber-lens` |

`/mind` is the only command that completes, returning roster slugs. With no
argument and a non-empty roster it lists the Minds inline; with no argument and no
Minds it nudges you toward `/genesis`. With a valid slug it opens that Mind as a
seeded chat, resolved through the agents seam below.

## The agents seam

Every Mind is a Keelson agent. The rib backs the harness agents surface
(`GET /api/agents`) through `listAgents` and `resolveAgent`:

- `listAgents` reads the Minds on disk and returns each as a summary of slug, name,
  and description (the Mind's persona, the roster tagline). The name and
  description are capped to the shared agent-summary limits; an over-cap summary is
  dropped by the host.
- `resolveAgent(slug)` returns the seed for that Mind, or `null` for an unknown
  slug. It reuses the **same seed builder** the roster's Enter action uses, so
  `/mind` (which opens an agent the host resolves through this seam) and the roster
  Enter cannot drift. Entering a Mind runs on its pinned model and provider when
  set.

## Board action verbs

The surface dispatches actions to the rib by a verb string. Each returns a result;
some carry a navigation `effect` the host interprets (open a chat, an agent, a
canvas, or run a workflow), and the rest return plain data the surface reads
without navigating.

| Verb | Payload | Effect returned |
|---|---|---|
| `enter-mind` | `{ slug }` | `open-chat` (the composed seed) |
| `author-archetype` | `{ slug }` | `run-workflow` `chamber-genesis` |
| `describe-own` | `{ brief }` | `run-workflow` `chamber-genesis` |
| `retire` | `{ slug }` | data (`{ slug }`) |
| `room-start` | `{ participants, turnBudget?, name?, strategy?, topic?, ...config }` | data (`{ slug }`) |
| `draft-set` | `{ slug }` | data (`{ excluded }`) |
| `convene` | `{ topic? }` | data (`{ slug }`) |
| `room-inject` | `{ slug, directionInjection?, nextSpeaker?, text? }` | data (`{ slug }`) |
| `room-stop` | `{ slug }` | data (`{ slug }`) |
| `room-delete` | `{ slug }` | data (`{ slug }`) |
| `room-open` | `{ slug }` | `open-canvas` (the room-view key) |
| `retire-lens` | `{ id }` | data (`{ id, key }`) |
| `lens-open` | `{ id }` | `open-canvas` (the lens key) |

The board action verbs use the driver-level routing names: `room-inject` takes
`directionInjection` and `nextSpeaker`, where the `chamber_room_say` chat tool
takes `direction` and `callOn`. Both funnel through the same inject and stop paths,
so a steer from chat and a steer from the surface behave identically.

## Related

- [Workflows](../workflows/): the five contributed workflows that drive genesis and
  lens authoring.
- [Surface](../surface/): the snapshot keys and regions these tools publish to.
- [Rooms and strategies](../../concepts/rooms/): the room loop the room tools steer.
- [The agent-turn seam](../../design/the-agent-turn-seam/): the host seam the room
  tools require.
- [Keelson rib contract](https://danielscholl.github.io/keelson/docs/reference/rib-contract/):
  the generic tool, command, and action surface a rib plugs into.
