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

Eighteen tools, gated on which host seams are wired (see
[Tool availability](#tool-availability)). Input fields are the Zod schemas; an
optional field is marked `?`.

| Tool | `state_changing` | `requires_confirmation` | Purpose | Input fields |
|---|---|---|---|---|
| `chamber_emit_genesis` | yes | no | Persist an authored Mind. Internal write seam for the `chamber-genesis` workflow, not a tool you call directly. | `name`, `role`, `voice`, `soul`, `tagline`, `model?`, `provider?`, `tools?` |
| `chamber_emit_digest` | yes | no | Internal write-seam for the `chamber-digest` workflow: persist the standing digest board. Not called directly. | `board` |
| `chamber_list_minds` | no | no | List all Minds: slug, name, role, tagline, pinned model/provider, capability tools. Read-only. | _(none)_ |
| `chamber_list_rooms` | no | no | List rooms (active first, then ended) with slug, name, status, strategy, participants, and turn progress. Read-only. | _(none)_ |
| `chamber_list_lenses` | no | no | List living lenses of both species newest first: id, `kind` (`canvas` or `html`), updatedAt, refresh backing, and optional provenance fields. Pass `{ id }` to fetch one lens in full, a canvas row's `board` included; an html row never carries its markup. Read-only. | `id?` |
| `chamber_list_exhibits` | no | no | List exhibits (deliverables rooms tabled) newest first: id, tabledAt, producing room, gist. Read-only. | _(none)_ |
| `chamber_room_transcript` | no | no | Page a room's persisted transcript with `offset`/`limit`, avoiding the truncation `chamber_room_status` applies to a long transcript. Read-only. | `room`, `offset?`, `limit?` |
| `chamber_retire_mind` | yes | no | Permanently remove a Mind's record and SOUL.md from the roster. Fails closed if absent. | `slug` |
| `chamber_room_delete` | yes | no | Permanently delete an ended room's record, transcript, and ledger, plus every exhibit it tabled. Stop first with `chamber_room_stop`. | `room` |
| `chamber_emit_lens` | yes | no | Author a lens: publish an agent-composed canvas board as a standing view on a subject. It lands as a card in the Lenses index, read with Open; it takes a surface panel only if an operator pins it, which is not the tool's to set. | `id`, `board`, `scope?`, `maintainingMind?`, `reason?`, `refresh?` |
| `chamber_emit_lens_html` | yes | no | Author an HTML lens: publish a self-contained HTML page, rendered in a sandboxed iframe. A stable kebab-case `id` creates a per-subject lens that persists across restarts (re-emit to update) and lands as a card in the Lenses index; `title` names it; omit `id` to target the shared legacy canvas, which is always panelled. Like a board lens, a per-subject page takes a panel only when pinned. `refresh` makes it living on the board lens's rules, except `workflow` is required and the legacy canvas takes no backing. | `html`, `id?`, `title?`, `refresh?` |
| `chamber_retire_lens` | yes | no | Permanently remove a lens of either species, both its record and its live panel. `kind` (`canvas` or `html`) picks; without it the id resolves to whichever store holds it, and an id naming both is refused rather than guessed. Fails closed if no such lens, or if the id names an exhibit. | `id`, `kind?` |
| `chamber_table_exhibit` | yes | no | Table an exhibit: publish a canvas-board deliverable a discussion produced into the Tabled section of its room's board. | `id`, `board`, `reason?` |
| `chamber_delete_exhibit` | yes | no | Permanently remove an exhibit, both its record and its snapshot key. Fails closed if no such exhibit, or if the id names a lens. | `id` |
| `chamber_room_status` | no | no | Return a room's participants, status, turn count, and transcript so far. Read-only. | `room?` |
| `chamber_room_start` | yes | yes | Open a room where named Minds converse turn by turn. Dry-runs until `confirm` is set. `grounding` (`{ sourceUrl?, criteria?: string[] }`) adds a brief; its criteria drive a cross-vendor fidelity check before a design-bearing room closes, when the cast spans two providers. | `participants`, `turnBudget?`, `name?`, `topic?`, `grounding?`, `strategy?`, `moderator?`, `manager?`, `synthesizer?`, `minRounds?`, `maxSpeakerRepeats?`, `endVoteThreshold?`, `projectId?`, `coding?`, `confirm?` |
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
  strategy infers `group-chat`; setting `manager` with no explicit strategy
  infers `magentic`. An explicit `strategy` still wins, and `moderator` takes
  precedence if both are set.
- `moderator` is required and validated only for `group-chat`; it must name a Mind
  that is not a participant.
- `synthesizer` is an optional closing-summary Mind for `group-chat`.
- `minRounds` and `maxSpeakerRepeats` are positive integers tuning moderated
  routing.
- `endVoteThreshold` is a number in `(0, 1)` tuning the `open-floor` close.
- `manager` is required and validated only for `magentic`; it must name a Mind that
  is not a participant, parallel to `moderator` for `group-chat`.
- `projectId` targets the room at a registered keelson project; turns run at that
  project's `rootPath`.
- `coding` (boolean, default false) opts the room into the coding tier, allowing
  Minds that declare `code`/`read` capabilities to run Bash/Edit/Write/Read tools
  confined to the project root. Requires `projectId`.

The steer schema requires at least one of its three intents:

- `chamber_room_say` takes `room?`, `direction?`, `callOn?`, `text?`, and refines
  to require **at least one** of `direction`, `callOn`, or `text`. A `callOn` is
  rejected up front unless it names a current participant.

The lens schema carries four optional provenance-bearing fields beyond the board,
plus the living-lens backing:

- `chamber_emit_lens` takes `id` (1..64 chars, canonicalized), `board` (a canvas
  board view), `scope?` (1..40), `maintainingMind?` (1..40), and `reason?`
  (1..120). The `scope`, `maintainingMind`, and `reason` fields are the lens index
  card's optional provenance. `refresh?` makes it a living lens:
  `{ workflow? (default chamber-lens-refresh), cadenceMs? (30s..24h, default 1h) }`.
  Omitted on a re-author it PRESERVES the existing backing; an object PATCHES it
  (an omitted field keeps its prior value); `refresh: null` clears it. See
  [Lenses](../../concepts/lenses/).
- `chamber_table_exhibit` takes `id`, `board`, and `reason?` (1..120, a one-line
  gist). The producing room (`sourceRoom`) is deliberately NOT an input: the room
  driver stamps it after witnessing the tool run in a turn it ran, so provenance
  is observed, never claimed.

### Tool availability

Tool registration is conditional on the host seams the harness wires in:

- **Always present (9):** `chamber_emit_genesis`, `chamber_emit_digest`,
  `chamber_list_minds`, `chamber_list_rooms`, `chamber_list_lenses`,
  `chamber_list_exhibits`, `chamber_room_transcript`, `chamber_retire_mind`,
  `chamber_room_delete`.
- **Snapshot manager + region registration seams (5 more):** `chamber_emit_lens`,
  `chamber_retire_lens`, `chamber_table_exhibit`, `chamber_delete_exhibit`,
  `chamber_emit_lens_html`.
- **All seams including agent-turn (4 more):** `chamber_room_status`,
  `chamber_room_start`, `chamber_room_say`, `chamber_room_stop`. See
  [The agent-turn seam](../../design/the-agent-turn-seam/).

When a seam is absent the corresponding tools are simply not in the returned set.

## Slash commands

Three commands, dispatched through the harness command surface. Names are bare in
the descriptor; the leading slash is the operator's typed form.

| Command | Argument | Completes | Effect |
|---|---|---|---|
| `/mind {slug}` | a Mind slug | yes (roster slugs filtered by prefix) | `open-agent` with the slug, or an inline `message` (no arg, or empty roster) |
| `/genesis {brief}` | a freeform brief | no | `run-workflow` `chamber-genesis` (brief rides as `$ARGUMENTS`) |
| `/lens {subject}` | a lens subject | no | `run-workflow` `chamber-lens` |

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
| `dismiss-genesis` | _(none)_ | data (no payload): ends a stalled genesis boot card, refreshes the roster |
| `retire` | `{ slug }` | data (`{ slug }`) |
| `room-start` | `{ participants, turnBudget?, name?, strategy?, topic?, groundingUrl?, criteria?, ...config }` | data (`{ slug }`) |
| `draft-set` | `{ slug }` | data (`{ excluded }`) |
| `convene` | `{ topic?, groundingUrl?, criteria? }` | data (`{ slug }`) |
| `room-inject` | `{ slug, directionInjection?, nextSpeaker?, text? }` | data (`{ slug }`) |
| `room-stop` | `{ slug }` | data (`{ slug }`) |
| `room-delete` | `{ slug }` | data (`{ slug }`) |
| `room-open` | `{ slug }` | `open-canvas` (a driving room's own key, else the room-view key; liveness is the driver's in-memory set, not the record's status) |
| `room-summary` | `{ slug }` | `open-canvas` (the room-summary key: a rib-built HTML page of the room's outcome) |
| `outcome-copy` | `{ slug }` | data (the room's outcome as a markdown string) |
| `outcome-explore` | `{ slug }` | `open-chat` (seeded from the outcome document) |
| `set-model` | `{ slug, model?, provider? }` | data (`{ slug, model? }`) |
| `retire-lens` | `{ id }` | data (`{ id, key }`) |
| `retire-lens-html` | `{ id }` | data (`{ id, key }`) |
| `delete-exhibit` | `{ id }` | data (`{ id, key }`) |
| `lens-open` | `{ id, kind? }` | `open-canvas` (the lens key; `kind: "html"` picks the html key, absent means canvas) |
| `lens-note` | `{ id, note }` | data (`{ id, key }`) |
| `refresh-lens` | `{ id, kind? }` | data (`{ id, workflow }`): fires the lens's refresh workflow with input `lens` |
| `pin-lens` | `{ id, pinned, kind? }` | data (`{ id, pinned }`): adds or drops the lens's Chamber panel |

`pin-lens` carries the **target** state rather than toggling, so a card rendered
before someone else's pin can't act on state it isn't showing. It is operator-only:
deliberately absent from `chamber_emit_lens`, from the MCP tools, and from
`FRAME_SAFE_ACTIONS`, since an authoring Mind claiming main-surface real estate is the
clutter pinning exists to remove.

`retire-lens` and `retire-lens-html` also ride each pinned lens panel's head **⋯**
menu (`headActions` on the region), alongside a non-destructive **Unpin from
Chamber**, so a panel can be put away from itself without hunting the index. Once
unpinned there is no head, so the index card is what carries every verb, and it is the
only way to pin a lens back. `delete-exhibit` has no such menu: an exhibit holds no
panel at any pin state, so its delete rides the card in its room's Tabled section.

Two verbs are restricted to the sandboxed HTML-lens iframe context
(`origin: "canvas-html"`): `lens-html` (no-op ack returning the HTML lens canvas
key) and the sandboxed variant of `lens-open`. Board actions dispatched by
operators and agents cannot reach these; `FRAME_SAFE_ACTIONS` gates them to the
iframe origin only.

The board action verbs use the driver-level routing names: `room-inject` takes
`directionInjection` and `nextSpeaker`, where the `chamber_room_say` chat tool
takes `direction` and `callOn`. Both funnel through the same inject and stop paths,
so a steer from chat and a steer from the surface behave identically.

## Related

- [Workflows](../workflows/): the contributed workflows that drive the standing
  panels, genesis, and lens authoring.
- [Surface](../surface/): the snapshot keys and regions these tools publish to.
- [Rooms and strategies](../../concepts/rooms/): the room loop the room tools steer.
- [The agent-turn seam](../../design/the-agent-turn-seam/): the host seam the room
  tools require.
- [Keelson rib contract](https://danielscholl.github.io/keelson/docs/reference/rib-contract/):
  the generic tool, command, and action surface a rib plugs into.
