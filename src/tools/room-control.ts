import type { ToolDefinition } from "@keelson/shared";
import { errText, z } from "@keelson/shared";
import type { RoomStore } from "../ports.ts";
import {
  MAX_CRITERION_LEN,
  MAX_GROUNDING_CRITERIA,
  MAX_GROUNDING_URL_LEN,
  normalizeGrounding,
} from "../room-config.ts";
import {
  activeRoomCount,
  activeRoomSlugs,
  DEFAULT_ROOM_TURN_BUDGET,
  injectRoom,
  lastRoomSlug,
  MAX_ACTIVE_ROOMS,
  MAX_ROOM_TURN_BUDGET,
  mostRecentActiveSlug,
  resolveSteerTarget,
  roomNote,
  startRoom,
  stopRoom,
  validateStart,
} from "../room-lifecycle.ts";
import { resolveProject, resolveProjectInput } from "../runtime.ts";
import { renderTranscript } from "../transcript.ts";
import { boundedText, emitResult } from "./util.ts";

// turnBudget/confirm are .optional() (not .default()) on purpose: z.toJSONSchema
// — which the Copilot provider feeds the model — lists defaulted fields as
// `required`, which would force the model to send `confirm` (defeating the
// dry-run/omit path) and `turnBudget`. Defaults are applied after parse instead.
const roomStartSchema = z.object({
  participants: z.array(z.string()).min(2),
  turnBudget: z.number().int().min(1).max(MAX_ROOM_TURN_BUDGET).optional(),
  name: z.string().optional(),
  topic: z.string().optional(),
  // Optional grounding brief distinct from the free-text topic: a source URL and the
  // acceptance criteria the room must satisfy. Injected into turn prompts; when it
  // carries criteria, a design-bearing room runs a cross-vendor fidelity check against
  // them before the closing synthesis. Omit for a room with no grounding.
  grounding: z
    .object({
      sourceUrl: z.string().max(MAX_GROUNDING_URL_LEN).optional(),
      criteria: z.array(z.string().max(MAX_CRITERION_LEN)).max(MAX_GROUNDING_CRITERIA).optional(),
    })
    .optional(),
  // Optional: target the room at a keelson project (turns run at its rootPath).
  projectId: z.string().optional(),
  // Opt into the coding tier (default off): a Mind that declares `code`/`read` can
  // run Bash/Edit/Write/Read, confined to the project root. Requires `projectId`.
  coding: z.boolean().optional(),
  // Routing config. `strategy` defaults to sequential; `moderator` is required
  // (and validated) only for "group-chat"; `manager` for "magentic"; `endVoteThreshold`
  // tunes "open-floor"'s close. All optional so a plain two-Mind room needs none of them.
  strategy: z.string().optional(),
  moderator: z.string().optional(),
  manager: z.string().optional(),
  synthesizer: z.string().optional(),
  minRounds: z.number().int().min(1).optional(),
  maxSpeakerRepeats: z.number().int().min(1).optional(),
  endVoteThreshold: z.number().optional(),
  confirm: z.boolean().optional(),
});
const roomSaySchema = z
  .object({
    // Target a specific room; omit to steer the most-recent active room.
    room: z.string().optional(),
    direction: z.string().optional(),
    callOn: z.string().optional(),
    text: z.string().optional(),
  })
  .refine((v) => Boolean(v.direction || v.callOn || v.text), {
    message: "provide at least one of: direction, callOn, text",
  });
// status/stop take an optional room slug (default: the most-recent room).
const roomTargetSchema = z.object({ room: z.string().optional() });

