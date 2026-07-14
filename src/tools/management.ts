import type { ToolDefinition } from "@keelson/shared";
import { canvasBoardViewSchema, errText, z } from "@keelson/shared";
import { publishBriefing } from "../brief-gate.ts";
import { KNOWN_CAPABILITY_SLUGS } from "../capabilities.ts";
import { chamberFingerprint, readChamberRecords } from "../chamber-state.ts";
import { writeDigest } from "../digest-store.ts";
import { slugify } from "../genesis.ts";
import { canonicalLensId } from "../lens.ts";
import { deleteRoomExhibits } from "../lens-runtime.ts";
import { isExhibit, listLenses } from "../lens-store.ts";
import { type MindRecord, readMinds, retireMind, scaffoldMind } from "../minds-store.ts";
import { lensesDir, mindsDir, roomsDir } from "../paths.ts";
import { isRoomActive, noteRoomDeleted } from "../room-lifecycle.ts";
import { createFileRoomStore, listRooms } from "../room-store.ts";
import {
  invalidateRoster,
  refreshStandingPanels,
  refreshWorkflow,
  resolveMinds,
  settleGenesis,
} from "../runtime.ts";
import { GENESIS_STARTERS } from "../starters.ts";
import { IDENTITY_SLOT_COUNT, nextFreeSlot } from "../types.ts";
import { DIGEST_TOOL_NAME } from "../workflows.ts";
import { emitJsonList, emitResult } from "./util.ts";

// Serialize genesis slot allocation + scaffold across parallel landings. nextFreeSlot
// reads the roster snapshot, so two emits that read the same free slot before either
// scaffolds would persist a duplicate hue. Each scaffold invalidates the roster, so
// the next serialized landing re-reads and takes the next free slot.
let genesisScaffoldInFlight: Promise<unknown> = Promise.resolve();

// Genesis write seam: the chamber-genesis workflow's prompt node authors the soul
// + tagline and calls this tool to persist the Mind. Deterministic and in-process
// (it reuses scaffoldMind), so the generative half stays in the prompt and the
// write half stays testable.
const genesisEmitSchema = z.object({
  name: z.string().min(1),
  role: z.string().min(1),
  voice: z.string().min(1),
  soul: z.string().min(1),
  // Seat-card stanza (2-4 verb-led sentences). Lenient on purpose: blank is
  // omitted at persist and the card render truncates at 200, so an empty or
  // overlong stanza degrades rather than failing the one paid authoring turn.
  mission: z.string().max(500).optional(),
  tagline: z.string().min(1),
  model: z.string().optional(),
  provider: z.string().optional(),
  // Capability slugs the Mind may invoke in a room (see CAPABILITIES).
  // Unknown slugs are dropped at persist; omitted/empty keeps the Mind text-only.
  tools: z.array(z.string()).optional(),
  // The pending marker's run-scoped id, threaded in as a workflow input for the turn
  // to pass back verbatim, so the landing settles the boot card this run actually
  // started. Optional because the model may drop it and `/genesis` never mints one;
  // removeLandedGenesis falls back to its name guess, so a missing id costs accuracy,
  // not correctness.
  genesisId: z.string().optional(),
});

