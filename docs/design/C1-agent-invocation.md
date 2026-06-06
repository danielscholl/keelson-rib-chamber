# C1 — Rib-initiated agent invocation

> **Status: decided (design). Gates Phase 2 (rooms).** This records the seam
> the Chamber room loop runs on. No base code is written yet — the contract
> below must land in `@keelson/shared` (and the impl in `apps/server`) before
> Phase 2 begins. File/line references are to the Keelson base
> (`../keelson`) verified at decision time.

## The decision (one paragraph)

Add a single **provider-shaped seam — `ctx.runAgentTurn`** — to `RibContext`,
commit its contract from day one, and ship it in **two phases behind one
signature**: an MVP impl that may shell a coding-agent CLI, then a
provider-routed impl that resolves through the registry. The Chamber room
driver is written **once** against `ctx.runAgentTurn` and never changes when
the impl swaps. This takes the reversibility of a CLI shell without writing a
provider-bypassing call into rib code that we'd later have to migrate off, and
inherits provider pinning / redaction / credentials the instant the impl
swaps — with **zero room-loop change**.

This supersedes the two framings in [ARCHITECTURE.md §9 C1](../ARCHITECTURE.md)
("MVP = `getExec().runText`" vs "real = `ctx.runAgentTurn`"): they are not an
either/or — they are the **two impls of the same seam**, in order.

## Why not the obvious alternatives

| Considered | Verdict | Why |
|---|---|---|
| **CLI shell in rib code** (`getExec().runText("claude")`) | rejected | Ships zero base change, but writes a provider-bypassing API *into the rib* that Phase-2 hardening must rip back out. Reversibility win, migration loss. |
| **Full provider seam, registry-only from day one** | rejected for v1 | Correct end state, but front-loads the hardest code (stream tee, abort cancellation, provider resolution) before a single room turn runs. Lowest judge score on testability/time-to-Phase-2. |
| **Evolvable seam, CLI impl first** | **chosen** | One call site, contract committed now, impl swaps later. Confines the CLI's provider blind spots to one server module, swappable without a rib edit. |

## The contract (lands in `@keelson/shared/src/rib.ts`)

Types only — **no `@keelson/providers` import**. `MessageChunk` is already
exported from `@keelson/shared/chat.ts`.

```ts
interface RibAgentTurnRequest {
  prompt: string;
  system?: string;
  provider?: string;        // HINT not pin; undefined => KEELSON_WORKFLOW_PROVIDER ?? first non-stub
  model?: string;
  tools?: readonly { name: string; [k: string]: unknown }[]; // omit => text-only (room default)
  allowedTools?: readonly string[];
  disallowedTools?: readonly string[];
  abortSignal?: AbortSignal;  // room dispose() aborts in-flight turns
  timeoutMs?: number;         // default KEELSON_WORKFLOW_PROMPT_TIMEOUT_S ?? 10min
  cwd?: string;               // default process.cwd()
  resumeSessionId?: string;   // accepted now, inert until provider capabilities allow
}

interface RibAgentTurnResult {
  status: "ok" | "aborted" | "timeout" | "error";
  text: string;
  error?: string;
  providerId?: string;        // "cli:<bin>" for the MVP impl; real id once registry-routed
  sessionId?: string;
}

interface RibAgentTurn {
  stream: AsyncIterable<MessageChunk>;   // MVP impl yields a single synthetic text chunk
  result: Promise<RibAgentTurnResult>;   // settles exactly once after stream completes
}

interface RibContext {
  // ...existing getExec / getSnapshotManager? / getCredential? ...
  runAgentTurn?: (req: RibAgentTurnRequest) => RibAgentTurn;  // NEW, optional
}
```

`runAgentTurn?` is **optional**, matching the existing `getSnapshotManager?` /
`getCredential?` pattern (`rib.ts:84-93`) so test contexts and the base
`RibContext` in `bootstrap.ts:159-161` stay valid. A rib that needs rooms but
finds it absent fails closed (`{ ok: false, error: "rooms unavailable" }`).

The seam returns a **settled `{ stream, result }` dual-handle**, not a bare
`AsyncGenerator` whose return value you fish out with `(await gen.next()).value`
— that idiom was flagged broken in review. `stream` is for live progress;
`result` settles once.

## The room-loop call site — fire-and-return (load-bearing)

