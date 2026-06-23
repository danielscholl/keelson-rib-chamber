---
title: The agent-turn seam
description: Why a room runs one agent turn through a single provider-shaped seam whose contract is fixed while the implementation evolves behind it
sidebar:
  order: 3
---

A room turn is a billed agent call. The room driver has to make that call without
knowing, or caring, which provider answers it. Chamber routes every turn through a
single seam on the rib context, `ctx.runAgentTurn`, so the driver is written once
and never rewritten when the call mechanism changes underneath it.

## Decision

A rib runs one agent turn through one provider-shaped seam. The seam's contract is
committed from day one; its implementation is free to evolve behind that signature.
The first implementation may shell a coding-agent CLI; a later one routes through
the harness provider registry. The room driver is written once against the seam and
does not change when the implementation swaps. The instant the implementation
becomes registry-routed, the driver inherits provider pinning, redaction, and
credentials for free, with no room-loop change.

This is why the seam is optional on the context, matching the harness convention for
seams a rib may need but cannot assume. A rib asks for it; it does not assume it.

## A settled dual-handle, not a generator return

The seam returns a settled dual-handle:

```ts
interface RibAgentTurn {
  stream: AsyncIterable<MessageChunk>;
  result: Promise<RibAgentTurnResult>;
}
```

`stream` carries live progress; `result` settles exactly once after the stream
completes. The two are separate handles on purpose. The rejected shape was a bare
async generator whose final value you fish out of the last `next()` call, the
`(await gen.next()).value` idiom. That pattern is broken: the return value is easy
to drop, and a consumer that only iterates the stream never sees the settled result
at all. A driver should be able to read the outcome without reasoning about
generator return semantics, so the outcome is its own promise.

## Fire and return

The room loop must not await a turn inside the action handler. The action route
awaits its handler under a short socket idle cap, so a multi-minute room turn driven
synchronously over that route would silently drop the connection before it finished.

The driver therefore kicks the turn and returns immediately:

```ts
async onAction(action, ctx) {
  if (action.type === "room-start") {
    if (!ctx.runAgentTurn) {
      return { ok: false, error: "rooms unavailable: no agent-turn capability" };
    }
    const { slug } = await this.driver.start(action.payload); // reserve the room
    void this.runLoop(slug);                                  // turns advance detached
    return { ok: true, data: { slug } };
  }
}
```

The turn runs detached. Its result reaches the SPA the same way every other room
update does: as snapshot frames published on the room's key once the turn settles
and the transcript is appended. Each director control, injecting a
direction or stopping the room, is a discrete action dispatch; none of them blocks on
the turn it triggers.

:::caution
This is a contract on the rib, not something the route enforces. A future
contributor who awaits the turn inside the handler will pass the tests against a fast
stub and then drop the socket on a real multi-minute turn. The detached dispatch is
load-bearing.
:::

## Rejected alternatives

**A CLI shell written into rib code.** Shelling a coding-agent CLI directly from the
driver ships with zero harness change and is trivially reversible. It was rejected
because it writes a provider-bypassing call into the rib itself, a call that later
hardening would have to rip back out. The reversibility win comes at a migration
cost, and it scatters a provider blind spot across rib code instead of confining it
to one server module behind the seam.

**A full provider seam wired registry-only from day one.** This is the correct end
state, but it front-loads the hardest code, the stream tee, abort cancellation, and
provider resolution, before a single room turn has run. The seam contract is what the
driver depends on, not the registry plumbing, so the plumbing can arrive after the
first rooms are working. Committing the contract now and letting the implementation
catch up keeps the room loop unblocked and keeps the risky code testable in
isolation when it lands.

The chosen path takes the CLI's reversibility without a provider-bypassing call in
rib code, and confines provider fidelity to one swappable implementation behind a
fixed signature.

## Fail closed when the seam is absent

The seam is optional, so an older harness may not provide it. When it is absent the
room driver and the room tools are not built at all, and any room action fails closed
with `rooms unavailable: no agent-turn capability` rather than falling back to some
degraded path. A rib that needs to run turns and cannot will refuse to pretend it
can. The full seam contract, and the convention for optional context seams, lives in
the [keelson rib contract](https://danielscholl.github.io/keelson/docs/reference/rib-contract/).

## Related

- [Rooms and strategies](../../concepts/rooms/): the driver this seam runs turns for.
- [Communication and identity](../communication-and-identity/): why the driver, not the agent, is the router.
- [Workflows](../../reference/workflows/): the deterministic turns that run outside a room.
- [keelson rib contract](https://danielscholl.github.io/keelson/docs/reference/rib-contract/): the context seams a rib may declare.