export function makeGenesisTool(): ToolDefinition {
  return {
    name: "chamber_emit_genesis",
    description:
      "Internal write-seam for the chamber-genesis workflow: persist an authored Mind (SOUL.md + record) under minds/<slug>. The workflow's prompt turn authors { soul, mission, tagline, optional model/provider pin, optional capability tools }; this tool only writes, failing closed on a slug collision. To create an agent, run the chamber-genesis workflow (e.g. /workflow run chamber-genesis <brief>) rather than calling this directly.",
    inputSchema: genesisEmitSchema,
    state_changing: true,
    async execute(input, ctx) {
      const parsed = genesisEmitSchema.safeParse(input);
      if (!parsed.success) {
        emitResult(ctx, `chamber_emit_genesis: ${parsed.error.message}`, true);
        return;
      }
      const {
        name,
        role,
        voice,
        soul,
        mission,
        tagline,
        tools,
        model: rawModel,
        provider: rawProvider,
        genesisId,
      } = parsed.data;
      try {
        const knownTools = tools
          ? [...new Set(tools.filter((s) => KNOWN_CAPABILITY_SLUGS.has(s)))]
          : [];
        const model = rawModel?.trim();
        const provider = rawProvider?.trim();
        const slug = slugify(name);
        // A Mind takes the lowest identity slot not already worn (keelson#390),
        // preferring its starter's own hue when that slug matches a starter and the
        // hue is free — so the cold-start card previews what actually gets seated,
        // and a churned roster never double-seats a hue (next-free, not count-based).
        // Slot pick + scaffold run behind genesisScaffoldInFlight so two parallel
        // landings can't read the same free slot and persist a duplicate hue.
        const buildAndScaffold = async (): Promise<MindRecord> => {
          const preferred = GENESIS_STARTERS.find((s) => s.slug === slug)?.seat;
          const slot = nextFreeSlot(await resolveMinds(), preferred);
          const built: MindRecord = {
            slug,
            name,
            role,
            voice,
            // The roster card truncates for display (with an ellipsis); store the
            // authored tagline trimmed, not hard-cut.
            persona: tagline.trim(),
            ...(mission?.trim() ? { mission: mission.trim() } : {}),
            createdAt: new Date().toISOString(),
            // Omit the slot past the ramp (a sixth Mind) so identityToneForSlot folds
            // it to neutral rather than persisting an out-of-range index.
            ...(slot < IDENTITY_SLOT_COUNT ? { identitySlot: slot } : {}),
            ...(model ? { model } : {}),
            ...(model && provider ? { provider } : {}),
            ...(knownTools.length > 0 ? { tools: knownTools } : {}),
          };
          await scaffoldMind(mindsDir(), built, soul);
          invalidateRoster();
          return built;
        };
        const scaffoldRun = genesisScaffoldInFlight.then(buildAndScaffold, buildAndScaffold);
        genesisScaffoldInFlight = scaffoldRun.catch(() => {});
        const record = await scaffoldRun;
        // The genesis landed — settle its own boot-card marker (siblings keep theirs)
        // so the next roster frame shows the real seat instead of the boot card.
        await settleGenesis(record.name, genesisId);
        // Re-run the bound chamber-roster collector so the new Mind appears
        // promptly instead of waiting on the 120s cadence. Fail-soft — the Mind is
        // already scaffolded, so a host-refresh reject must not fail the emit.
        await refreshWorkflow("chamber-roster").catch(() => {});
        // A new Mind is additive — route Activity through the seam (no digest turn).
        await refreshStandingPanels();
        emitResult(ctx, JSON.stringify({ ok: true, slug: record.slug, name: record.name }));
      } catch (e) {
        emitResult(ctx, `chamber_emit_genesis failed: ${errText(e)}`, true);
      }
    },
  };
}

const digestEmitSchema = z.object({
  board: canvasBoardViewSchema,
});

// Standing-digest write seam: the chamber-digest workflow's author node composes a
// canvas board synthesizing the Chamber's current state and calls this tool to persist
// it. The tool validates the board fail-closed (the schema), stamps it with the current
// chamber fingerprint (so the gate reads the digest as current and runs no further turn
// until the next change), and writes it atomically. The publish node then re-reads the
// store to drive the bound key.
export function makeDigestTool(): ToolDefinition {
  return {
    name: DIGEST_TOOL_NAME,
    description:
      "Internal write-seam for the chamber-digest workflow: persist the standing digest board the author turn composed. The workflow's gate-conditioned author node calls this once with { board } when the Chamber changed; this tool validates the board fail-closed, stamps it with the current chamber fingerprint, and writes it so the Briefing banner's \"The read\" register refreshes. The chamber-digest workflow (nudged by the rib on each Chamber mutation) is the entry point — don't call this directly.",
    inputSchema: digestEmitSchema,
    state_changing: true,
    async execute(input, ctx) {
      const parsed = digestEmitSchema.safeParse(input);
      if (!parsed.success) {
        emitResult(ctx, `chamber_emit_digest: ${parsed.error.message}`, true);
        return;
      }
      try {
        // Stamp the fingerprint from a fresh read at persist time (the same reduction
        // the gate uses) so the gate goes quiet after this authoring. The read is taken
        // at turn END: a structural change landing DURING the (short) author turn is
        // captured by the fingerprint but not by this board, so it surfaces on the next
        // structural change rather than immediately — acceptable eventual consistency
        // for a standing panel, and the common no-mid-turn-change case is exact. (The
        // out-of-process gate/turn split is why we don't cheaply stamp the gate's
        // pre-turn fingerprint here, the way the in-process Briefing gate does.)
        const { minds, rooms, lenses } = await readChamberRecords();
        await writeDigest({
          board: parsed.data.board,
          fingerprint: chamberFingerprint(minds, rooms, lenses),
        });
        // The digest register reads digest.json — re-publish the banner so the new
        // synthesis lands without waiting on the next mutation.
        await publishBriefing();
        emitResult(ctx, JSON.stringify({ ok: true }));
      } catch (e) {
        emitResult(ctx, `chamber_emit_digest failed: ${errText(e)}`, true);
      }
    },
  };
}

