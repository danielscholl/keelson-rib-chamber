---
title: Workflows
description: The seven workflows the Chamber rib contributes to the catalog, each defined in code with no YAML file
sidebar:
  order: 3
---

Chamber contributes seven workflows to the catalog. They are defined in code, in
the rib's `contributeWorkflows` hook, so there are no YAML files to edit. Four
are deterministic bash collectors that read the data home and publish a board;
two are single prompt turns that author content; and one (chamber-digest) is a
three-node self-gating pipeline that pairs a cheap bash gate with a conditional
agent turn.

## The seven

| Workflow | Kind | Node | Snapshot key | Publishes |
|---|---|---|---|---|
| `chamber-roster` | bash collector | `collect` | `ROSTER_KEY` | the Roster board |
| `chamber-rooms` | bash collector | `collect` | `ROOMS_KEY` | the Rooms index |
| `chamber-lenses` | bash collector | `collect` | `LENSES_KEY` | the Lenses index |
| `chamber-activity` | bash collector | `collect` | `ACTIVITY_KEY` | the Activity standing board |
| `chamber-digest` | self-gating pipeline | `gate`/`author`/`publish` | `DIGEST_KEY` | the standing digest panel |
| `chamber-genesis` | prompt turn | `genesis` | none | nothing (writes a Mind) |
| `chamber-lens` | prompt turn | `compose` | none | a per-subject lens panel |

## The collectors

The four index workflows are deterministic. Each has a single `bash` node that
shells a `bin/collect-*.ts` script with the resolved directory baked into the
command, reads the data home off disk, and emits a board on stdout. No agent
turn runs, so a refresh is free. Each binds its output to a fixed snapshot key
and validates fail-closed: a board that does not parse, or whose `view` is not
`board`, fails the run rather than publishing junk.

| Workflow | Script | `bindSnapshotKey` | `validate` |
|---|---|---|---|
| `chamber-roster` | `bin/collect-roster.ts` | `ROSTER_KEY` | `expectView(ROSTER_KEY, "board")` |
| `chamber-rooms` | `bin/collect-rooms.ts` | `ROOMS_KEY` | `expectView(ROOMS_KEY, "board")` |
| `chamber-lenses` | `bin/collect-lenses.ts` | `LENSES_KEY` | `expectView(LENSES_KEY, "board")` |
| `chamber-activity` | `bin/collect-activity.ts` | `ACTIVITY_KEY` | `expectView(ACTIVITY_KEY, "board")` |

Each `collect` node carries an `output_schema` of `{ type: "object", required:
["view", "sections"] }`, and the script writes the JSON board its matching
builder produces. The roster collector also reads the watermark and assembles
the roster pulse; the pulse is fail-soft, so a read error drops the pulse but
never the board.

These four are the producers behind the Roster, Rooms, Lenses, and Activity regions of
the Chamber surface. On the surface each binds with a `cadenceMs` of `120000`,
so the board re-collects every two minutes on its own. State changes that should
show sooner (a new Mind, a room ending, stopping, or being deleted, a lens
authored or retired) trigger a targeted `refreshWorkflow` so the right index
republishes without waiting on the cadence. Starting a room is the exception: it
creates the room's own live panel at once but does not refresh the Rooms index,
which picks the new room up on its next cadence.

## chamber-activity

`chamber-activity` is the fourth bash collector. Like the three index collectors
it has a single `bash` node (`collect`) that reads the data home and publishes a
board. Unlike them it reads all three stores (Minds, rooms, and lenses) and
assembles a cumulative-pulse and a reverse-chronological recent-events feed in
one board. It binds its output to `ACTIVITY_KEY` (`rib:chamber:activity`), so
the Activity region of the Chamber surface always reflects the full current state.

- No agent turn runs. Every refresh is a cheap disk read.
- `bindSnapshotKey: ACTIVITY_KEY` and `validate: expectView(ACTIVITY_KEY, "board")`.
- The host scheduler refreshes it on the same `120000` ms cadence as the three
  index collectors, so the Activity board stays live with no manual trigger.

## chamber-digest

`chamber-digest` is a three-node self-gating pipeline that re-authors a standing
digest board with an agent turn, but spends that turn only when the Chamber has
changed since the last digest.

