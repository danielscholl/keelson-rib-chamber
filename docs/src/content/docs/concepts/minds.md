---
title: Minds and genesis
description: A Mind is a persistent agent identity authored on demand. Why it exists, what defines it, and how genesis writes one.
sidebar:
  order: 3
---

A **Mind** is a persistent agent identity: a name, a role, a voice, and a founding
document that says who it is. Minds are the only things Chamber treats as agents.
You author them on demand, they persist on disk, and you can enter one for a direct
chat or drop several into a room together.

## Why create a Mind

A Mind is a reusable, named perspective. Instead of re-describing "act like a
skeptic" in a prompt every time, you author the skeptic once and convene it whenever
a decision needs that lens. It keeps a stable identity across tasks and across rooms,
so its arguments are attributable and its defining role does not depend on you
rewriting the prompt each time.

| Ad hoc role prompt | Chamber Mind |
|---|---|
| Rewritten for each task | Authored once and reused |
| Usually anonymous | Stable name and transcript identity |
| Model choice is incidental | May pin its own provider and model |
| Tool access is ambient | Capabilities are declared explicitly |
| Disappears with the conversation | Inspectable files persist on disk |

## Persistent identity, stateless execution

:::note[Persistent does not mean continuously running]
A Mind itself is files and configuration, not a running process. Inside a room, every
turn is stateless and rebuilt from the Mind's soul and the room transcript, so the
driver, not a hidden model session, provides continuity. Entering a Mind opens a normal
Keelson conversation, which follows Keelson's chat and provider-session semantics.
:::

That distinction is the room's trust model. Because a room turn is rebuilt every time,
what a Mind brings to it is exactly what you can read in its soul and the transcript,
with nothing accumulating invisibly between turns. It also makes the
[driver-as-router](../rooms/) model easy to follow later: the driver holds the state,
and the Mind is invoked into it.

## What defines a Mind

A Mind is its identity first, its tools second.

- **Identity** is the name, role, and voice, with the `SOUL.md` founding document as
  the system prompt it runs under. Identity is what makes the Mind behave like
  itself.
- **Model** is optional. A Mind can pin its own provider and model, so a panel can
  reason with genuinely different engines. Unpinned, it runs on the session's
  provider.
- **Capabilities** are an explicit, curated set of slugs (today, the `lens`
  capability) that scope what the Mind may do inside a room. Declaring nothing keeps
  the Mind text-only, the room default.

Identity is at the Mind level, and capabilities are not addressable. Only a Mind is a
participant you can put in a room or address in a transcript. A tool, a workflow, an
MCP server, or another rib is a capability a Mind invokes during its turn, behind the
harness permission layer, never a participant in its own right. A Mind can never
reach a tool the room does not already permit, even through a hand-edited record. See
[Lenses](../lenses/) for what the `lens` capability authorizes, and
[Rooms and strategies](../rooms/) for how a turn's tool rail is scoped.

## Genesis: authoring a Mind from a brief

**Genesis** writes a new Mind from a freeform brief. It is a workflow, not a button,
because authoring an identity needs words: you describe the agent you want, and one
agent turn does the rest.

Run it with the `/genesis` command, or with
`keelson workflow run chamber-genesis "{brief}"`. The turn reads your brief, decides
the Mind's name, role, and voice, composes the `SOUL.md` body and a roster tagline,
and then calls a single write seam to persist the Mind. The prompt asks for an honest
founding document: it describes who the Mind is and how it speaks, and does not invent
tools or credentials it does not have. It also ends with `Authored {name} ({slug})`,
using the tool-returned slug verbatim.

The write is deterministic and fails closed. If a Mind with the same slug already
exists, the write refuses rather than clobbering an existing soul, and the workflow
fails loudly instead of reporting success with nothing written. Once the Mind lands,
the roster collector reflects it as a card.

:::note
Genesis composes the identity; a small write tool persists it. Splitting the two keeps
the generative half in the prompt and the file-writing half testable. You never call
the write tool directly: run the workflow.
:::

### Starters

A fresh workspace has no Minds, so the roster offers a few preset archetypes as a
first move: Moneypenny (a chief of staff), Mycroft (a research partner), and Jarvis
(an engineering partner). Each is a brief, not a baked soul. Convening one runs
genesis to author fresh artifacts that capture the character's energy for your
workspace, from the model's own knowledge.

## What persists on disk

Each Mind is a directory under the rib's data home,
`{keelson-home}/rib-chamber/minds/{slug}/`:

- `SOUL.md` is the founding identity document, authored by an agent at genesis. It
  has a Persona, a Mission, and a Voice, and it is the system prompt the Mind runs
  under.
- `mind.json` is the structured record the roster reads: the slug, name, role, voice,
  a one-line tagline, an optional model and provider pin, and any capability slugs the
  Mind declared.
- `AGENT.md` is a short operating doctrine, seeded at genesis.
- `memory.md`, `rules.md`, and `log.md` are working documents. Genesis seeds them
  (memory and rules as empty templates, the log with a single genesis line). They are
  ordinary inspectable files you edit, not a hidden memory the agent writes to itself:
  nothing updates them between turns. Operator-authored content in them is folded into
  the system prompt when you open the Mind in a direct chat, durable memory and rules
  first, then the recent log.

Because a Mind is just files, it is cheap to create, easy to inspect, and versionable
in git. The slug is the directory name and the Mind's stable identity everywhere else:
its address in a transcript, and the argument to `/mind`. Slugs are path-safe by
construction (lowercase, kebab-case, guarded against traversal before they ever touch
the filesystem).

## Entering and retiring a Mind

Entering a Mind opens it as a direct one-to-one chat, seeded with its soul as the
system prompt. Use `/mind {slug}`, or the Enter action on the roster. The seed stacks
the Mind's identity (its `SOUL.md`, falling back to the tagline), then any real durable
memory, rules, and recent log, then a short set of direct-chat rules, all clamped to
the harness seed budget. If the Mind pins a model or provider, the seeded chat runs on
it.

A direct chat is one Mind with no peer. That is a turn, not a room. Minds talking to
each other only happens inside a [room](../rooms/).

Retiring a Mind removes its directory and drops it from the roster. It is the inverse
of genesis, and the one destructive action on the roster.

## Related

- [Rooms and strategies](../rooms/): put Minds in a room together.
- [Lenses](../lenses/): what a Mind can author during or after a room.
- [Concepts overview](../): the one pipeline genesis shares with rooms and lenses.
