---
title: Develop the rib locally
description: Clone the rib, link the contract from a local keelson checkout, wire it into a running harness, and run the pre-PR checks
sidebar:
  order: 6
---

Chamber is a Keelson rib, so hacking on it means running it inside a local
keelson harness. This guide takes you from a fresh clone to a live surface and
through the checks a pull request has to pass.

## Clone and install

Clone the rib next to your keelson checkout, then install its dependencies:

```bash
git clone https://github.com/danielscholl/keelson-rib-chamber.git
cd keelson-rib-chamber
bun install
```

The rib depends on `@keelson/shared` for the [Rib contract](https://danielscholl.github.io/keelson/docs/reference/rib-contract/),
but that dependency is an **optional peer**: `bun install` does not pull it. Tests
run without it because they stub the host seams, so a clean clone is already
testable. Typechecking is different: `tsc` needs the real contract types.

Link the contract from your local keelson checkout so typechecking resolves it:

```bash
bun link @keelson/shared
```

:::note
If `bun link` cannot find `@keelson/shared`, run `bun link` once inside the
`@keelson/shared` package of your keelson checkout to register it, then return
here and link it.
:::

## Wire into a running harness

The rib has no in-process runner of its own. To see it work you symlink it into a
keelson checkout and let the harness discover it at boot, exactly as a published
install would. The bundled script does the symlinking:

```bash
bun run link:keelson
```

That links the rib into `../keelson` (the sibling checkout) and prints the next
command. Point it elsewhere with `KEELSON_DIR`:

```bash
KEELSON_DIR=/path/to/keelson bun run link:keelson
```

Then start the harness with only Chamber activated:

```bash
cd ../keelson
KEELSON_RIBS=chamber bun dev
```

`KEELSON_RIBS=chamber` is read by the harness, not the rib: it filters discovery
down to this one rib so nothing else is in the way. Open
[http://127.0.0.1:5173](http://127.0.0.1:5173) and select the **Chamber** tab.
If you do not see it, open the **Ribs** tab and confirm Chamber activated.

A room turn and a genesis run are billed agent calls, so the harness needs a
provider. Use Copilot or Claude if you have one configured, or run the harness
with `KEELSON_PROVIDERS=stub` for an offline echo provider that exercises the
wiring without spending tokens:

```bash
cd ../keelson
KEELSON_PROVIDERS=stub KEELSON_RIBS=chamber bun dev
```

The rib spawns no external CLIs. Its only subprocesses are `bun` running its own
bundled collector scripts, so there is nothing else to install.

## Run the checks before a PR

Three checks gate a pull request. Run all three from the rib's directory:

```bash
bun run check      # Biome lint and format
bun run typecheck  # tsc against @keelson/shared (must be linked)
bun test           # runs with stubbed host seams
```

`bun run check` is lint and format; `bun run check:fix` applies the safe fixes.
`bun run typecheck` is the check that needs `@keelson/shared` linked, so run
`bun link @keelson/shared` first if you skipped it. `bun test` needs no provider
and no harness: it stubs the host seams.

## Build the docs

This site is a self-contained Astro Starlight project under `docs/`, with its own
install step. Build it before changing any page:

```bash
cd docs
bun install
bun run build
```

## Related

- [Install Chamber](../install/): wire the published rib into a harness.
- [Run a room](../run-a-room/): drive the surface you just brought up.
- [Keelson harness docs](https://danielscholl.github.io/keelson/): the host that loads the rib.
- [Rib contract](https://danielscholl.github.io/keelson/docs/reference/rib-contract/): the interface `@keelson/shared` defines.
