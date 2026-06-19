# Chamber Rib — Phase 3 Design (group-chat / open-floor / true concurrent / N-party)

*Final synthesized design. Buildable from slice 1. Every `file:line` citation verified against the current tree (`keelson-rib-chamber` at HEAD, `keelson` base at `bbb53fe`). Drop into `docs/design/`.*

> **Implementation note (Slices 1 + 1.5 as built).** Slice 1's deliverable is
> *stripping* (keeping control directives out of rendered history), not *parsing*.
> So `src/routing.ts` ships only the **live stripping core** — `CONTROL_ACTIONS` +
> `extractTrailingJsonObject` + `stripControlJson`, wired into `renderTranscript`.
> **Deferred to their consuming slices (2/3):** the control-directive parsers
> (`parseModeratorDecision` / `parseNomination`, with `extractJsonObject`) and the
> routing-*fold* helpers (`speakerCounts` / `leastSpoken` / `nextUnheard` /
> `allHeardInCycle` / `endVoteRatio` / `roundOf`). They have no caller until
> routing exists, and `parseModeratorDecision`'s first-object parse is best
> validated against a real moderator turn (Slice 2) — landing them now would be a
> seam ahead of its consumer, and the route⇒strip integration test belongs with
> the parser's caller in Slice 3.
>
> **`StrategyInput` shipped as `{ room, transcript }`** — the §1 sketch's separate
> `round` field was dropped as redundant: `round` lives on `room.round` (the
> authoritative cursor), so a strategy reads `input.room.round` rather than a
> mirror that could drift.

---

## Changes from review

Material corrections folded in from the three critiques (boundary/invariants, concurrency/coalescing, scope/sequencing), with code re-verification of each:

1. **Cancellation rationale rewritten — the `#118` + `iterator.return()` citations were fabricated and are deleted.** Verified: PR #118 (`1d845f4`) is *provider-registry routing* — it touched only `rib-agent-turn.ts`, `rib.ts`, and the test; it added provider resolution, not cancellation. `grep` for `iterator.return`/`\.return(` across `apps/` + `packages/` returns **exactly one** non-test hit: `packages/workflows/src/handlers/prompt.ts:297-318` — the *workflow* prompt path, a different code path. The rib seam (`rib-agent-turn.ts:155-161`) uses a plain `for await … break`. The **real** teardown mechanism (provider-dependent, predates #118, best-effort): the claude provider forwards `options.abortSignal` into its own controller (`claude/provider.ts:113`), passes it to the SDK (`:136`), breaks the consumer loop on abort (`:207-217`), the producer's `finally { queue.close() }` (`:201`) resolves a parked `queue.next()` with `null` (`chunk-queue.ts:32-50`), and `handle.interrupt()` runs only when `abortedDuringStream` **and** the SDK is in streaming-input mode (`:225-234`). This is enough to ship concurrent, but the design now states it as *best-effort, provider-dependent* — which is also why fresh-slug-per-start is **kept** (§7).

2. **Moderator identity is now explicit: `config.moderator` MUST NOT be in `room.participants`.** (Boundary critic, [major].) Verified the failure mode: `isValidNominee` (`room.ts:188-190`) accepts *any* `room.participants` member, and the board fans `room.participants` into both speaker `segments` (`boards/room.ts:9-12`, counting every `role:"agent"` entry) and "Call on `<slug>`" controls (`boards/room.ts:75`). If the moderator were a participant, a director could nominate it as a speaker (breaking the "moderator only routes" contract) and it would show a phantom speaker count. Making the moderator a separate roster slug (not a participant) closes all three holes for free: never a segment, never a "Call on" target, and `isValidNominee` naturally rejects it as a speaker. The A2A doc's own model agrees (A2A:166-168: "a group-chat moderator that **is** a Mind authors with its own `MindSlug`") — it is a Mind, just not in the *speaker* set. The moderator's deliberation text stays visible on the board (§2e); only its routing-JSON tail is stripped from the next speaker's prompt (§8).

3. **Multi-turn / parallel steps are budget-gated *before* spawning, not allowed to overshoot.** (All three critics, [major]/[minor].) Verified: `runSpeakTurn`'s terminal check is `advanced.turnIndex >= advanced.turnBudget` *after* a +1 (`room.ts:446`), which composes correctly for a single turn but lets a 2-turn `moderate` or an N-turn `speak-parallel` cross the cap. New rule: **a step never starts a turn it cannot complete within `turnBudget`** — re-check between the moderator turn and the speaker turn in `moderate`; pre-check (and trim or close) before spawning the parallel fan-out. `turnBudget` stays the single hard cap (the `MAX_HOPS` analog), now honored per-batch.

4. **Slice plan resequenced: the `Strategy` → `StrategyInput` signature widening is promoted to its own Slice 1.5 (its own green checkpoint), and Slice 1 (parsers) no longer touches behavior.** (Scope critic, [major].) Verified the signature change is breaking: `sequential.ts:7` is `(room) =>`, the registry test calls `sequential(room)` directly (`sequential.test.ts:21-23,41`), and the driver call site is `getStrategy(room.strategy)(room)` (`room.ts:314`). That migration is a prerequisite for *all three* new strategies, so it gets its own isolated, behavior-identical slice instead of riding inside group-chat.

5. **The strategy↔driver-branch coupling is made explicit per slice.** (Scope critic, [major].) Verified: `RoomDriverDeps` (`room.ts:15-32`) has no strategy port; the driver always resolves via the real registry (`room.ts:314`), and there is no strategy fake in `fakes.ts`. Consequence stated plainly: each new step kind's driver branch and its producing strategy **must land in the same slice**, because `driver.test.ts` can only exercise a branch through `getStrategy`. (We deliberately do *not* add a strategy-injection port — that would be a new driver-contract seam for test convenience; co-locating branch+strategy is cheaper and matches how the suite already works.)

6. **A new multi-gate test fake is required for Slice 4 and is now in-scope; the "no new fake infrastructure" claim is dropped.** (All three critics.) Verified mechanically: the driver takes exactly **one** `runAgentTurn` dep, so "two gated fakes" is impossible; `gatedRunAgentTurn` (`fakes.ts:123-144`) overwrites its single `releaseResult` closure on each call (`:134`), so a second concurrent turn clobbers the first's resolver (deadlock); `scriptedRunAgentTurn` resolves synchronously (`:77`) so it cannot hold turns to release out of order. The headline Slice-4 guarantee ("append in `minds[]` order *regardless of completion order*") is untestable without a new fake that vends a per-call release handle. Slice 4 now owns that ~20-line fake.

7. **`renderTranscript` stripping is precedence-aware (strip only a *trailing* balanced object whose parsed `action` is in the control set), driven by a single `CONTROL_ACTIONS` constant shared with both parsers and the prompt instructions.** (Boundary critic [minor] + concurrency critic [minor].) This prevents two symmetric bugs: a control tail that one parser *routes* but the stripper *misses* (re-leaking JSON), and an inline JSON *code example* in prose getting wrongly stripped. One source of truth, one tolerance.

