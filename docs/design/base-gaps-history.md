# Keelson base-gap analysis (historical)

> **Historical record.** This is the gating analysis that sequenced Chamber's
> build against the Keelson base — the `C1`–`C5` gaps, mapped to the OSDU rib's
> `G0`–`G4` virtuous cycle. It is preserved for context; it does **not** describe
> the current state. As of the generative-half build, all of these are resolved
> except `C4` (partial/streamed board frames), which is still a whole-frame MVP.
> For current architecture see [../ARCHITECTURE.md](../ARCHITECTURE.md).

| Gap | What it gated | Resolution |
|---|---|---|
| `C1` | Run an agent turn from rib code | ✅ `ctx.runAgentTurn`, registry-routed (provider pinning, redaction, credentials) |
| `C2` | Dynamic / agent-authored view registration | ✅ `ctx.registerRegion` — a lens registers its own surface region at runtime |
| `C3` | Rib persistent data home | ✅ `ctx.getDataDir` → `<keelson-home>/rib-<id>` |
| `C4` | Streaming / partial board frames | ↔ whole-frame today; partial deferred |
| `C5` | Dynamic surface regions (N participants) | ✅ `ctx.registerRegion` — a room registers its own region |

---

The same virtuous cycle the OSDU rib ran with `G0`–`G4`: each gap below is
**domain-free and reusable by any rib**. Coordinate sequencing with whoever is
working the Keelson base, since these touch the shared `Rib` contract /
`RibContext`.

### C1 — Agent invocation from a rib *(load-bearing — **wired**, see [C1-agent-invocation.md](./C1-agent-invocation.md))*
**Landed.** The seam types + optional `ctx.runAgentTurn?` field shipped in
`@keelson/shared`, with a CLI-backed MVP impl (`makeRibAgentTurn`,
`claude -p … --output-format json` adapted to the `{ stream, result }`
dual-handle) bootstrapped in `apps/server`, since superseded by a registry-routed
provider impl that inherits provider pinning, redaction, and credentials behind
the same signature. The room driver consumes it through `registerTools`. Original
problem statement, kept for the record: `RibContext` exposed `getExec`,
`getSnapshotManager`, `getCredential` — but no way to **run an agent turn**. The
entire room loop is "run a turn," so this gated Phase 2.
- **Decision:** add one **provider-shaped `ctx.runAgentTurn` seam** to
  `RibContext` (optional field, like `getSnapshotManager?`), with the contract
  committed up front and **two impls behind one signature**: a CLI-backed MVP,
  then a registry-routed real fix that inherits provider pinning
  (`KEELSON_WORKFLOW_PROVIDER`), redaction, and credentials with **zero
  room-loop change**. The MVP-shell vs real-seam framing below was *not* an
  either/or — they are the two impls of the same seam, in order.
- **Load-bearing constraint surfaced during design (verified):** the action
  route awaits `onAction` synchronously (`ribs-handler.ts:100`) under a 60s
  socket cap (`index.ts:90`), so the room loop must drive turns
  **fire-and-return** (`void driver.step(ctx); return { ok: true }`) and publish
  results as WS snapshot frames — never a blocking awaited turn.
- See the design record for the full contract, base changes, and open risks.

### C2 — Dynamic / agent-authored view registration *(**wired**)*
`views[]` is static at activation. An agent-authored lens appears at *runtime*.
Snapshot keys can already be registered imperatively
(`getSnapshotManager().register(key, …)`), but the **UI view binding** was
static — there was no way to surface a new panel after boot.
- **Resolved:** `ctx.registerRegion(surfaceId, region)` lets a rib add (and
  unregister) a surface region at runtime and nudges the SPA to re-fetch the
  manifest, so a Mind-authored `rib:chamber:lens:*` key becomes a live panel.
  This is the literal "agents create their own lenses" feature.

### C3 — Rib persistent data home — **landed**
Minds/transcripts need a blessed writable location.
- **Resolved:** `ctx.getDataDir()` on `RibContext` returns a per-rib directory
  under the keelson home (`<keelson-home>/rib-<rib-id>`). Chamber captures it at
  activation and no longer self-resolves via `KEELSON_WORKSPACE`.

### C4 — Streaming / partial board frames *(verify first)*
A turn that streams tokens into a board region needs incremental frame updates,
not just whole-frame replacement. The base's recent surface work (loading
shimmer / pulse) suggests partial frames may already exist.
- **Action:** verify what `SnapshotManager` supports before building; this may be
  a no-op. Still a whole-frame MVP today.

### C5 — Dynamic surface regions *(**wired**)*
A room has a variable participant count; the surface layout
(`rows[].columns[]`) was static.
- **Resolved:** `ctx.registerRegion` lets a room register its own surface region
  at runtime, so the layout is no longer fixed at activation. (The earlier MVP
  workaround — one room board with N cards/rows and no new regions — is no longer
  needed.)

**Dependency order (as built):** Phase 0 needed **nothing** (seam proof) →
Phase 1 needed **C3** → Phase 2 needed **C1** (and settled **C4** as
whole-frame) → Phase 3 needed **C2** + **C5**. All but `C4`'s partial-frame
variant have landed in `@keelson/shared`.