The room loop **must not** `await` the turn inside `onAction`. The action route
awaits the handler synchronously (`ribs-handler.ts:100`,
`await handler(parsed.data)`) and the HTTP server caps the socket at
`IDLE_TIMEOUT_S = 60` (`index.ts:90`, applied `index.ts:294`). A blocking
10-minute room turn over this route **silently drops the connection**. So:

```ts
async onAction(action, ctx) {
  if (action.type === "room-next") {
    if (!ctx.runAgentTurn) return { ok: false, error: "rooms unavailable: no agent-turn capability" };
    void this.driver.step(ctx);   // do NOT await — return before the 60s idleTimeout
    return { ok: true };          // SPA observes turn results via WS frames on rib:chamber:room
  }
}
// driver.step: const turn = ctx.runAgentTurn!(req);
//   for await (const c of turn.stream) { /* accumulate; optional throttled partial publish */ }
//   const r = await turn.result; append to transcript;
//   await ctx.getSnapshotManager!().recompose("rib:chamber:room");
```

The director gate (`room-next`, `room-inject`, `room-stop` — the canonical
`action.type` literals, see [A2A-communication.md](./A2A-communication.md)) is
event-driven: each control is a discrete `onAction` dispatch; the turn runs
detached and publishes results as `snapshot_update` frames over the existing WS.

## Two-phase implementation

**Phase 2 (MVP) — what ships now:**
- Land the seam types + optional field in `@keelson/shared` **first** (this is the committed contract that gates Phase 2).
- New `apps/server/src/rib-agent-turn.ts`: `makeRibAgentTurn(deps)` returning `(req) => RibAgentTurn`. MVP body shells `claude -p <prompt> --output-format json --append-system-prompt <system> [--model] [--resume]` via the existing `runJSON`, maps `{ result, session_id }` → `RibAgentTurnResult`, wraps as a single synthetic text chunk + settled `result`.
- Wire through `applyRibs` (`ribs.ts:166-172` spread) and `bootstrapRibs` (`bootstrap.ts`), spread-guarded. **Not** namespace-scoped (provider routing is global), but pass `rib.id` through for future per-rib policy/logging.
- Chamber room driver written once against `ctx.runAgentTurn`, fire-and-return, publishing to **one** key `rib:chamber:room` with a participant-indexed payload (a single active room sidesteps the scoped manager's register discipline, `scoped-snapshot-manager.ts:42`).
- Room turns default to **text-only** (`tools` omitted — no Bash/Edit between conversation turns).
- Tests use a fake `ctx.runAgentTurn` (a scripted `{ stream, result }`) — provider-free, matching the established optional-field fake pattern.

**Phase 2 hardening (real fix) — swap the impl body only:**
- Resolve provider lazily **at call time** via `isRegisteredProvider` + `getAgentProvider` (`registry.ts:21-27`). Safe: boot order is providers (`bootstrap.ts:67`) → ribs (`:152`) → promptHandler (`:367`), so the registry is populated when `runAgentTurn` fires, even though the prompt handler is not.
- Apply `parseToolDenylist(KEELSON_WORKFLOW_TOOL_DENYLIST)` to `req.tools`; race `provider.sendQuery` against an `AbortController` fed by `req.abortSignal` + timeout.
- **Fire `iterator.return()` on abort** — the Claude SDK ignores its own `abortSignal` (`prompt.ts:276-288`); without this a hung room turn cannot be cancelled by `dispose()`.
- Tee the `sendQuery` generator into the consumer `stream` and the `result` accumulator with a bounded buffer (**real, unit-tested work — not a free extraction**).
- The room loop, transcript model, snapshot publishing, `onAction` dispatch, and every test except the impl's own unit tests are **unchanged**. Pinning, credentials (baked in at `registerClaudeProvider` time — the rib's own `getCredential` is deliberately **not** forwarded), redaction, and denylist are inherited the instant the body swaps.

## Base changes required