8. **`round` defaulting happens at the load boundary, not in the `isRoom` guard.** (Boundary critic [minor] + scope critic [minor].) Verified: `isRoom` (`room-store.ts:79-93`) does not inspect `round` today, so it needs **no change** — adding `round` to its required-field list would *regress* every existing `room.json`. Default `round` to `0` where the in-memory `Room` is constructed (driver `start`/load path); keep `round` optional on `TurnEntry`.

9. **Open-floor nomination is an explicit *third* precedence tier, not "the override machinery verbatim."** (Scope critic [minor].) Order is: **director `nextSpeaker` override (`room.ts:311`) wins → else validated prior-TurnEntry nomination → else strategy seed/fallback.** A director's "Call on X" must beat a stale agent nomination (A2A:210: nomination is *advisory*).

10. **The Slice-4 "exactly one publish" assertion is scoped honestly, and the pump is promoted from "present" to "pinned" by a dedicated test.** (Concurrency critic [major].) Verified the level confusion: `makeFakePublisher` (`fakes.ts:39-51`) counts calls at the `RoomPublisher.publish()` boundary, which in the real rib is the *outer* function (`index.ts:294-310`); the dirty-flag `do/while` and `recompose` coalescing live *below* it and are not observed by the fake. Worse, the rib's own `SnapshotManager` double (`room-adapter.test.ts`) recomposes synchronously and never sets `composing`/`dirty`, so the pump body is dead in every rib test. Slice 4 asserts only "the driver calls `publish` once per parallel round" and adds a separate rib-level pump test (slow composer + a second `publish()` mid-compose → both frames broadcast).

**Critic points overridden (with reason):**

- *Concurrency critic, the abort-races-the-batched-commit [major]* — I **kept** the critic's required test but **rejected the framing that it's a new hazard class.** Verified the single-turn shape is identical and already pinned (`driver.test.ts:305-329`, `:580-611`): when `stop` bumps the generation mid-flight, the batched commit's gen-recheck drops the whole cache/board commit (correct — `commitTerminal`/`commitActive` return `false` on gen mismatch, `room.ts:171,180`), and the N disk entries are contained by the fresh-slug invariant (`index.ts:573-575`). So the contract is: **on a stop, `stop()`'s own stopped-board is the final frame; the N `aborted` entries live only on disk and are never pulled into a restart.** I corrected the original design's overpromise ("the board renders them") to match this, and added the critic's "stop after `Promise.all` settles but before the batch commit" test — but this is the *same* invariant the single-turn path already proves, not a new one.

- *No critic was wrong on a load-bearing point.* The three converged on the same five real defects (fabricated cancellation citation, untestable concurrent-ordering fake, multi-turn budget overshoot, moderator-membership drift, smuggled signature change). All are folded in.

---

## 1. The strategy seam

**Decision: keep `Strategy` pure, but widen its input to `StrategyInput` carrying the transcript. The driver does ALL parsing, validation, and spawning; the strategy never parses free text and never spawns.**

Why: the rib's correctness story (generation gating, write-lock, abort, single-active) lives entirely in the driver and is regression-pinned by `driver.test.ts`. pi-chamber/chamber prove the *decision logic* ports cleanly; their *imperative self-driving loop* does not (it would duplicate the serial gate + abort the driver already owns). But `(room: Room) => StrategyStep` is genuinely too thin: group-chat's `minRounds`/all-heard gate and open-floor's "did the last speaker nominate?" both need the transcript, which `room.ts:98` already holds in memory. Widening the *input* (not making the strategy effectful) is the minimal honest change.

### Final signatures (reconciled with `src/types.ts`)

```ts
// src/types.ts — REPLACE the bare Strategy alias (types.ts:73). StrategyStep (types.ts:66-71) is UNCHANGED.
export interface StrategyInput {
  room: Room;
  transcript: readonly TurnEntry[];   // the in-memory transcript the driver already holds (room.ts:98)
  round: number;                      // current round index (see §2c)
}
export type Strategy = (input: StrategyInput) => StrategyStep;
```

`StrategyStep` stays exactly as declared (`speak | speak-parallel | moderate | synthesize | end`). **No new step kinds, and no payload added to `moderate`/`speak`.** The driver derives the moderator's pick and the nominee from the transcript *after* the relevant turn runs, never from the StrategyStep. This is the crucial divergence from pi (where the step would carry the parsed direction): in the rib, a `moderate` step says only "run the moderator and then route on its reply"; the *routing* is driver code. This honors the existing invariant — the driver is the sole authority for `TurnEntry.from` (`room.ts:419-432`); a nomination changes *who speaks*, never *who authored* (A2A:206-211).