// Tools are the only chamber surface an MCP client reaches — a board action is not —
// so the read-only list tools and the cleanup verbs (retire a Mind, delete an ended
// room, otherwise board-action-only) are registered here, making the genesis ->
// convene -> read transcript -> clean up lifecycle drivable over MCP, not only the SPA.

// No input — the list tools take none. A bare object schema keeps the params the
// provider advertises empty rather than absent (z.toJSONSchema needs an object).
const noToolInputSchema = z.object({});

export function makeListMindsTool(): ToolDefinition {
  return {
    name: "chamber_list_minds",
    description:
      "List the Chamber's Minds (the agent roster): each Mind's slug, name, role, tagline, and any pinned model/provider and capability tools. Read-only. Use it to see which agents exist before convening a room. NOT for creating a Mind (run the chamber-genesis workflow) or retiring one (chamber_retire_mind).",
    inputSchema: noToolInputSchema,
    state_changing: false,
    async execute(_input, ctx) {
      try {
        const minds = await readMinds(mindsDir());
        const rows = minds.map((m) => ({
          slug: m.slug,
          name: m.name,
          role: m.role,
          tagline: m.persona,
          ...(m.model ? { model: m.model } : {}),
          ...(m.provider ? { provider: m.provider } : {}),
          ...(m.tools && m.tools.length > 0 ? { tools: m.tools } : {}),
        }));
        emitJsonList(ctx, "minds", rows);
      } catch (e) {
        emitResult(ctx, `chamber_list_minds failed: ${errText(e)}`, true);
      }
    },
  };
}

export function makeListRoomsTool(): ToolDefinition {
  return {
    name: "chamber_list_rooms",
    description:
      "List the Chamber's rooms — active sessions first, then ended ones — with each room's slug, name, status, strategy, participants, and turn progress. Read-only. Use it to find a room to read in detail with chamber_room_status, or to delete with chamber_room_delete. NOT for starting, steering, or stopping a room (chamber_room_start / _say / _stop).",
    inputSchema: noToolInputSchema,
    state_changing: false,
    async execute(_input, ctx) {
      try {
        const rooms = await listRooms(roomsDir());
        // listRooms is newest-first; surface active rooms ahead of finished ones
        // (the sessions-index convention), preserving the createdAt order within each.
        const ordered = [
          ...rooms.filter((r) => r.status === "active"),
          ...rooms.filter((r) => r.status !== "active"),
        ];
        const rows = ordered.map((r) => ({
          slug: r.slug,
          name: r.name,
          status: r.status,
          strategy: r.strategy,
          participants: r.participants,
          turn: r.turnIndex,
          turnBudget: r.turnBudget,
          ...(r.topic ? { topic: r.topic } : {}),
          ...(r.projectId ? { projectId: r.projectId } : {}),
          ...(r.coding ? { coding: true } : {}),
        }));
        emitJsonList(ctx, "rooms", rows);
      } catch (e) {
        emitResult(ctx, `chamber_list_rooms failed: ${errText(e)}`, true);
      }
    },
  };
}

const listLensesSchema = z.object({
  id: z.string().min(1).max(64).optional(),
});