- `gate`: a cheap bash node that reads all three stores and the persisted digest
  fingerprint, and emits `{ dirty, summary }`. No `output_schema`: its output
  drives `when:` in the next node and feeds the author its source material; it
  never publishes to the key.
- `author`: a `prompt` node with `when: "$gate.output.dirty == 'true'"`. It runs
  only when `gate` saw a change; on a quiet tick (or a failed gate) the node is
  skipped entirely (no agent turn, no cost). It calls `chamber_emit_digest` to
  persist the board and advance the fingerprint. `fail_on_tool_error: true` so a
  bad authoring surfaces as a failed node rather than a succeeded turn that wrote
  nothing.
- `publish`: a `bash` node with `trigger_rule: "all_done"`. It runs whether
  `author` ran, was skipped, or failed, re-reads the digest store from disk, and
  publishes the board to `DIGEST_KEY`. This keeps the panel live every tick and
  self-heals a failed authoring: an un-advanced fingerprint drives a re-author on
  the next tick.

The cost-safety invariant: a quiet Chamber (no new Minds, rooms, or lenses since
the last digest) never spends an agent turn. `publish` still runs every cadence
so the panel stays live with a current `composedAt` timestamp.

- `bindSnapshotKey: DIGEST_KEY` and `validate: expectView(DIGEST_KEY, "board")`.
- The host scheduler runs the whole pipeline on a `120000` ms cadence.

## chamber-genesis

`chamber-genesis` is one `prompt` node, `genesis`. The turn reads a brief,
authors a `SOUL.md` and a one-line roster tagline, and persists the Mind by
calling `chamber_emit_genesis`. It ends with the reply `Authored {name} ({slug})`,
using the slug value the tool returned. It has:

- `allowed_tools: ["chamber_emit_genesis"]`. Rib tools are off by default in a
  workflow prompt node, so the turn opts in to the single write seam by name.
- `fail_on_tool_error: true`. The write seam fails closed on a slug collision,
  and this makes that tool error fail the whole run instead of reporting success
  with no Mind written.
- No `bindSnapshotKey` and no `validate`. Genesis publishes no board. Its product
  is files on disk, and the `chamber-roster` collector reflects the new Mind on
  its next refresh.

## chamber-lens

`chamber-lens` is one `prompt` node, `compose`. The turn composes a canvas board
for a subject and publishes it by calling `chamber_emit_lens`. It has:

- `allowed_tools: [LENS_TOOL_NAME]`, the lens publish tool (`chamber_emit_lens`).
- `fail_on_tool_error: true`, so a publish that fails the board validation fails
  the run rather than reporting success with nothing rendered.
- No `bindSnapshotKey`. The per-subject key (`rib:chamber:lens:{id}`) is chosen
  at run time by the tool from the `id` the turn supplies, not pinned to one
  static key, so each subject lands in its own panel.

The workflow prompt asks the model for `{ id, board, scope?, reason? }`. The
`chamber_emit_lens` tool accepts one more optional provenance field,
`maintainingMind`, which a Mind authoring mid-room can set; see
[Tools and commands](../tools-and-commands/) for the full schema.

## The Briefing is not a workflow

The Briefing footer is rib-driven, not a contributed workflow. There is no
`chamber-brief` workflow and the footer region binds no `workflow`. The rib
seeds a quiet board at boot, and a single gate decides when to spend a paid
agent turn: only when a room has ended or a lens has changed since the last
watermark. The quiet path authors nothing. See
[Agent-authored lenses](../../design/agent-authored-lenses/) for why the
briefing is gated this way.

## Description convention

Each workflow ships a description in the `Use when / Triggers / Does / NOT for`
shape, so the catalog and the surface render them scannably and a reader can tell
at a glance what a workflow is for and what it is not. New Chamber workflows
follow the same shape.

## Related

- [Surface](../surface/): the regions and snapshot keys these workflows publish to.
- [Tools and commands](../tools-and-commands/): the `chamber_emit_genesis` and `chamber_emit_lens` write seams, and the slash commands that run these workflows.
- [Agent-authored lenses](../../design/agent-authored-lenses/): the design record for the rib-driven briefing gate.
- [Workflow nodes](https://danielscholl.github.io/keelson/docs/reference/workflow-nodes/): the keelson node taxonomy these definitions use.
