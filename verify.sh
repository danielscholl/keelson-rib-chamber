#!/usr/bin/env bash
set -euo pipefail

bun run check
bun run typecheck
bun test