// Render a room + its transcript as chat-legible text. Targets an explicit slug, or
// the most-recent active room — falling back to the most-recent finished room only
// when none is active, so a bare call headlines a live room when one exists. Reads
// through the same store the driver writes, so it reflects the latest committed turn.
// When several rooms are active and no slug was named, appends a one-line index of
// the others so multiple concurrent rooms are discoverable from a bare status call.
async function renderRoomStatus(store: RoomStore, target?: string): Promise<string> {
  const explicit = (target ?? "").trim();
  const slug = explicit || mostRecentActiveSlug() || lastRoomSlug();
  if (!slug) return "No Chamber room yet. Start one with chamber_room_start.";
  const room = await store.loadRoom(slug);
  if (!room) {
    return explicit
      ? `No Chamber room "${slug}".`
      : "No Chamber room yet. Start one with chamber_room_start.";
  }
  const transcript = await store.loadTranscript(slug);
  const head =
    `Room "${room.name}" (${slug}) — ${room.status}, turn ${room.turnIndex}/${room.turnBudget}; ` +
    `participants: ${room.participants.join(", ")}.`;
  const groundingSource = room.grounding?.sourceUrl?.trim();
  const criteria = room.grounding?.criteria.filter((c) => c.trim().length > 0) ?? [];
  const criteriaText =
    criteria.length > 0 ? `: ${criteria.map((c, i) => `${i + 1}. ${c}`).join("; ")}` : "";
  const grounding =
    groundingSource || criteria.length > 0
      ? `\nGrounding${groundingSource ? ` (${groundingSource})` : ""}${criteriaText}`
      : "";
  const body = transcript.length > 0 ? renderTranscript(transcript) : "(no turns yet)";
  let index = "";
  if (!explicit && activeRoomCount() > 1) {
    const others = activeRoomSlugs().filter((s) => s !== slug);
    const lines = await Promise.all(
      others.map(async (s) => {
        const r = await store.loadRoom(s);
        return r
          ? `  • ${r.name} (${s}) — ${r.status}, turn ${r.turnIndex}/${r.turnBudget}`
          : `  • ${s}`;
      }),
    );
    index = `\n\n${activeRoomCount()} rooms active — pass room:<slug> to read another:\n${lines.join("\n")}`;
  }
  return boundedText(`${head}${grounding}\n\n${body}${index}`);
}

