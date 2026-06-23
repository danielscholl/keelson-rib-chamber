---
title: Install Chamber into Keelson
description: Add the Chamber rib to a running Keelson, start the server, and open the Chamber surface
sidebar:
  order: 2
---

Chamber is a [Keelson](https://danielscholl.github.io/keelson/) rib: a package
the harness discovers and attaches through one typed contract. This guide adds
it to a Keelson you already run. If you want to hack on the rib's source
instead, see [Develop locally](../develop-locally/).

## Add the rib

From your Keelson checkout, add the package and start the server:

```bash
keelson rib add https://github.com/danielscholl/keelson-rib-chamber
keelson start
```

`keelson rib add` installs the package alongside the harness. The harness
discovers any installed `@keelson/rib-*` package at boot, so the install is all
the wiring Chamber needs.

## Choose which ribs activate

The harness reads `KEELSON_RIBS` to decide which discovered ribs to activate.
Leave it unset and every discovered rib activates, Chamber included. Set it to a
comma-separated list to narrow the set. Chamber's id is `chamber`:

```bash
KEELSON_RIBS=chamber keelson start
```

That variable is read by the harness, not by Chamber. The rib reads no
`KEELSON_*` environment variables of its own and has no env-based config.

## What Chamber needs

- **A configured provider.** Rooms and lenses run real agent turns, so the
  harness must have a coding-agent provider set up, either Copilot or Claude. To
  try the wiring offline before you connect one, run with
  `KEELSON_PROVIDERS=stub`, which lets the surface and tools come up without
  billing a real turn.
- **No external CLIs.** Chamber does its work through harness seams and the
  local filesystem. It shells out to nothing: no `git`, no `gh`, no `docker`.
- **The shared contract.** Chamber depends on `@keelson/shared`, which the
  harness provides as a peer dependency. You do not install it separately.

## Open the surface

With the server up, open the Chamber surface and select the **Chamber** tab:

```text
http://127.0.0.1:7878
```

### The cold-start view

A fresh install has no Minds yet, so the surface opens quiet. The **Roster** at
the top is empty and offers your first move: three preset archetypes,
**Moneypenny**, **Mycroft**, and **Jarvis**, each one a brief you can author
into a Mind. The **Briefing** footer sits quiet until there is something to
report. Authoring a Mind from one of the presets, or describing your own, is the
intended first step. See [Author a Mind](../author-a-mind/) for that path.

## Confirm the rib is wired

`keelson` reports a rib's readiness through its `authStatus`. Chamber reads
**wired** once three conditions hold: its data home is writable, and the
harness has handed it the snapshot-manager, agent-turn, and region-registration
seams. When all three are present the status reads:

```text
rooms & lenses wired; provider resolved at turn time
```

That phrasing is deliberate. Chamber cannot introspect the provider, which the
harness resolves at turn time, so a wired status does not promise a provider is
configured. A missing provider surfaces at your first room turn, not here. If
the status is not wired, the message names the gap: a non-writable data home, or
a seam the harness has not supplied.

## Related

- [Author a Mind](../author-a-mind/): the first move from the cold-start roster.
- [Run a room](../run-a-room/): put Minds in a room once you have a few.
- [Develop locally](../develop-locally/): link the rib into a Keelson checkout to work on its source.
- [Keelson documentation](https://danielscholl.github.io/keelson/): the harness, providers, and the rib contract this build on.