| File | Change | Kind |
|---|---|---|
| `packages/shared/src/rib.ts` | Add `RibAgentTurnRequest/Result/RibAgentTurn` + optional `runAgentTurn?` on `RibContext`. No new deps (reuse `MessageChunk`). | additive |
| `apps/server/src/rib-agent-turn.ts` | **New.** `makeRibAgentTurn(deps)`. MVP body = CLI via `runJSON`; Phase-2 body = registry + denylist + abort/timeout + `iterator.return()` + stream tee. | additive |
| `apps/server/src/ribs.ts` | Add optional `runAgentTurn?` to `ApplyRibsOptions`; in the per-rib spread (`:166-172`) add `...(opts.runAgentTurn ? { runAgentTurn: (req) => opts.runAgentTurn!(rib.id, req) } : {})`. Not namespace-scoped. | additive |
| `apps/server/src/bootstrap.ts` | In `bootstrapRibs`, construct `makeRibAgentTurn` and pass to `applyRibs` (spread-guarded). Add optional `runAgentTurn?` to `BootstrapRibsOptions` for test injection. Resolution lazy. | additive |
| `apps/server/src/bootstrap.ts` (`bootstrapPromptHandler`) | **Phase-2 only, behavior-preserving:** factor the provider-resolution closure (`:401-413`) into a `resolveWorkflowProvider()` shared by the prompt handler and `makeRibAgentTurn`. Keep the boot-time `console.warn` side-effects (`:370-398`, `:418-425`) firing exactly once in `bootstrapPromptHandler` — the shared helper must be warning-free. Reuse exported `parseToolDenylist` / `parsePromptTimeoutMs`. | refactor |
| `apps/server/src/ribs-handler.ts` | **No code change.** Documents that the room loop drives `onAction` fire-and-return; the 60s cap is a contract on the *rib*, not enforced by the base. | none |

## Open risks (carry into Phase 2)

- **HTTP idleTimeout (verified, critical).** A future contributor who `await`s the turn inside `onAction` will silently drop the socket. Mitigation: document loudly; consider a helper that enforces detached dispatch.
- **Stream tee complexity.** `IAgentProvider.sendQuery` is a single-consumer `AsyncGenerator`; splitting into `{ stream }` + `{ result }` needs a bounded-buffer tee with defined backpressure/abort behavior. No tee utility exists today — budget a dedicated unit-tested helper at the swap.
- **`consume()` is a re-implementation, not an extraction.** The abort/timeout machinery (`prompt.ts:133-399`) closes over handler-scope locals and can't be lifted as-is; the Phase-2 impl re-writes the hardest-to-get-right code. Mitigation: a shared low-level `driveTurn(provider, opts)` helper consumed by both `prompt.ts` and `rib-agent-turn.ts`.
- **`iterator.return()` cancellation (verified load-bearing).** Easy to omit and still pass tests against a well-behaved stub. Must be present or `dispose()` cannot cancel a hung turn.
- **Provider divergence visibility (MVP only).** While CLI-backed, room turns ignore `KEELSON_WORKFLOW_PROVIDER` (the CLI uses ambient auth). Stamp `result.providerId = "cli:<bin>"` and log at dispatch so the divergence is observable, not silent.
- **Transcript token growth.** Rebuilding per-turn context from a growing transcript across N participants grows the prompt linearly — needs a documented truncation/summarization strategy before rooms scale.
- **Concurrent-publish coalescing.** `SnapshotManager` coalesces concurrent recomposes and drops intermediate frames. Phase 2's serial director gate (one turn at a time) avoids this; a future concurrent room must adopt the `applyRibs` dirty-flag pump (`ribs.ts:261-277`) or lift it into a shared helper.

## Deferred (explicitly out of scope for v1)

- **`KEELSON_RIB_PROVIDER`** — premature config sprawl. Room turns inherit `KEELSON_WORKFLOW_PROVIDER`; add a separate var only on demonstrated operator need.
- **True token-streaming to the SPA** — a new pub/sub surface. v1 delivers progress as composed `snapshot_update` frames on `rib:chamber:room` (optionally throttled), not raw per-chunk recompose (which the manager coalesces anyway).

## Provenance

Reached via a multi-design evaluation: five readers mapped the base subsystems
(`rib.ts`, the provider registry, `SnapshotManager`, the executor prompt-node
path, server rib wiring) against the real source; three designers drafted
competing seams (ship-fastest CLI shell, full provider seam, evolvable seam);
nine adversarial judges scored them on base-churn / room-loop fit /
testability; the evolvable seam won (4.0 vs 3.67 vs 3.33 mean) and grafted the
runners-up's best ideas (CLI reversibility, provider-fidelity rationale, the
settled dual-handle). The five load-bearing claims above were independently
re-verified against base source before this record was written.
