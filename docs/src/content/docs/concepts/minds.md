---
title: Minds and genesis
description: A Mind is a persistent agent identity authored on demand. What it is, where it lives, and how genesis writes one.
sidebar:
  order: 2
---

A **Mind** is a persistent agent identity: a name, a role, a voice, and a
founding document that says who it is. Minds are the only things Chamber treats
as agents. You author them on demand, they persist on disk, and you can enter one
for a direct chat or drop several into a room together.

## What a Mind is on disk

Each Mind is a directory under the rib's data home,
`<keelson-home>/rib-chamber/minds/<slug>/`:

- `SOUL.md` is the founding identity document, authored by an agent at genesis.
  It has a Persona, a Mission, and a Voice. It is the system prompt the Mind runs
  under, so it is what makes the Mind behave like itself.
- `mind.json` is the structured record the roster reads: the slug, name, role,
  voice, a one-line tagline, an optional model and provider pin, and any
  capability tools the Mind declared.
- `AGENT.md`, `memory.md`, `rules.md`, and `log.md` are seeded working documents:
  a short operating doctrine, plus durable memory, operating rules, and a running
  log that accrue over the Mind's life.

Because a Mind is just files, it is cheap to create, easy to inspect, and
versionable in git. The slug is the directory name and the Mind's stable identity
everywhere else: its address in a transcript, and the argument to `/mind`. Slugs
are path-safe by construction (lowercase, kebab-case, guarded against traversal
before they ever touch the filesystem).

## Genesis: authoring a Mind from a brief

**Genesis** writes a new Mind from a freeform brief. It is a workflow, not a
button, because authoring an identity needs words: you describe the agent you
want, and one agent turn does the rest.

Run it with the `/genesis` command, or with
`keelson workflow run chamber-genesis "<brief>"`. The turn reads your brief,
decides the Mind's name, role, and voice, composes the `SOUL.md` body and a
roster tagline, and then calls a single write seam to persist the Mind. The
prompt asks for an honest founding document: it describes who the Mind is and how
it speaks, and does not invent tools or credentials it does not have.

The write is deterministic and fails closed. If a Mind with the same slug already
exists, the write refuses rather than clobbering an existing soul, and the
workflow fails loudly instead of reporting success with nothing written. Once the
Mind lands, the roster collector reflects it as a card.

:::note
Genesis composes the identity; a small write tool persists it. Splitting the two
keeps the generative half in the prompt and the file-writing half testable. You
never call the write tool directly: run the workflow.
:::

## Starters

A fresh workspace has no Minds, so the roster offers a few preset archetypes as a
first move: Moneypenny (a chief of staff), Mycroft (a research partner), and
Jarvis (an engineering partner). Each is a brief, not a baked soul. Convening one
runs genesis to author fresh artifacts that capture the character's energy for
your workspace, from the model's own knowledge.

## Entering a Mind

Entering a Mind opens it as a direct one-to-one chat, seeded with its soul as the
system prompt. Use `/mind <slug>`, or the Enter action on the roster. The seed
stacks the Mind's identity (its `SOUL.md`, falling back to the tagline), then any
real durable memory, rules, and recent log, then a short set of direct-chat
rules, all clamped to the harness seed budget. If the Mind pins a model or
provider, the seeded chat runs on it.

A direct chat is one Mind with no peer. That is a turn, not a room. Minds talking
to each other only happens inside a [room](../rooms/).

## Capabilities are not addressable

One principle runs through the whole rib: identity is at the Mind level, and
capabilities are not addressable. Only a Mind is a participant you can put in a
room or address in a transcript. A tool, a workflow, an MCP server, or another
rib is a capability a Mind invokes during its turn, behind the harness permission
layer. None of them is an agent, and none is ever a room participant.

This is why a Mind's declared tools are not the same as its identity. A Mind may
declare a small set of **capability slugs** (today, the `lens` capability) that
scope what it is allowed to do inside a room. Declaring nothing keeps the Mind
text-only, which is the room default. The slugs are a curated vocabulary, and a
Mind can never reach a tool the room does not already permit, even through a
hand-edited record. See [Lenses](../lenses/) for what the `lens` capability
authorizes, and [Rooms and strategies](../rooms/) for how a turn's tool rail is
scoped.

## Retiring a Mind

Retiring a Mind removes its directory and drops it from the roster. It is the
inverse of genesis, and the one destructive action on the roster.

## Related

- [Rooms and strategies](../rooms/): put Minds in a room together.
- [Lenses](../lenses/): what a Mind can author during or after a room.
- [Concepts overview](../): the one pipeline genesis shares with rooms and lenses.