**`RoomConfig` grows two fields** beyond what `types.ts:36-41` already declares (`moderator`/`minRounds`/`endVoteThreshold`/`synthesizer` are present today) — all optional, all with pi/chamber-sourced defaults applied in the driver, so existing `room.json` files and the `isRoom` guard (`room-store.ts:79-93`, which doesn't inspect `config`) stay valid:

```ts
export interface RoomConfig {
  moderator?: MindSlug;          // group-chat: the routing Mind. MUST NOT be in room.participants (see below).
  minRounds?: number;            // group-chat + open-floor close gate (default 1)
  endVoteThreshold?: number;     // open-floor end-vote fraction, STRICT '>' (default 0.49)
  synthesizer?: MindSlug;        // optional closing synthesis Mind (group-chat + open-floor)
  maxSpeakerRepeats?: number;    // NEW — anti-monopoly cap (default 2). Routing degenerates without it.
}
```

**`maxSpeakerRepeats` is required for correctness**, not polish — both pi and chamber rely on it for the `leastSpoken` fallback; without it open-floor ping-pongs to `turnBudget` and group-chat can't break a fixated moderator. `maxTurns` is **deliberately omitted**: `turnBudget` (`room.ts:446`) is the single hard cap; rounds close via the gate + nomination, and `turnBudget` backstops everything (now pre-checked per batch, §2e). `speakerAddressing`/`opener` from pi are **not ported** (see §10 — we ship the structured-tail nomination unconditionally, no per-room toggle).

### Moderator identity — a hard invariant

**`config.moderator` is a roster Mind that is NOT a member of `room.participants`** (the speaker pool). It is resolvable by `deps.minds()` for its turn, but it is never a speaker. This makes the boundary self-enforcing:

- `isValidNominee` (`room.ts:188-190`) already rejects any non-participant, so a director's "Call on `<moderator>`" or an agent nomination of the moderator **cannot** route a `speak` turn to it. No new gate code needed.
- `buildRoomBoard` fans `room.participants` into speaker `segments` and "Call on" controls (`boards/room.ts:9-12,75`), so a non-participant moderator is automatically absent from both — no phantom speaker count, no spurious control.
- The group-chat speaker pool is exactly `room.participants` (no subtraction needed, since the moderator was never in it).

Validation at room-start (Slice 2): if `strategy === "group-chat"`, require `config.moderator` set, a real (resolvable) Mind, and **not** in `participants`; reject otherwise (mirrors `validateStart`, `index.ts:419-442`). Add a driver/validation test: *a director cannot nominate the moderator as a speaker.*

### One parser module, driver-side

Both the moderator pick and the nomination are the same problem: extract a validated participant slug from free agent text. Build **one** module `src/routing.ts` (new — verified absent today), ported close-to-verbatim from chamber's `shared.ts` `extractJsonObject` (string-aware bracket counter, tolerant of prose/markdown fences) plus pi's `extractTrailingJsonObject` and `stripControlJson`:

```ts
// src/routing.ts (new)

// Single source of truth for the control vocabulary — shared by both parsers,
// the rendered-history stripper, AND the prompt text that instructs agents what
// to emit. Splitting these would re-open the route-but-don't-strip leak.
export const CONTROL_ACTIONS = new Set(["nominate", "pass", "end", "direct", "close"]);

export function extractJsonObject(text: string): string | null;          // FIRST balanced {...} — moderator decisions
export function extractTrailingJsonObject(text: string): string | null;  // LAST balanced {...} — speaker nomination tails
// Strip ONLY a trailing balanced object whose parsed `action` ∈ actions; leave
// non-control or non-trailing JSON (code examples in prose) intact.
export function stripControlJson(text: string, actions?: Set<string>): string; // defaults to CONTROL_ACTIONS

export interface ModeratorDecision { nextSpeaker?: MindSlug; direction?: string; action: "direct" | "close"; }
export function parseModeratorDecision(text: string): ModeratorDecision | null; // extractJsonObject; action collapses to 'close' only if exactly 'close'

export interface Nomination { action: "nominate" | "pass" | "end"; slug?: MindSlug; reason?: string; }
export function parseNomination(text: string): Nomination | null;  // extractTrailingJsonObject; 'nominate' w/o slug -> null
```

**Precedence is load-bearing and pinned by tests:** moderator → FIRST object (the moderator's reply *is* the decision); speaker nomination → LAST object (a reply may embed an earlier JSON code example). Validation is the existing gate: every parsed slug goes through `isValidNominee(slug, room)` (`room.ts:188-190`). On `null`/invalid/self/over-cap: deterministic fallback (round-robin via `sequential`, or `leastSpoken`), never a throw. The wire convention agents emit is a **trailing JSON object** — `{"action":"nominate","slug":"<participant>","reason":"…"}` for speakers, `{"action":"direct","next_speaker":"<participant>","direction":"…"}` / `{"action":"close"}` for the moderator — robust to a model that ignores it, because the fallback path is airtight. The strings the prompts instruct agents to emit are derived from `CONTROL_ACTIONS`, so prompt, parser, and stripper can never drift.

**All parsing lives in the driver.** The strategy returns `{kind:"moderate", mind: moderator}`; the driver runs that turn, `parseModeratorDecision`, validates, *then* runs the picked speaker. For open-floor the strategy returns `{kind:"speak", mind: <next>}` where the driver computed `<next>` by reading the *previous* TurnEntry with `parseNomination` before consulting the strategy (the three-tier precedence, §2a-2).

---

## 2. Driver changes (`src/room.ts`)

### 2a. The call site

The single change point is `step()` at **room.ts:309-334**. Today: a valid `nextSpeaker` override wins, else `getStrategy(room.strategy)(room)` (room.ts:314), then branches for `end` (319) and `speak` (323), then `throw` (334). Changes:

1. **Pass the richer input** (room.ts:314):
   ```ts
   const transcript = await loadCachedTranscript(slug);   // already used downstream; hoist it
   decision = getStrategy(room.strategy)({ room, transcript, round: room.round });
   ```

2. **Open-floor nomination — a third precedence tier, read driver-side BEFORE the strategy but AFTER the director override** (mirrors *but does not reuse verbatim* the override machinery at room.ts:311-315). The order is exactly:
   - **Tier 1 — director `nextSpeaker` override** (existing `room.ts:311`): if valid, wins. A director steer beats a stale agent nomination (A2A:210).
   - **Tier 2 — open-floor nomination**: only when `strategy === "open-floor"` and no director override consumed. Read the last agent TurnEntry, `parseNomination`, validate via `isValidNominee`; if valid, `decision = {kind:"speak", mind: nominee}`.
   - **Tier 3 — the strategy**: seeds the first speaker / falls back.

   Add a driver test: *director override beats a conflicting agent nomination.*

3. **Add the three branches** before the `throw` (room.ts:333):
   - **`moderate`** → run the moderator via a factored `runOneTurn` (§2b), append it with `from: <moderator>, role: "agent"`, `parseModeratorDecision` + validate, **budget-recheck (§2e)**, then run the picked speaker via the existing `runSpeakTurn` body. On invalid pick: `leastSpoken` fallback or `end`.
   - **`synthesize`** → run the synthesizer via `runOneTurn`, append with `from: <synthesizer>, role: "agent"`, then close (`commitTerminal` `done`) — synthesis is the round's last act in Phase 3 (the room ends after it).
   - **`speak-parallel`** → §3.

### 2b. Factor `runOneTurn` out of `runSpeakTurn`

Extract the prompt-build → `runAgentTurn` → stream-drain → result-extraction + abort/disposed guards (the body at **room.ts:370-413**) into:

```ts
async function runOneTurn(room, mind, directionInjection, controller, gen):
  Promise<{ text: string; aborted: boolean } | "disposed">
```

`runSpeakTurn` becomes `runOneTurn` + the append-and-commit tail (room.ts:419-450). `moderate`/`synthesize`/`speak-parallel` all reuse `runOneTurn`, so the abort/disposed/empty-prompt guards are written once. **Critical:** the disposed/abort check must run *between* the moderator turn and the speaker turn in a `moderate` step (room.ts:417's single check is insufficient for a 2-turn step) — `runOneTurn` returns `"disposed"` and the caller bails.

### 2c. Round tracking (`round`)

Add a `round` cursor. **Decision: store it on `Room`, don't derive from `turnIndex % participants.length`** — derivation breaks the moment a director `nextSpeaker` override or a group-chat moderator perturbs the rotation (a real, tested path: `driver.test.ts:119-126,249-294`).

- `Room` gains `round: number` (start at 0).
- **The `isRoom` guard (`room-store.ts:79-93`) is NOT changed** — it does not inspect `round` today, and adding it to the required-field list would regress every existing `room.json`. Default `round` to `0` at the *load boundary* in `room.ts` (where the in-memory `Room` is constructed from disk in `start`/resume). Keep `round` optional on `TurnEntry` (`types.ts:26`, `transcript.ts:57`) so old transcripts re-parse.
- `buildTurnEntry` already accepts `round` (`transcript.ts:52-64`); the driver starts passing `room.round`.
- **Round advance is strategy-mode-specific and lives in the driver**, not the strategy: sequential/concurrent — `round` increments when `turnIndex` wraps the participant count; group-chat — `round` increments when the gate's "all heard this cycle" flips (folded from the transcript); `synthesize` closes the round. `roundOf(transcript)` is a pure helper in `src/routing.ts` for the *display* round; the authoritative cursor is `room.round`.
- Add a regression test: an old `room.json` with no `round` field loads (status active, `round` defaults 0), mirroring the slug-reuse tolerance tests (`driver.test.ts:580-611`).

### 2d. minRounds / endVoteThreshold / synthesizer / maxSpeakerRepeats

Read by the **strategies** (group-chat, open-floor) from `input.room.config` + folded transcript counts — and by the driver's `moderate`/`synthesize` execution. The reconstructable helpers port from pi/chamber as **pure functions over `input.transcript` scoped to the current round** (round-scoping is the #1 correctness trap — `completedRounds`/all-heard are round-scoped, pi `group-chat.ts:281-285`):

```ts
// src/routing.ts — pure, fold over transcript (NOT closure Maps)
speakerCounts(transcript, round): Map<MindSlug, number>
leastSpoken(speakers, counts): MindSlug          // first minimum, stable by participant order
nextUnheard(speakers, counts): MindSlug
allHeardInCycle(speakers, counts, round): boolean
endVoteRatio(transcript, speakers, round): number // strict '>' at the call site
```

**Strict `>` for the end-vote** is copied exactly (verified against `open-floor.ts:92-96`, which has an explicit comment that `>` not `>=` is intentional): `ratio > endVoteThreshold`, so 1/2 at the 0.49–0.5 default does *not* close. The moderator is excluded from the `speakers` denominator — and since it is not a participant, `room.participants` *is* the speaker pool, so no subtraction is needed.

### 2e. Turn-budget interaction — gated per batch, never overshoot

**Decision: every agent turn ticks `turnBudget` by exactly one, including a `moderate` step's moderator turn and a `synthesize` turn — AND a step never starts a turn it cannot complete within `turnBudget`.**

Rationale: `turnBudget` is the *cost* guard (each turn is a paid call, `MAX_ROOM_TURN_BUDGET=50`, `index.ts:27`) — a moderator turn costs money, so it must count. This keeps the "advance by N per call" invariant intact. But the single-turn terminal check (`advanced.turnIndex >= advanced.turnBudget` *after* a +1, `room.ts:446`) does **not** compose to multi-turn steps; left unguarded, a `moderate` at `turnIndex == turnBudget-1` would run the moderator (reaching the cap) *and* the speaker (past it), and a `speak-parallel` of N at `turnBudget-1` would append N entries jumping to `turnBudget-1+N`. The fix is a **pre-spawn gate**:

- **`moderate`**: after the moderator turn's tick, if `current.turnIndex >= turnBudget`, close `done` **without** running the speaker. (A `moderate` step consumes up to **two** budget ticks; the operator sets `turnBudget` knowing moderation costs turns.)
- **`speak-parallel`**: before spawning, if `current.turnIndex + minds.length > turnBudget`, either trim the batch to the remaining budget or close `done` without spawning. `turnIndex` must never exceed `turnBudget`.
- **`synthesize`**: a single tick; the existing post-+1 check suffices, but it always closes the room afterward anyway.

The board's `turnIndex/turnBudget` chip (`boards/room.ts:34`) shows this honestly. **The moderator turn IS appended as a visible TurnEntry** (`from: <moderator>, role:"agent"`) — we do *not* port pi's "hidden moderator" discipline, because the rib's invariant is one-append-per-turn and the board renders every entry; a hidden, non-appending turn would break the budget tick and the `driver.test.ts:441-468` exact-rows guarantee. This matches A2A:166-168 (a moderator that *is* a Mind authors with its own slug). The moderator's routing-JSON tail is *stripped* from what the next speaker sees (§8), but its deliberation text stays visible on the board.

Tests: extend the budget test to assert *no turns are appended past the cap* — a `moderate` whose moderator tick lands exactly on `turnBudget` runs **no** speaker turn and the room is `done`; a `speak-parallel` that can't fit closes `done` without paying for over-cap turns.

---

## 3. True concurrent execution — **SHIPS in Phase 3**

**It can ship.** The headline risk ("the pump protects only the bound-workflow path, not the imperative path") is **already mitigated in this rib**: `index.ts:286-311` implements the dirty-flag pump on the imperative `publish`/`recompose` path verbatim. The A2A doc (lines 174-177) genuinely says the pump is *not* on the imperative path — that doc is **stale**; the code is authoritative. Overlapping publishes converge to `latest`. The only remaining work is in the driver, and it is modest. Note this does *not* depend on PR #118 in any way (see Changes-from-review #1).

### Mechanism

`speak-parallel` runs N turns concurrently, then appends all N and publishes **once** — not N live-streamed frames. Grounding:

- **Coalescing is by key** (verified `snapshot-manager.ts:54-59`): concurrent `recompose("rib:chamber:room")` calls collapse onto one in-flight compose that reads `latest` via the `() => latest` closure (`index.ts:284`) at compose time. So per-turn live frames during a parallel round are impossible on one key *and unnecessary* — the clean port (pi `concurrent.ts:34-74`) is: spawn all in parallel, await all, append all in deterministic order, publish once.

- **Append + publish without lost frames:**
  ```ts
  // in step(), decision.kind === "speak-parallel":
  // PRE-SPAWN budget gate (§2e): if current.turnIndex + decision.minds.length > turnBudget,
  // trim or close `done` before spawning a single turn.
  const results = await Promise.all(decision.minds.map(m => runOneTurnForParallel(room, m, controller, gen)));
  // append all N in decision.minds order (deterministic — NOT completion order), under ONE withLock:
  return await withLock(room.slug, async () => {
    const current = (await deps.store.loadRoom(room.slug)) ?? room;
    if (generationOf(room.slug) !== gen) return false;           // stop bumped gen mid-round — drop the commit
    let nextIdx = current.turnIndex;                              // SEED from the re-loaded current, inside the lock
    for (const r of orderedByMinds(results)) {
      await appendEntry(room.slug, gen, buildTurnEntry({ ...r, turnIndex: nextIdx++, round: current.round }));
    }
    const advanced = { ...current, turnIndex: current.turnIndex + decision.minds.length };  // +N, not +1
    // budget/terminal as in runSpeakTurn (but the cap can't be crossed — pre-gated above),
    // then ONE persistAndPublish (one board frame).
  });
  ```
  All N speakers are prompted from the **same pre-round transcript** (they don't hear each other — pi `concurrent.ts:44`), so there's no read-your-own-writes hazard and no prompt-ordering dependence. Only the *output* ordering matters, and it's pinned to `decision.minds[]` order (deterministic — keeps `driver.test.ts:441-468`-style exact-row assertions meaningful). **`nextIdx` is seeded from the re-loaded `current.turnIndex` *inside* the lock** — the same source as the +N advance — so the N entry indices and the room advance derive from one consistent read (matching `room.ts:439-442`'s "advance from the re-loaded current, not the pre-turn snapshot" discipline). `persistAndPublish` runs once inside the lock; the pump (`index.ts:286-311`) coalesces-safely if a director inject races it.

### Interaction with the existing invariants

- **Serial gate** (room.ts:274): unchanged. The gate guards *re-entrant* `step()` calls (one slug owns one step); N parallel turns *inside* one step don't fight it. The batched single commit (advance by N under one `withLock`) is what preserves the gate's purpose — no parallel turn calls the turnIndex-advancing commit independently.
- **Generation gating** (room.ts:110-153): unchanged — capture `gen` once before the parallel spawn; `appendEntry` is already generation-gated per entry (`room.ts:151`); recheck `gen` before the batched commit.
- **Write lock** (room.ts:124-138): one `withLock` wraps the whole batched append+commit, never the N agent calls.
- **Abort + the stop-races-the-batch contract:** the **one per-slug `AbortController`** (room.ts:77) is shared by all N — `stop`/`dispose` aborts the whole parallel round (correct: stop ends the room). We do **not** add per-speaker controllers in this slice (acceptable scope cut — A2A). The teardown is **best-effort and provider-dependent** (Changes-from-review #1): the claude provider forwards the signal, breaks its consumer loop, closes its chunk queue, and `handle.interrupt()`s only in streaming-input mode. **The stop-races-commit contract is explicit and identical in shape to the already-pinned single-turn case** (`driver.test.ts:305-329,580-611`): if `stop` bumps the generation after `Promise.all` settles but before the batched `withLock` body's gen-recheck, the commit drops the *entire* cache/board batch (correct — `commitTerminal`/`commitActive` return `false` on gen mismatch, `room.ts:171,180`). `stop()`'s own stopped-board is then the final frame; the N `aborted` disk entries (written unconditionally by `appendEntry`'s `deps.store.appendTranscript`, `room.ts:150`) live **only on disk** and are contained by the fresh-slug invariant (`index.ts:573-575`) — a same-slug restart never pulls them in. Aborted parallel turns that *do* commit (gen unchanged) are appended with `aborted:true` and the board renders them (`boards/room.ts:18`).

### `concurrent` registration

Flip `concurrent` from `sequential` to a real concurrent strategy that returns `{kind:"speak-parallel", minds: participants}` for the round, then `end`. Update `strategies/index.ts:8-11` and `registry.test.ts:9` (which currently asserts `concurrent === sequential`).

---

## 4. N(>2) participants & rendering

**Ships as the MVP one-board approach — and it's essentially already done.** `buildRoomBoard` (`boards/room.ts:7-43`) already fans `room.participants` into header `segments` (`:11-12`) and every TurnEntry into a `rows` feed (`:14-19`) for *any* count; `board.test.ts:39-54` proves N entries / multi-participant segments. The base `board` view holds arbitrarily many `rows` items on one key (verified `canvas.ts:296-319`), and there is **no `registerView`/dynamic-region seam** (verified — `RibContext` exposes only `getSnapshotManager?`/`runAgentTurn?`, `rib.ts:132-145`; `views`/`surfaces` are static `readonly` arrays validated once at boot, `rib.ts:278-305`).

So **N-participant rendering needs no new key, no new region, no schema change** — the participant count lives in the *data*. The only Phase-3 board additions are cosmetic-but-useful, and all expressible as ordinary `rows` items (verified the `rows` item schema carries both `icon: string` and `chip: {label, tone?}`, `canvas.ts:307-311`):
- a thin routing/round marker row (round boundary, termination reason),
- a distinct rendering for synthesis turns (e.g. `from === config.synthesizer` → a `chip:{label:"synthesis", tone:"brand"}` and/or a leading `icon`).

No new section kinds. **C5 dynamic regions = N concurrent ROOMS, a different and heavier thing** (see §5). Not N participants. Out of scope.

---

## 5. Single-active-room — **KEEP it for this slice**

> **Update (2026-06-18).** This section's premise — "C5 dynamic surface regions confirmed absent" — is now stale. keelson **#214** shipped `RibContext.registerRegion` (the base seam the "record, don't build" list below called for), so **multiple concurrent rooms is no longer base-gated**. It is the next rib-side slice, tracked as chamber **#29**.

**Keep.** The intent doc (A2A:146-153, 243) is explicit that lifting it requires per-room keys `rib:chamber:room:<slug>` + dynamic surface regions (C5), and **C5 is confirmed absent** (regions bind exactly one static `key`, frozen at boot — `surfaceRegionSchema`, `rib.ts:174-205; the SPA refetches the manifest only on restart). group-chat, open-floor, true concurrent, and N participants **all operate within one room** and need zero multi-room support. Lifting it now would be a large, base-gated detour orthogonal to the strategy work, and would force changing the invariant in all three places it's enforced (driver `room.ts:202-208`, rib module `index.ts:755-762`, the single literal `ROOM_KEY` `index.ts:23`).

What a later "multiple rooms" epic needs (record, don't build): per-room snapshot keys registered/unregistered on start/terminal (the unregister handle from `register`, `snapshot-manager.ts:40-52`, since `register` throws on duplicate, `:34`); a per-key `{latest,composing,dirty}` map replacing the single closure (`index.ts:284`); base support for dynamic/multi-key surface regions (C5); and turning the driver's `activeSlug` single-reservation into a `Set`. The store is *already* per-slug (`room-store.ts:23-25`) and slugs are already unique per start (`index.ts:573-575`), so persistence is multi-room-ready — only publish/UI is single-key.

---

## 6. Agent-authored lenses (C2) — **OUT of this slice**

> **Update (2026-06-18).** Superseded — lenses **shipped**. keelson #214's `registerRegion` provided a path the original scoping didn't anticipate (dynamic *regions*, not the assumed `registerView`), and chamber now authors `rib:chamber:lens:*` boards through it (`src/lens.ts`, unbounded via PR #61, covered by `test/lens.test.ts`). chamber **#28 closed**.

**Out.** A lens is a solo-Mind turn authoring a `rib:chamber:lens:*` board (A2A:50-56, 265) — explicitly **not A2A** and a *different* execution path (closer to the existing `chamber-brief` workflow, `index.ts:224-241`, than to the room driver). It needs **dynamic view registration**, which is **confirmed absent** (C2: `views` is a static array read once at boot, no `registerView` seam — `rib.ts:278,304`; the manifest is frozen and the SPA only re-fetches on restart). Per the agent-vs-tool-surface invariant, a lens is an *output of a Mind's turn*, never an addressable peer — so it's orthogonal to the strategy work and shouldn't ride this driver. Defer to a separate Phase-3 lens epic that either pre-declares a fixed pool of lens keys or lands a base `registerView` seam first.

---

## 7. Base gaps: needed-now vs deferrable

> **Update (2026-06-18).** The two "Absent" rows below are stale. keelson **#214** ("let ribs register surface regions at runtime", merged 2026-06-15) shipped `RibContext.registerRegion` — dynamic, multi-key surface regions, with the `group` field pre-added for #29's room panels. That lifted **both** base gates: agent-authored lenses (C2) are now **delivered** through that seam (chamber PR #61; #28 closed), and multiple concurrent rooms (C5, #29) is now a **pure rib-side** epic. Rows retained for history; status corrected inline.

| Gap | Status | Needed for this slice? | Notes |
|---|---|---|---|
| **Coalescing pump on imperative path** | **Already present in the rib** (`index.ts:286-311`) | No base change | A2A doc lines 174-177 are STALE; code is authoritative. Unblocks true concurrent. Independent of #118. |
| **Mid-stream cancellation** | **Provider-dependent, best-effort, predates #118** (`claude/provider.ts:113,136,201,207-217,225-234` + `chunk-queue.ts:32-50`) | Used, no change | Lets us rely on the per-room `AbortController` for *best-effort* teardown of moderate/synthesize/parallel turns. **NOT** via `iterator.return()` (that is the workflow path, `prompt.ts:297-318`) and **NOT** added by #118 (#118 = provider-registry routing only). Best-effort is *why* fresh-slug-per-start stays. |
| **C2 dynamic view registration** | ~~Absent~~ → **base seam shipped** (keelson #214: `RibContext.registerRegion`) | **Delivered** — lenses render via `registerRegion` (PR #61) | Scoped here as `registerView`; the base instead grew dynamic *regions*, which lenses use. chamber #28 closed. |
| **C5 dynamic surface regions** | ~~Absent~~ → **shipped** (keelson #214: `registerRegion`, `group` pre-added for room panels) | **Unblocked** — pure rib-side now (chamber #29) | Base gate lifted; multi-room is no longer base-gated. |
| **Board action `fields`** | **Shipped in base** (`canvasActionItemSchema.fields`, `canvas.ts:182+`) | Optional, nice-to-have | For a "Start group-chat" board form (topic + moderator + participants). Not blocking. |

**Fresh-slug-per-start (`index.ts:573-575`) is NOT dropped.** The cancellation above is best-effort (the provider may not interrupt a settled turn; `interrupt()` is streaming-input-mode-only, `claude/provider.ts:225-227`), so a late append is still possible. The load-bearing reason is the **append-only `transcript.jsonl` slug-reuse hole** (`room.ts:230-242`, pinned by `driver.test.ts:580-611`): a stopped in-flight turn can drain to disk *after* stop, and a same-slug restart would pull that stale entry into the new room's board/prompt. **Keep fresh slugs.** (We *do* lean on the AbortController for best-effort prompt cancellation of multi-turn steps — that is the only thing the cancellation path relaxes, and it was always best-effort.)

**No base change is required to ship slices 1–6.** ~~A base `registerView` (for lenses) and C5 (for multi-room) are separate future epics.~~ **Update (2026-06-18):** keelson #214 shipped `RibContext.registerRegion`, lifting both gates — lenses (C2) are delivered through it (#28 closed) and multiple concurrent rooms (C5, #29) is now a pure rib-side epic.

---

## 8. Token / transcript growth

The driver feeds the **whole** transcript into every prompt (`transcript.ts:16-35` `buildTurnPrompt` → `renderTranscript`), which grows linearly per turn and is worse at N participants (A2A:269). Two changes, both in `src/transcript.ts`, both pure and testable:

1. **Strip control JSON before rendering history** (required for correctness, not just size). `renderTranscript` (`transcript.ts:5-9`) currently emits raw `entry.parts[].text`, so a moderator's `{action:"close",...}` tail or a speaker's `{action:"nominate",...}` tail **leaks into the next speaker's prompt** — the model then mimics/obeys stale routing JSON (pi/chamber both strip this). Apply `stripControlJson(text)` (from `src/routing.ts`, defaulting to `CONTROL_ACTIONS`) to each entry's text in `renderTranscript`. **Precedence is pinned for stripping, not just parsing:** `stripControlJson` removes **only a trailing balanced object whose parsed `action` is in `CONTROL_ACTIONS`** — so a legitimate inline JSON *code example* in prose (the exact case `extractTrailingJsonObject` tolerates) survives, while a genuine routing tail is removed. Because the *same* `CONTROL_ACTIONS` drives both parsers and the stripper, anything one parser routes is something the stripper removes (no route-but-don't-strip gap), and anything the stripper leaves is something no parser would route. **The on-disk TurnEntry keeps the raw text** (the driver re-parses it for routing); only the *rendered* history is stripped.

2. **Bounded window.** Render only the last `N` turns with a one-line elision marker (`…(K earlier turns omitted)`) when truncated — the topic line (`transcript.ts:23`) always stays so the first-turn framing never drops. Make the window a constant (default ~40 turns, comfortably above `MAX_ROOM_TURN_BUDGET=50` for normal rooms but a real cap for multi-Mind/high-budget rooms). Summarization (an LLM-condense pass) is explicitly **deferred** — windowing is the Phase-3 answer.

Tests: a prose reply containing an inline JSON code block survives rendering while a genuine trailing nomination tail is stripped; a reply whose `{action:"nominate",...}` tail `parseNomination` routes is *also* fully removed by `stripControlJson` (no JSON left in rendered history).

---

## 9. Slice plan (ordered, smallest-first; each green on `bun run check` + `bun --filter '*' typecheck` + `bun --filter '*' test`)

Each slice compiles and passes alone because the `step()` `throw` (room.ts:334) stays the fallthrough until a slice registers the corresponding strategy, and `start()` (room.ts:196) keeps rejecting unregistered strategies (so a half-built mode never reserves the active slot — pinned by `driver.test.ts:298-301`). **Each new step kind's driver branch and its producing strategy land in the SAME slice** — `driver.test.ts` can only exercise a branch through the real `getStrategy` (there is no strategy-injection port on `RoomDriverDeps`), so they are inseparable.

| # | Scope (one line) | Files touched | Base change? |
|---|---|---|---|
| **1** | **Routing primitives + precedence-aware history stripping.** Add `src/routing.ts` (`CONTROL_ACTIONS`, extractJsonObject / extractTrailingJsonObject / stripControlJson / parseModeratorDecision / parseNomination + speakerCounts / leastSpoken / nextUnheard / allHeardInCycle / endVoteRatio / roundOf). Wire `stripControlJson` into `renderTranscript`. **No behavior change to driving.** | `src/routing.ts` (new), `src/transcript.ts`, `test/routing.test.ts` (new, ported from pi/chamber parser tests), `test/transcript.test.ts` | No |
| **1.5** | **Strategy signature widening (the load-bearing precondition, isolated).** `Strategy: (room) => StrategyStep` → `(input: StrategyInput) => StrategyStep`. Migrate `sequential.ts`, `sequential.test.ts`, and the `room.ts:314` call site (pass `{room, transcript, round: room.round}`; add `round` to `Room` + default 0 at the load boundary — **no `isRoom` change**). Behavior identical. | `src/types.ts`, `src/strategies/sequential.ts`, `src/room.ts`, `src/room-store.ts` (load-boundary default only), `test/strategies/sequential.test.ts`, `test/room/driver.test.ts` (round-default regression) | No |
| **2** | **group-chat (the MVP value).** Factor `runOneTurn`; add `moderate`/`synthesize` branches in `step()` (with the §2e budget-recheck between moderator and speaker); register `group-chat` (moderator-routes via `parseModeratorDecision`+`isValidNominee`, gated close via minRounds+all-heard, `leastSpoken` anti-monopoly, optional `synthesize`); add `maxSpeakerRepeats` to `RoomConfig`; enforce **moderator-not-in-participants** at room-start. | `src/types.ts`, `src/room.ts`, `src/strategies/index.ts`, `src/strategies/group-chat.ts` (new), `src/index.ts` (start validation), `test/strategies/group-chat.test.ts` (new), `test/room/driver.test.ts` (moderate/synthesize execution + moderator-nominee rejection + budget-at-cap), `test/strategies/registry.test.ts` | No |
| **3** | **open-floor.** Strategy seeds the first speaker; driver reads the prior TurnEntry's nomination (`parseNomination`+validate) as **tier 2** precedence (director override > nomination > seed); end-vote close (strict `>`), loop guard (last-2 visited) + `turnBudget` backstop, terminate-on done/no-target/unknown. | `src/strategies/open-floor.ts` (new), `src/room.ts` (tier-2 nomination read in `step()`), `src/strategies/index.ts`, `test/strategies/open-floor.test.ts` (new), `test/room/driver.test.ts` (nomination routing + director-beats-nomination) | No |
| **4** | **True concurrent.** New multi-gate fake (`gatedRunAgentTurnPool()` / per-call release handles) in `fakes.ts`; `speak-parallel` branch in `step()` (pre-spawn budget gate, parallel `runOneTurn`, batched append in `minds[]` order seeded inside the lock, advance by N, one publish); flip `concurrent` to real parallel. **Plus a rib-level pump test** (slow composer + a second `publish()` mid-compose → both frames broadcast) to pin the imperative pump. | `src/room.ts`, `src/strategies/index.ts`, `src/strategies/concurrent.ts` (new), `test/helpers/fakes.ts` (new fake), `test/room/driver.test.ts` (parallel ordering/budget/abort + stop-after-settle-before-commit), `test/strategies/registry.test.ts`, a pump test (rib-level) | No |
| **5** | **Board polish for N-party + routing.** Render synthesis turns distinctly (synthesis `chip`), a round/termination marker row; verify N>2 segments/rows. (Pure board work.) | `src/boards/room.ts`, `test/boards/room.test.ts` | No |
| **6** | **Transcript windowing.** Bounded last-N-turn render + elision marker, topic preserved. | `src/transcript.ts`, `test/transcript.test.ts` | No |

Slices 1, 1.5, 4, 5, 6 are independently small; 2 and 3 are the meat. **Lenses (C2) and multi-room (C5) are explicitly post-Phase-3 epics**, each gated on a base change.

---

## 10. Test strategy

### What ports from pi-chamber / chamber (pure-strategy + parser tests → `test/routing.test.ts`, `test/strategies/*`)

- **Parser tests, near-verbatim** — the highest-value port. `extractJsonObject` (FIRST), `extractTrailingJsonObject` (LAST — the embedded-code-example case), `parseModeratorDecision` (`action` collapses to `direct` unless exactly `close`; malformed→null), `parseNomination` (`nominate` w/o slug→null; trailing wins), `stripControlJson` (strips the *trailing control* tail, leaves prose AND inline code-example JSON). Pure, dependency-free.
- **Routing-helper tests** — `leastSpoken` (first-minimum, stable by participant order), `nextUnheard`, `allHeardInCycle` (round-scoped), `endVoteRatio` with the **strict-`>` invariant** (1/2 at 0.5 default does NOT close — `open-floor.ts:92-96` is the spec to copy), moderator excluded from denominator (trivially true since it isn't a participant).
- **Vocabulary unification test** — a reply whose `{action:"nominate",...}` tail `parseNomination` routes is *also* fully removed by `stripControlJson` (closes the route-but-don't-strip gap); and an inline JSON code block in prose survives both.
- **group-chat decision logic** as a *pure strategy test* over a fabricated `StrategyInput` (mirrors `sequential.test.ts`'s `room()` factory, `sequential.test.ts:5-17`): gated close (won't `end` before minRounds even if a `close` decision is present), anti-monopoly (a fixated pick over `maxSpeakerRepeats` → leastSpoken), unknown/unparseable → nextUnheard.
- **open-floor decision logic** as pure strategy tests: first-speaker seed; valid nomination → that speaker; invalid/self/over-cap → fallback; end-vote close.

### What is NOT ported

pi/chamber's imperative `executeStrategy`/`execute()` loop, the `OrchestrationContext` callback bag, `mapWithConcurrencyLimit`, child-process spawn, session lifecycle, the relay/TaskManager, `StrategyResult.usage`, the "hidden moderator" emit discipline (we revise it — §2e), and pi's full open-floor **user-message routing-intent + stickiness** cluster (`detectUserAddressMentions`/`inheritedAddressMentions`, ~400 lines + ~12 tests). The SHARED CONTEXT scopes open-floor to "the last speaker nominates the next via its TurnEntry" — so we ship **only the structured-tail nomination** (a ~5× smaller surface). Broadcast/single/chain intent, if wanted, is an additive follow-up.

### New driver tests (`test/room/driver.test.ts`) — the behavioral spec for execution

The existing suite is the regression net for generation/lock/abort (`driver.test.ts:209-403,491-612`) — every new branch must keep it green. New tests:

- **moderate execution:** a `moderate` step appends the moderator entry (`from:<moderator>, role:"agent"`) then the picked speaker's entry; both tick budget (turnIndex advances by 2); an invalid moderator pick falls back to `leastSpoken`; a malformed moderator reply doesn't hang (deterministic fallback). **Moderator-not-in-participants:** a director cannot "Call on" the moderator (it isn't a participant, so `isValidNominee` rejects it and the strategy pick stands), and the moderator never appears in board segments.
- **moderate budget-at-cap:** a `moderate` whose moderator tick reaches `turnBudget` runs **no** speaker turn; the room is `done`; no over-cap entry appended.
- **moderate mid-step abort:** `stop()` between the moderator turn and the speaker turn finalizes cleanly (no speaker entry pointing at a turn that never ran).
- **synthesize:** a `synthesize` step appends one entry and closes the room (`done`); a synthesis *failure* (error-status turn) still closes rather than aborting the room.
- **open-floor nomination + precedence:** a valid trailing-JSON nomination in turn K routes turn K+1 to that Mind; an invalid/self/non-participant nomination falls back to the strategy's seed; a `{"action":"end"}` tail ends the room; **a director `nextSpeaker` override beats a conflicting agent nomination.**
- **history stripping:** after a turn with a routing tail, the *next* turn's `prompt` (asserted on `turns.requests[i].prompt`, the surface `driver.test.ts:660-725` already asserts on) does NOT contain the control JSON, but `loadTranscript` still has the raw text.
- **true concurrent:** a `speak-parallel` step appends N entries in `minds[]` order **regardless of completion order** (drive with the new multi-gate fake, releasing call 1 before call 0); entry `turnIndex`es are contiguous from the committed room's pre-round `turnIndex`; `turnIndex` advances by exactly N; the driver calls `publish` exactly once for the parallel round (`pub.all().length` delta — scoped as "driver publishes once", not "the pump coalesced"); a `speak-parallel` that can't fit the budget closes `done` without paying for over-cap turns; **`stop()` after `Promise.all` settles but before the batch commit** ends the room `stopped`, the board shows the stop, and a same-slug restart does not pull the N disk entries (mirrors `driver.test.ts:580-611`).
- **round default on load:** an old `room.json` with no `round` loads active with `round` 0.

### Fakes (`test/helpers/fakes.ts`)

`scriptedRunAgentTurn` (sequenced replies for moderate's two turns) and `makeFakePublisher` (validates every board against `canvasViewSchema` and counts publishes) cover most paths. **Slice 4 adds one new fake** — a gated `runAgentTurn` maintaining a per-call queue of release handles (`releaseNth(i)`, keyed by call index), because the existing `gatedRunAgentTurn` overwrites its single resolver on each call (`fakes.ts:134`) and `scriptedRunAgentTurn` resolves synchronously (`fakes.ts:77`), so neither can prove completion-order-independence. (~20 lines.) The "no new fake infrastructure" claim from the original design is **withdrawn** — it was false precisely for the test that justifies shipping concurrent.

---

### Key file references for the builder

- Strategy call site to change: `keelson-rib-chamber/src/room.ts:309-334`
- Turn primitive to factor: `room.ts:341-451` (extract `runOneTurn` from `:370-413`)
- Validation gate to reuse: `room.ts:188-190` (`isValidNominee`) — already rejects non-participants, which is what makes moderator-not-in-participants self-enforcing
- Strategy signature + `RoomConfig` + `StrategyStep`: `keelson-rib-chamber/src/types.ts:34-73`
- Strategy registry: `keelson-rib-chamber/src/strategies/index.ts:8-17`
- History render (add precedence-aware stripping): `keelson-rib-chamber/src/transcript.ts:5-35`
- Imperative pump (already correct — do NOT re-add; A2A doc is stale): `keelson-rib-chamber/src/index.ts:286-311`
- Coalescing contract (base): `keelson/apps/server/src/snapshot-manager.ts:54-59`
- Real (best-effort) cancellation mechanism (base): `keelson/packages/providers/src/claude/provider.ts:113,136,201,207-217,225-234` + `keelson/packages/providers/src/chunk-queue.ts:32-50`
- `iterator.return()` lives ONLY here (workflow path — NOT the rib seam): `keelson/packages/workflows/src/handlers/prompt.ts:297-318`
- `isRoom` guard (do NOT add `round`; default at load instead): `keelson-rib-chamber/src/room-store.ts:79-93`
- Board (N-party already works; `rows` item carries `icon`+`chip`): `keelson-rib-chamber/src/boards/room.ts:7-43`, schema `keelson/packages/shared/src/canvas.ts:296-319`
- Board-action `fields` seam (for a Start-group-chat form): `keelson/packages/shared/src/canvas.ts:182+`
- Regression net + new-test home: `keelson-rib-chamber/test/room/driver.test.ts`
- Pure-strategy test pattern to mirror: `keelson-rib-chamber/test/strategies/sequential.test.ts:5-44`
- Fake limitations driving the Slice-4 new fake: `keelson-rib-chamber/test/helpers/fakes.ts:62-85` (sync resolve), `:123-144` (single overwritten resolver)

---

## Recommended first move

**Start with Slice 1 — routing primitives + precedence-aware history stripping.** It is the smallest slice, ships green alone with zero behavior change to driving, and is the foundation every later strategy stands on.

**Files it touches:**
- `keelson-rib-chamber/src/routing.ts` *(new)* — `CONTROL_ACTIONS` + `extractJsonObject` / `extractTrailingJsonObject` / `stripControlJson` / `parseModeratorDecision` / `parseNomination` / `speakerCounts` / `leastSpoken` / `nextUnheard` / `allHeardInCycle` / `endVoteRatio` / `roundOf` — all pure, ported from chamber `shared.ts` + pi `prompts.ts`.
- `keelson-rib-chamber/src/transcript.ts` — wire `stripControlJson(text)` into `renderTranscript` (`:5-9`), stripping only a trailing control object.
- `keelson-rib-chamber/test/routing.test.ts` *(new)* — parser + helper tests, near-verbatim from pi/chamber, including the strict-`>` end-vote case and the vocabulary-unification case (route ⇒ strip; inline code JSON survives).
- `keelson-rib-chamber/test/transcript.test.ts` — add: a routing tail is stripped from rendered history; raw text is unchanged on the entry; an inline JSON code block in prose survives rendering.

**Acceptance criteria:**
- `bun run check`, `bun --filter '*' typecheck`, and `bun --filter '*' test` all green (`CONTRIBUTING.md`'s pre-PR floor).
- All existing tests still pass — no driver, strategy, or board behavior changes (Slice 1 adds a module + one stripping call; no `step()` or registry edit).
- **Visible behavior added:** a transcript entry that ends in a control-JSON tail (`{"action":"nominate","slug":"…"}` or `{"action":"close"}`) no longer leaks that JSON into the *next* speaker's rendered prompt context — the routing JSON is stripped from history while the prose is preserved and the raw entry on disk is untouched. This is the correctness fix §8 exists for, landed before any strategy depends on it, and it makes the Slice-2 group-chat moderator immediately safe to feed back into the transcript.
