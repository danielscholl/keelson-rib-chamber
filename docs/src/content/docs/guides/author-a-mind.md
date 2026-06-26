---
title: Author a mind
description: Create a persistent agent identity with genesis, enter it for a direct chat, and retire it when you are done
sidebar:
  order: 3
---

A **Mind** is a persistent agent identity: a name, a role, a voice, and a
founding document. This guide walks the operator tasks: author one with genesis,
enter it for a direct chat, declare what it may do, and retire it. For why a Mind
is shaped this way, see [Minds and genesis](../../concepts/minds/).

## Author one with genesis

**Genesis** writes a new Mind from a freeform brief. It is a workflow that runs
one agent turn, not a button: you describe the agent you want, and the turn does
the authoring. There are two ways to start it.

From chat, use the slash command:

```text
/genesis a meticulous release manager who tracks every open PR
```

From the CLI, run the workflow directly:

```bash
keelson workflow run chamber-genesis "a meticulous release manager who tracks every open PR"
```

The turn reads your brief, decides the Mind's name, a short role title, and its
voice, composes the founding document and a one-line roster tagline, then persists
the Mind through a single write seam. It ends with `Authored {name} ({slug})`,
using the slug value the tool returned. When it lands, the roster reflects it as
a card.

:::note
Genesis composes the identity; a small write tool persists it. You never call that
tool directly. Run the workflow.
:::

## Start from a preset

A fresh workspace has no Minds, so the roster offers three preset archetypes as a
first move:

- **Moneypenny**, a chief of staff for briefings, priorities, and follow-through.
- **Mycroft**, a research partner for synthesis, patterns, and framing.
- **Jarvis**, an engineering partner for diagnostics, telemetry, and tradeoffs.

Each preset is a brief, not a baked soul. Authoring from a preset runs genesis to
write fresh artifacts that capture the character's energy for your workspace, from
the model's own knowledge. The same screen also offers a describe-your-own option,
which is the `/genesis` path with the brief you type.

## What genesis writes on disk

A Mind is a directory under the rib's data home,
`{keelson-home}/rib-chamber/minds/{slug}/`. Genesis populates it:

| File | What it holds |
|---|---|
| `SOUL.md` | The founding identity, authored by the turn: a **Persona**, a **Mission**, and a **Voice** section. This is the system prompt the Mind runs under. |
| `mind.json` | The structured roster record: slug, name, role, voice, the one-line tagline, and any declared capabilities. |
| `AGENT.md` | A seeded operating doctrine: take one turn at a time, stay in character, never claim another speaker's identity. |
| `memory.md`, `rules.md` | Seeded empty. `rules.md` is operator-authored. `memory.md` you can edit too, but the Mind also rewrites it for itself when a room closes (see [What a Mind remembers](../../concepts/minds/#what-a-mind-remembers)). |
| `log.md` | Seeded with one entry recording the genesis. |

The slug is the directory name and the Mind's stable identity everywhere else. It
is derived from the name, path-safe by construction (lowercase, kebab-case,
guarded against traversal before it ever touches the filesystem).

:::note
Genesis can pin `model` and `provider` when you pass them as workflow inputs.
You can also set or clear the pin later from the roster card's **Set model…**
action. `provider` is only kept when `model` is set.
:::

With no pin, the provider depends on where the Mind runs: entering it for a direct
chat keeps the chat surface's current provider, while a room turn resolves through
Keelson's agent-turn routing (a provider hint, then `KEELSON_WORKFLOW_PROVIDER`,
then the first registered non-stub provider), not a surface session.

## Enter a Mind

Entering a Mind opens it as a direct one-to-one chat, seeded with its identity.
Use the slash command:

```text
/mind release-manager
```

The command type-aheads slugs from the roster. The roster Enter action does the
same thing. Both produce one seed: the Mind's `SOUL.md` (falling back to its
tagline if the soul is empty), then any real durable memory, rules, and recent
log, then a short set of direct-chat rules, all clamped to the harness seed budget.
A brand-new Mind whose memory and rules are still empty contributes none of those
sections; only real content you add later shows up.

A direct chat is one Mind with no peer: a turn, not a room. Putting several Minds
in conversation is a [room](../run-a-room/).

## Declare capabilities

By default a Mind is text-only, which is the room default. To let a Mind author a
[lens](../author-a-lens/) (a canvas board) during a room turn, declare the `lens`
capability. The genesis turn asks for an optional list of capability slugs, so ask
for the `lens` capability in your brief when you want a Mind that visualizes its
work.

Two additional capabilities apply to coding rooms (rooms started with `coding: true`
and a `projectId`): `read` lets a Mind read files in the room's project; `code` lets
it run Bash, Edit, and Write. A coding review room requires the author Mind to declare
`code` and the reviewer Mind to declare at least `read`.

The vocabulary is curated, so declaring anything unknown is dropped. Declaring
nothing keeps the Mind conversation-only. A capability scopes what a Mind may do
inside a room turn; it never makes the Mind reach a tool the room does not already
permit. See [Rooms and strategies](../../concepts/rooms/) for how a turn's tool
rail is scoped.

## Retire a Mind

The roster Retire action removes the Mind's directory and every file in it, then
drops it from the roster. It is the one destructive action on the roster, and the
inverse of genesis. There is no slash command for it, by design: retiring is a
deliberate click, not a typed command.

## Related

- [Minds and genesis](../../concepts/minds/): why a Mind is shaped this way.
- [Run a room](../run-a-room/): put several Minds in conversation.
- [Author a lens](../author-a-lens/): what the `lens` capability authorizes.
- [Workflows](../../reference/workflows/): the `chamber-genesis` workflow contract.