// The room controls as chat tools — the second `step()` consumer the StepOutcome
// soundness (#10/#13) was built for. Fire-and-return: start kicks the existing
// auto-advance loop; status reads progress; say/stop steer a room — an explicit
// `room` slug, or by default the most-recent active one (the server assigns slugs).
// start self-gates on an in-tool `confirm` flag because each turn is a paid agent
// call (keelson chat has no pause-and-confirm gate yet — the OSDU lifecycle pattern).
export function roomControlTools(store: RoomStore): ToolDefinition[] {
  return [
    {
      name: "chamber_room_status",
      description:
        'Use when the user asks what is happening in a Chamber room — "what are they saying", "show the room", "room status". Returns a room\'s participants, status, turn count, and the conversation so far. Defaults to the most-recent room; pass `room` (a slug) to read a specific one — a bare call also indexes the other active rooms when several run at once. Read-only. NOT for starting or stopping a room.',
      inputSchema: roomTargetSchema,
      state_changing: false,
      async execute(input, ctx) {
        try {
          const parsed = roomTargetSchema.safeParse(input);
          const target = parsed.success ? parsed.data.room : undefined;
          emitResult(ctx, await renderRoomStatus(store, target));
        } catch (e) {
          emitResult(ctx, `chamber_room_status failed: ${errText(e)}`, true);
        }
      },
    },
    {
      name: "chamber_room_start",
      description:
        "Open a Chamber room where the named agent Minds converse turn-by-turn (turnBudget paid agent turns, default 8; at budget exhaustion every strategy except review appends one extra paid closing-synthesis turn, so a completed room runs up to turnBudget + 1 room turns — turnBudget + 2 when a design-bearing room is grounded with acceptance criteria (a cross-vendor fidelity turn before synthesis); every Mind that spoke then also runs one paid reflection turn at close, so the total paid calls exceed the room-turn count). Provide a `topic` to frame the discussion — strongly recommended, since it is what the first speaker responds to. Optionally provide `grounding` — a `{ sourceUrl?, criteria?: string[] }` brief distinct from the topic: it is injected into every turn prompt, and its acceptance criteria drive an independent cross-vendor fidelity check — when the room's Minds span two providers — that folds any divergences into the closing document before a design-bearing room (sequential/concurrent/group-chat/open-floor/magentic) synthesizes. Strategy role rules: sequential/concurrent need only at least two participant Mind slugs and no manager; group-chat requires a `moderator` Mind slug that is real, safe, and NOT among participants, with optional `synthesizer` that is also real/safe and neither a participant nor the moderator; open-floor has no moderator or synthesizer; review requires exactly two participants pinned to different providers — first author, second reviewer — with no moderator or synthesizer and turnBudget at least 2; magentic requires a real/safe `manager` Mind slug NOT among participants, no moderator or synthesizer, and at least two worker participants. State-changing: set confirm:true ONLY after the user has approved — without confirm the tool reports what it would start and runs nothing. participants are Mind slugs (see chamber_list_minds). Several rooms can run concurrently (up to a small cap) — stop one if the cap is reached. NOT for creating a Mind (that is the New agent / genesis action).",
      inputSchema: roomStartSchema,
      state_changing: true,
      requires_confirmation: true,
      async execute(input, ctx) {
        const parsed = roomStartSchema.safeParse(input);
        if (!parsed.success) {
          emitResult(ctx, `chamber_room_start: ${parsed.error.message}`, true);
          return;
        }
        const { participants, name } = parsed.data;
        const topic = (parsed.data.topic ?? "").trim() || undefined;
        const grounding = normalizeGrounding(parsed.data.grounding);
        const turnBudget = parsed.data.turnBudget ?? DEFAULT_ROOM_TURN_BUDGET;
        const confirm = parsed.data.confirm ?? false;
        const moderator = (parsed.data.moderator ?? "").trim() || undefined;
        const manager = (parsed.data.manager ?? "").trim() || undefined;
        // A `moderator` — or a `manager` — with no explicit strategy infers the
        // matching facilitated mode (group-chat / magentic) so validateStart enforces
        // its rules and the dry-run label below matches what actually starts (an
        // explicit strategy still wins; moderator takes precedence if both are set).
        const strategy =
          (parsed.data.strategy ?? "").trim() ||
          (moderator ? "group-chat" : manager ? "magentic" : "sequential");
        const synthesizer = (parsed.data.synthesizer ?? "").trim() || undefined;
        const minRounds = parsed.data.minRounds;
        const maxSpeakerRepeats = parsed.data.maxSpeakerRepeats;
        const endVoteThreshold = parsed.data.endVoteThreshold;
        // Canonicalize before the dry-run's validateStart: it and driver.start match
        // projectId as an id only, so a name must resolve to its id up here or the
        // dry-run would reject a project the confirm path (and the board) accept.
        const projectInput = (parsed.data.projectId ?? "").trim() || undefined;
        let projectId: string | undefined;
        if (projectInput) {
          const resolved = resolveProjectInput(projectInput);
          if (!resolved.ok) {
            emitResult(ctx, `chamber_room_start: ${resolved.error}`, true);
            return;
          }
          projectId = resolved.project.id;
        }
        const coding = parsed.data.coding ?? false;
        // Validate up front (including roster membership + group-chat moderator
        // rules + project resolution + the coding-tier project requirement) so the
        // dry-run never advertises a start the confirm path rejects.
        const valid = await validateStart(
          participants,
          turnBudget,
          strategy,
          {
            moderator,
            manager,
            synthesizer,
            minRounds,
            maxSpeakerRepeats,
            endVoteThreshold,
          },
          projectId,
          coding,
        );
        if (!valid.ok) {
          emitResult(ctx, `chamber_room_start: ${valid.error}`, true);
          return;
        }
        // Concurrency cap: refuse before the dry-run prompt so the tool never
        // advertises a start the confirm path would reject (startRoom enforces the
        // same cap authoritatively).
        if (activeRoomCount() >= MAX_ACTIVE_ROOMS) {
          emitResult(
            ctx,
            `chamber_room_start: ${MAX_ACTIVE_ROOMS} rooms are already active (the concurrent cap) — stop one with chamber_room_stop first.`,
            true,
          );
          return;
        }
        const who = valid.participants.join(", ");
        const topicNote = topic ? ` on "${topic}"` : " (no topic set)";
        const modeNote =
          strategy === "group-chat" && moderator
            ? ` (group-chat, moderated by ${moderator})`
            : strategy === "magentic" && manager
              ? ` (magentic: ${manager} manages ${valid.participants.length} worker${valid.participants.length === 1 ? "" : "s"})`
              : strategy === "review"
                ? ` (review: ${valid.participants[0]} reviewed by ${valid.participants[1]})`
                : "";
        // validateStart confirmed the project resolves; name it so the operator sees
        // the repo the turns will run against.
        const projectNote = projectId
          ? ` in project "${resolveProject(projectId)?.name ?? projectId}"`
          : "";
        // Name the elevated capability at the confirm step so the human approving
        // the (paid) room knows a coding Mind can run Bash/Edit/Write.
        const codingNote = coding
          ? " with the coding tier ON (Minds that declare `code`/`read` can run Bash/Edit/Write/Read, confined to the project repo)"
          : "";
        // Disclose the extra paid turns a grounded design-bearing room spends at close
        // (a cross-vendor fidelity turn plus the closing synthesis) so the approving
        // human sees the true ceiling, not just the base budget.
        const groundingNote =
          grounding && grounding.criteria.length > 0 && strategy !== "review"
            ? ` It carries a grounding brief: the closing synthesis, plus a cross-vendor fidelity turn when the Minds span two providers, add up to 2 more room turns (up to ${turnBudget + 2}), before the per-speaker reflection pass at close.`
            : "";
        if (!confirm) {
          emitResult(
            ctx,
            `Would open a room with ${who}${topicNote}${modeNote}${projectNote}${codingNote} for ${turnBudget} turns (each turn is a paid agent call).${groundingNote} Re-call chamber_room_start with confirm:true once the user approves.`,
          );
          return;
        }
        // A user abort during the awaits above must not still open a paid room.
        if (ctx.abortSignal.aborted) return;
        const res = await startRoom({
          participants,
          turnBudget,
          name,
          topic,
          ...(grounding ? { grounding } : {}),
          strategy,
          projectId,
          coding,
          moderator,
          manager,
          synthesizer,
          minRounds,
          maxSpeakerRepeats,
          endVoteThreshold,
        });
        if (res.ok) {
          const slug = (res.data as { slug?: string } | undefined)?.slug ?? "";
          emitResult(
            ctx,
            `Opened room "${slug}" with ${who}. It auto-advances — watch the Chamber surface or call chamber_room_status to read progress.`,
          );
        } else {
          emitResult(ctx, `chamber_room_start failed: ${res.error}`, true);
        }
      },
    },
    {
      name: "chamber_room_say",
      description:
        'Steer a Chamber room: `direction` sets guidance for the next speaker, `callOn` nominates a specific Mind to go next, `text` drops a director message into the transcript. Defaults to the most-recent active room; pass `room` (a slug) to steer a specific one when several run at once. Use when the user wants to nudge the conversation ("tell them to wrap up", "let Alice answer"). At least one of direction/callOn/text required. NOT for starting or stopping the room.',
      inputSchema: roomSaySchema,
      state_changing: true,
      async execute(input, ctx) {
        const parsed = roomSaySchema.safeParse(input);
        if (!parsed.success) {
          emitResult(ctx, `chamber_room_say: ${parsed.error.message}`, true);
          return;
        }
        const target = resolveSteerTarget(parsed.data.room);
        if ("error" in target) {
          emitResult(ctx, target.error, true);
          return;
        }
        const slug = target.slug;
        const { direction, callOn, text } = parsed.data;
        // The driver only honors nextSpeaker when it exactly matches an active
        // participant slug — otherwise step() silently drops it and falls back to
        // the strategy. Reject up front so the tool can't report a dropped
        // nomination ("Alice" vs "alice", a typo, a non-participant) as sent.
        if (callOn) {
          const room = await store.loadRoom(slug);
          // magentic routes turns by the manager's ledger, so a forced speaker would run
          // an off-plan turn that settles no task (step() also ignores the override for
          // magentic) — reject it here and point the operator at `direction`, which steers
          // the manager, instead of reporting a dropped nomination as sent.
          if (room?.strategy === "magentic") {
            emitResult(
              ctx,
              "chamber_room_say: a magentic room routes turns by its manager — use `direction` to steer the plan, not `callOn`.",
              true,
            );
            return;
          }
          if (!room?.participants.includes(callOn)) {
            emitResult(
              ctx,
              `chamber_room_say: "${callOn}" is not a participant — call on one of the room's Minds.`,
              true,
            );
            return;
          }
        }
        // injectRoom does the truthiness filtering; pass the fields straight through.
        const res = await injectRoom(slug, {
          directionInjection: direction,
          nextSpeaker: callOn,
          text,
        });
        const note = roomNote(slug);
        emitResult(
          ctx,
          res.ok ? `Sent to the room${note}.` : `chamber_room_say failed: ${res.error}`,
          !res.ok,
        );
      },
    },
    {
      name: "chamber_room_stop",
      description:
        'Stop a Chamber room (halts its turns). Defaults to the most-recent active room; pass `room` (a slug) to stop a specific one when several run at once. Use when the user says "stop the room", "end it". Reversible — a new room can be started afterward. NOT for retiring a Mind.',
      inputSchema: roomTargetSchema,
      state_changing: true,
      async execute(input, ctx) {
        const parsed = roomTargetSchema.safeParse(input);
        const target = resolveSteerTarget(parsed.success ? parsed.data.room : undefined);
        if ("error" in target) {
          emitResult(ctx, target.error, true);
          return;
        }
        // Compute the note before stopRoom drops the slug from the active set.
        const note = roomNote(target.slug);
        const res = await stopRoom(target.slug);
        emitResult(
          ctx,
          res.ok ? `Stopped the room${note}.` : `chamber_room_stop failed: ${res.error}`,
          !res.ok,
        );
      },
    },
  ];
}
