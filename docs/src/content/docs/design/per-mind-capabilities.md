---
title: Per-Mind capabilities
description: Why a speaker reaches only the tools its Mind declares, intersected with a room-safe pool
sidebar:
  order: 4
---

A speaker reaches only the tools its Mind declares, intersected with what the
room permits. Nothing more. A Mind that declares no capabilities runs text-only,
which is the room default, never the full tool surface.

The declares-only thesis has one additive exception. A room that targets a
project auto-grants read-only `Read` to every speaker, whether or not the Mind
declared it, confined to the project root. `Read` cannot mutate, so it is safe to
grant room-wide. Write and exec still require the `code` coding tier.

## The decision

`Mind.tools` is a list of capability **slugs**, not raw tool names. A slug is an
entry in a small curated vocabulary that maps to one or more concrete tools. Today
that vocabulary has four entries: `lens` (authorizes `chamber_table_exhibit`: mid-room publishing tables an exhibit), `read`
(authorizes `Read`), `code` (authorizes `Bash`, `Edit`, `Write`), and `osdu`
(authorizes read-only OSDU platform status tools when the osdu rib is
co-installed and the operator has granted Chamber those tools). `Read` is the exception: a room that targets a project auto-grants it to every
speaker, coding or standard, confined to the project root. Selecting the project
is the grant, so no coding tier and no per-Mind `read` declaration is required.
`code` is the coding-room-only tier: its `Bash`, `Edit`, and `Write` resolve to
nothing in a standard room. A Mind that wants to table an exhibit mid-room
declares `lens`; a coding-room Mind that needs to edit files or run commands
declares `code`; a Mind that needs OSDU status declares `osdu`; a Mind that
declares nothing gets an empty tool rail and can only speak. Declaring `read`
still matters in one case: a coding room with no resolvable project root, running
at the neutral home cwd, where `Read` reaches the rail through the coding pool
instead of the room-wide grant.

The room supplies the ceiling. A room is given a room-safe pool of tool names it
is willing to expose to any speaker. A Mind's resolved tools are the intersection
of what its slugs map to and that pool. The pool is the upper bound; a Mind can
only ever narrow it, never widen it.

## Why intersect with a room-safe pool

The core agent-turn seam already filters a turn's tools: it projects the turn's
requested tool names against the shared registry, applies the operator denylist,
and holds back any tool another rib owns unless the operator has
[granted it to the calling rib](https://danielscholl.github.io/keelson/docs/guides/governance/#cross-rib-grants). That stops a Chamber turn reaching a
sibling rib's tools by default. It does not stop a turn reaching Chamber's own
tools: every tool this rib registers is one a Chamber turn may request, the
room's own control plane included.

So the rib applies its own allowlist ceiling on top. Because a speaker's tools are
intersected with a pool the rib controls, a Mind can never reach the room-control
tools, the genesis write seam, or any unpooled tool from this rib or another rib,
even with a hand-edited `mind.json`. The two layers do different jobs: the core
seam enforces the operator floor (the denylist and the cross-rib grants), and the
rib enforces least privilege per room.

The layers stack, so a slug backed by another rib needs both. `osdu` is in the
room-safe pool, but its tools belong to the osdu rib, so the core seam projects
them onto a Chamber turn only once the operator grants them. Without the grant
the turn still runs, with those tools absent, and the server log names the tools
it held back. The Mind is not told.

## Resolution mechanics

`resolveMindTools(mind, pool)` does the mapping:

- A missing or empty pool returns `[]`. The speaker runs text-only, the room
  default.
- Each declared slug is mapped through the capability vocabulary to its tool
  names. A slug not in the vocabulary maps to nothing.
- The result keeps only names that are also in the pool, deduplicated, as the
  turn's tool rail.

`resolveMindTools` is the per-Mind mapping only. In a project-targeted room the
driver layers the room-wide `Read` grant on top of its result, so a
no-declaration Mind can still reach `Read` even when the mapping returned `[]`.

Genesis lets a soul declare capability slugs as part of authoring a Mind. The
write seam filters the declared list down to the known set before persisting it,
dropping any unknown slug without failing the run. So an unknown slug never
reaches `mind.json`, and even if one did, resolution would map it to nothing.

## Out of scope

This delivers the mapping and the least-privilege scoping, nothing more.
Per-Mind ASK and DENY permissioning, where a tool call pauses for approval rather
than being allowed or silently excluded, waits on harness policy. Until then a
capability a Mind declares and the room permits is simply allowed, and everything
else is simply absent.

## Related

- [Tools and commands](../../reference/tools-and-commands/): the tools a slug can
  resolve to, with their schemas.
- [Agent-authored lenses](../agent-authored-lenses/): the built-in lens
  capability, and what `chamber_emit_lens` publishes.
- [Rib contract](https://danielscholl.github.io/keelson/docs/reference/rib-contract/):
  the harness seams a rib's tools are registered through.