export function makeListLensesTool(): ToolDefinition {
  return {
    name: "chamber_list_lenses",
    description:
      "List the Chamber's living lenses (agent-authored canvas boards), newest first: each lens's id, when it was last updated, any refresh backing, and any provenance (scope, maintaining Mind, reason). Pass { id } to fetch ONE lens in full — the matching record then also carries its `board` (the current composition), which a refresh turn re-composes from. Read-only. NOT for authoring a lens (run the chamber-lens workflow), retiring one (chamber_retire_lens), or the tabled deliverables (chamber_list_exhibits).",
    inputSchema: listLensesSchema,
    state_changing: false,
    async execute(input, ctx) {
      const parsed = listLensesSchema.safeParse(input ?? {});
      if (!parsed.success) {
        emitResult(ctx, `chamber_list_lenses: ${parsed.error.message}`, true);
        return;
      }
      const wanted = parsed.data.id ? canonicalLensId(parsed.data.id) : undefined;
      // An id that canonicalizes to nothing fails closed (mirrors the emit and
      // action guards) — a silent empty list would read as "no such lens".
      if (parsed.data.id !== undefined && !wanted) {
        emitResult(
          ctx,
          `chamber_list_lenses: unsafe lens id: ${JSON.stringify(parsed.data.id)}`,
          true,
        );
        return;
      }
      try {
        const lenses = (await listLenses(lensesDir())).filter(
          (l) => !isExhibit(l) && (wanted === undefined || l.id === wanted),
        );
        const rows = lenses.map((l) => ({
          id: l.id,
          updatedAt: l.updatedAt,
          ...(l.refresh ? { refresh: l.refresh } : {}),
          ...(l.scope ? { scope: l.scope } : {}),
          ...(l.maintainingMind ? { maintainingMind: l.maintainingMind } : {}),
          ...(l.reason ? { reason: l.reason } : {}),
          // The board rides along only on a single-lens fetch: it is the bulky
          // field, and the list's readers (briefings, refresh turns) only need
          // one composition at a time.
          ...(wanted !== undefined ? { board: l.board } : {}),
        }));
        emitJsonList(ctx, "lenses", rows);
      } catch (e) {
        emitResult(ctx, `chamber_list_lenses failed: ${errText(e)}`, true);
      }
    },
  };
}

export function makeListExhibitsTool(): ToolDefinition {
  return {
    name: "chamber_list_exhibits",
    description:
      "List the Chamber's exhibits (deliverables discussions tabled), newest first: each exhibit's id, when it was tabled, the producing room when witnessed, and any gist. Read-only. NOT for tabling one (chamber_table_exhibit), deleting one (chamber_delete_exhibit), or the living lenses (chamber_list_lenses).",
    inputSchema: noToolInputSchema,
    state_changing: false,
    async execute(_input, ctx) {
      try {
        const exhibits = (await listLenses(lensesDir())).filter(isExhibit);
        const rows = exhibits.map((l) => ({
          id: l.id,
          tabledAt: l.updatedAt,
          ...(l.sourceRoom ? { sourceRoom: l.sourceRoom } : {}),
          ...(l.reason ? { reason: l.reason } : {}),
        }));
        emitJsonList(ctx, "exhibits", rows);
      } catch (e) {
        emitResult(ctx, `chamber_list_exhibits failed: ${errText(e)}`, true);
      }
    },
  };
}

const mindRetireSchema = z.object({ slug: z.string().min(1).max(64) });

// Mind retire seam: delete a Mind's record + SOUL.md, then refresh the roster and
// standing panels — the same mutate-then-refresh path the `retire` board action
// takes, exposed as a tool so an MCP client can retire a Mind (the minds noun
// otherwise has no management tool). retireMind asserts a safe slug and throws when
// the Mind is absent, so the refresh runs only after a real delete.
export function makeRetireMindTool(): ToolDefinition {
  return {
    name: "chamber_retire_mind",
    description:
      "Retire a Mind: permanently remove an agent's record and SOUL.md from the roster. `slug` is the Mind's identifier (see chamber_list_minds). Fails closed if no such Mind exists. NOT for retiring a lens (chamber_retire_lens).",
    inputSchema: mindRetireSchema,
    state_changing: true,
    async execute(input, ctx) {
      const parsed = mindRetireSchema.safeParse(input);
      if (!parsed.success) {
        emitResult(ctx, `chamber_retire_mind: ${parsed.error.message}`, true);
        return;
      }
      const slug = parsed.data.slug.trim();
      try {
        await retireMind(mindsDir(), slug);
        invalidateRoster();
        await refreshWorkflow("chamber-roster").catch(() => {});
        await refreshStandingPanels();
        emitResult(ctx, JSON.stringify({ ok: true, slug }));
      } catch (e) {
        emitResult(ctx, `chamber_retire_mind failed: ${errText(e)}`, true);
      }
    },
  };
}

