# Contributing to @keelson/rib-chamber

Thanks for your interest in the Chamber rib. This document captures the
conventions and required checks for every pull request. Chamber is a
[Keelson](https://github.com/danielscholl/keelson) rib — a standalone package
the harness discovers at runtime — so its contribution flow is lighter than the
keelson monorepo's. Where this file is silent, the
[keelson CONTRIBUTING guide](https://github.com/danielscholl/keelson/blob/main/CONTRIBUTING.md)
is the parent.

## Development environment

You need [Bun](https://bun.sh/) on PATH. The rib has one runtime peer,
`@keelson/shared`, which the harness provides at runtime; for local development
you resolve it from a keelson checkout.

```bash
git clone https://github.com/danielscholl/keelson-rib-chamber.git
cd keelson-rib-chamber
bun install
bun link @keelson/shared   # resolves the contract from your local keelson checkout
                           # (or recreate node_modules/@keelson/shared by hand)
```

`@keelson/shared` is declared an **optional** peer dependency: the rib installs
and its tests run without it (they use stubs), but typechecking against the
`Rib` contract needs it linked. CI resolves it the same way — a symlink to a
`danielscholl/keelson` checkout's `packages/shared`, sourced from `main`, so a
harness contract change that breaks this rib turns CI red here.

To exercise the rib inside a running harness, link it into a local keelson and
launch the dev server:

```bash
bun run link:keelson   # defaults to ../keelson; override with KEELSON_DIR
cd ../keelson && KEELSON_RIBS=chamber bun dev
```

Then open `http://127.0.0.1:5173` and select the **Chamber** tab (or **Ribs**).
Chamber needs a configured provider (Copilot/Claude, or `KEELSON_PROVIDERS=stub`
to try the wiring) — no external CLIs.

## Required checks before opening a PR

Every PR must keep these green. CI runs the same commands.

```bash
bun run check       # Biome lint + format check
bun run typecheck   # tsc --noEmit (needs @keelson/shared linked)
bun test            # runs with stubs; CI sets KEELSON_USE_STUBS=1
```

Run `bun run check:fix` to auto-fix the safe lint and format issues.

If you touched the documentation site under `docs/`, build it too — `docs.yml`
runs the same build on every `docs/**` change:

```bash
cd docs && bun install && bun run build
```

Documentation contributions follow [docs/STYLE.md](docs/STYLE.md), which extends
the keelson documentation style guide.

## Commit messages

Conventional commit format (`feat:`, `fix:`, `chore:`, `docs:`, `refactor:`,
`test:`). One sentence in the subject (under 70 characters). Body — when
needed — explains *why*, not *what*; the diff already shows the what.

## Pull request hygiene

- Keep PRs scoped to one thing. Split refactors out of feature work.
- The PR description should answer: what changed, why now, how it was tested.
- Don't add new abstractions ahead of a concrete second caller.
- Don't add comments that narrate the change — that belongs in the PR
  description, not the source. Add a comment only when it captures a non-obvious
  *why* a future reader would need.

## Architecture rules

- All multi-agent machinery — genesis, rooms, strategies, agent-authored
  lenses — lives in this rib. The harness stays domain-free.
- The rib ships **zero React** into the trusted SPA; surfaces render through the
  canvas `board` view, not hand-coded UI.
- The rib attaches to the harness only through the `Rib` contract
  (`@keelson/shared`). Don't reach around it into harness internals.
- Orchestration strategies are pure: they decide turns, the rib drives I/O.
  Keep provider and host coupling out of the strategy layer.

## License and attribution

The rib is Apache-2.0 (see [LICENSE](LICENSE)). It is a clean-room port of
[Chamber](https://github.com/ianphil/chamber), credited in [NOTICE](NOTICE). A
change that ports or shells new upstream tooling must carry its attribution
forward into `NOTICE` and the README Acknowledgments.

## Security

For security-sensitive reports, see keelson's
[SECURITY.md](https://github.com/danielscholl/keelson/blob/main/SECURITY.md).
Please do not file public GitHub issues for vulnerabilities.
