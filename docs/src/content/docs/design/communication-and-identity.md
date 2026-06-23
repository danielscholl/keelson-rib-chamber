---
title: Agent-to-agent communication and identity
description: Why agent-to-agent messaging is driver-mediated rather than a bus, and why only a Mind is an addressable participant
sidebar:
  order: 2
---

Two decisions shape how Minds talk to each other in Chamber, a [Keelson](https://danielscholl.github.io/keelson/) rib. The first is that agent-to-agent communication has no transport of its own: the room driver mediates everything. The second is that only a Mind is a participant a turn can be addressed to. A capability is something a Mind invokes, never a peer it talks to. Both decisions exist to keep the conversation a single graph the harness can govern.

## Communication is driver-mediated, not a bus

**Decision.** Agent-to-agent communication is room-internal and the driver is the router. There is no message bus, no inbox, no delivery, and no poll. The driver holds the transcript, asks the strategy who speaks next, runs that Mind as one stateless agent turn, appends the reply, and publishes the transcript as a board. A Mind hears another only because the previous turn is already in the transcript the driver feeds the next speaker. Addressing a specific Mind is advisory routing, never a delivered message.

**Rejected.** A standalone messaging transport: a switchboard relay, mailboxes, a poll, lease, and acknowledge protocol, per-Mind inboxes, and long-lived autonomous Mind sessions. Also rejected was a directed request and reply task lifecycle, where one Mind awaits a named task from another.

**Why.** That kind of transport answers a different shape of system. A bus is what you build when each Mind is an independent, long-running process that has to find and reach the others. Chamber's room Minds are not processes. Each one is a single stateless turn the driver invokes and then forgets. The driver already holds the only shared state, the transcript, and is the only thing that runs a turn, so it is already the bus. Adding a transport on top would be a second router racing the one that already exists. Every turn is a broadcast append to the transcript, so a Mind asking for another by name is a hint about who should speak next, not an awaited reply.

This is what [Rooms and strategies](../rooms-and-strategies/) builds on: the room is the only place agent-to-agent talk happens, and the driver is the only thing routing it.

## Identity is at the Mind level

**Decision.** Only a Mind is an addressable participant. A tool, a workflow, an MCP server, or another rib is a capability a Mind invokes during its turn. None of them is a participant, and none of them is an agent. The driver is the sole authority for who authored a turn: it stamps the Mind it actually invoked. A director message is forced to the director server-side regardless of what the payload claims. A nomination changes who speaks next, never who authored an entry.

**Rejected.** Treating a capability as a peer: routing a turn to a tool or to another rib as if it were a participant, and letting an entry's author come from the turn's own output.

**Why.** Routing a tool or a rib as a peer would route around the harness permission gate, because a capability reached as a participant is not a capability the harness scoped to that turn. It would also fracture the conversation graph: the transcript would hold authors that are not reasoning identities, and the speaker set the strategy reasons over would stop matching who is actually in the room. Pinning authorship to the driver keeps the graph honest. An agent can claim anything in its text, but it cannot assert that it is a different speaker, and a moderator's pick or a peer's nomination only redirects the next turn.

Capabilities still matter, they are just scoped per turn rather than addressed. [Per-Mind capabilities](../per-mind-capabilities/) covers what a given Mind can reach and how the room bounds it. The generic model, that a rib contributes capabilities to a harness that owns identity and the permission gate, is the [Keelson rib contract](https://danielscholl.github.io/keelson/docs/reference/rib-contract/).

## Related

- [Rooms and strategies](../rooms-and-strategies/): the driver-as-router model in practice.
- [Per-Mind capabilities](../per-mind-capabilities/): what a Mind invokes during a turn, scoped not addressed.
- [Rib contract](https://danielscholl.github.io/keelson/docs/reference/rib-contract/): the harness model for identity and capabilities.
- [Rooms](../../concepts/rooms/): the surface where Minds talk to each other.