const roomDeleteSchema = z.object({ room: z.string().min(1) });
const ROOM_TRANSCRIPT_DEFAULT_LIMIT = 50;
const ROOM_TRANSCRIPT_MAX_LIMIT = 500;
const roomTranscriptSchema = z.object({
  room: z.string().min(1),
  offset: z.number().int().min(0).optional(),
  limit: z.number().int().min(1).max(ROOM_TRANSCRIPT_MAX_LIMIT).optional(),
});

export function makeRoomTranscriptTool(): ToolDefinition {
  return {
    name: "chamber_room_transcript",
    description:
      "Read a Chamber room's full persisted transcript in pages: returns exact transcript entries from rooms/<slug>/transcript.jsonl plus offset, limit, total, and nextCursor. Read-only. Use it to page through a long room transcript without chamber_room_status truncation. NOT for starting, steering, stopping, or deleting a room.",
    inputSchema: roomTranscriptSchema,
    state_changing: false,
    async execute(input, ctx) {
      const parsed = roomTranscriptSchema.safeParse(input);
      if (!parsed.success) {
        emitResult(ctx, `chamber_room_transcript: ${parsed.error.message}`, true);
        return;
      }
      const slug = parsed.data.room.trim();
      if (!slug) {
        emitResult(ctx, "chamber_room_transcript: room is required", true);
        return;
      }
      const offset = parsed.data.offset ?? 0;
      const limit = parsed.data.limit ?? ROOM_TRANSCRIPT_DEFAULT_LIMIT;
      try {
        const store = createFileRoomStore(roomsDir());
        const room = await store.loadRoom(slug);
        if (!room) throw new Error(`room '${slug}' not found`);
        const transcript = await store.loadTranscript(slug);
        const end = Math.min(offset + limit, transcript.length);
        emitResult(
          ctx,
          JSON.stringify({
            ok: true,
            room: slug,
            offset,
            limit,
            total: transcript.length,
            nextCursor: end < transcript.length ? end : null,
            entries: transcript.slice(offset, end),
          }),
        );
      } catch (e) {
        emitResult(ctx, `chamber_room_transcript failed: ${errText(e)}`, true);
      }
    },
  };
}

// Room delete seam: remove an ended room's directory (room.json + transcript +
// ledger) and the exhibits it tabled, drop its key, and refresh the sessions index —
// the same path the room-delete board action takes, exposed as a tool so an MCP client
// can clean up a finished room. Refuses an active room (stop it first); deleteRoom
// asserts a safe slug and throws when the room is absent, so this fails closed.
export function makeRoomDeleteTool(): ToolDefinition {
  return {
    name: "chamber_room_delete",
    description:
      "Delete an ended Chamber room: permanently remove its record, transcript, and ledger, AND every exhibit the room tabled — an exhibit is a child of its room, so it does not outlive it. Check chamber_list_exhibits first if a deliverable matters. `room` is the room slug (see chamber_list_rooms). Stop an active room with chamber_room_stop before deleting it; fails closed if no such room exists. NOT for stopping a running room.",
    inputSchema: roomDeleteSchema,
    state_changing: true,
    async execute(input, ctx) {
      const parsed = roomDeleteSchema.safeParse(input);
      if (!parsed.success) {
        emitResult(ctx, `chamber_room_delete: ${parsed.error.message}`, true);
        return;
      }
      const slug = parsed.data.room.trim();
      if (isRoomActive(slug)) {
        emitResult(
          ctx,
          "chamber_room_delete: stop the room before deleting it (chamber_room_stop).",
          true,
        );
        return;
      }
      try {
        // Room first: deleteRoom is the guard, so a refused delete must not already have
        // destroyed the deliverables of a room that still exists.
        await createFileRoomStore(roomsDir()).deleteRoom(slug);
        const exhibits = await deleteRoomExhibits(slug);
        // Drop the deleted room's key and most-recent pin (mirrors the board action),
        // then refresh the index card away — fail-soft on the seam.
        noteRoomDeleted(slug);
        await refreshWorkflow("chamber-rooms").catch(() => {});
        await refreshStandingPanels();
        emitResult(ctx, JSON.stringify({ ok: true, slug, exhibits }));
      } catch (e) {
        emitResult(ctx, `chamber_room_delete failed: ${errText(e)}`, true);
      }
    },
  };
}
