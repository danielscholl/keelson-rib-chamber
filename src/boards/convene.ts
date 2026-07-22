// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type { CanvasActionField, CanvasActionItem, CanvasBoardView } from "@keelson/shared";
import type { Mind } from "../types.ts";

// The host projects a room can target — the minimal shape conveneShapeSection needs
// (id is the option value the convene action resolves; name is the label).
export interface ConveneProject {
  id: string;
  name: string;
}

// Unmarked reads as optional, so only a required field is marked — and it is marked in
// the label text because the renderer draws no required affordance of its own (it
// raises a submit-time error instead).
const topicField: CanvasActionField = {
  name: "topic",
  label: "Topic",
  placeholder: "What should they discuss?",
  multiline: true,
};
const turnsField: CanvasActionField = {
  name: "turns",
  label: "Turns",
  placeholder: "8",
  half: true,
};
// Grounding is a brief distinct from the topic: a source and the acceptance criteria
// the room is convened to satisfy. When criteria are given, a design-bearing room runs
// a cross-vendor fidelity check against them before it closes.
const groundingUrlField: CanvasActionField = {
  name: "groundingUrl",
  label: "Grounding source",
  placeholder: "Link to the issue / spec / acceptance criteria",
  half: true,
};
const criteriaField: CanvasActionField = {
  name: "criteria",
  label: "Acceptance criteria",
  placeholder: "One criterion per line (a cross-vendor room checks these before it closes)",
  multiline: true,
};

// `half` pairs a field with an adjacent half sibling; a lone one renders ragged at
// half width above a full-width row, so clear it rather than let a shape's field
// list leak into the layout.
function pairHalves(fields: readonly CanvasActionField[]): CanvasActionField[] {
  return fields.map((f, i) => {
    if (!f.half || fields[i - 1]?.half || fields[i + 1]?.half) return f;
    const { half, ...rest } = f;
    return rest;
  });
}

// The project field is a real picker over the host's projects (option value = id,
// which the convene action resolves the same as a typed id). Null when the host
// exposes no projects, so the shape drops the field rather than offering an empty
// select — a room simply runs in the shared scope.
function projectField(projects: readonly ConveneProject[]): CanvasActionField | null {
  if (projects.length === 0) return null;
  return {
    name: "project",
    label: "Project",
    placeholder: "No project (shared)",
    options: projects.map((p) => ({ value: p.id, label: p.name })),
  };
}

// The facilitator (Debate chair / Delegate manager) is one of the selected Minds the
// driver names to run the room; the convene action pulls it out of the participant set
// (a facilitator routes/plans, it does not speak/work). Only built for an enabled
// shape, where `eligible` (the cast) is non-empty, so the select always has an option.
function facilitatorField(
  name: "moderator" | "manager",
  label: string,
  eligible: readonly Mind[],
): CanvasActionField {
  return {
    name,
    label,
    placeholder: "One of the selected Minds",
    required: true,
    options: eligible.map((m) => ({ value: m.slug, label: m.name })),
    // A short cast reads at a glance as a strip of names, echoing the seat cards it
    // was picked from; a full table falls back to the select rather than wrapping.
    // Neither pre-selects (no defaultValue), so the pick stays deliberate either way.
    segmented: eligible.length <= 4,
  };
}

// A gated shape carries the reason it can't run; an enabled one carries none —
// `reason` is the canvas contract's disabled-explanation (reason ⇒ disabled). `short`
// is the same fact sized for the tab strip: a gated tab stays hover-interactive, so it
// renders `short` inline and keeps `reason` as the fuller tooltip.
type ShapeEval =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string; readonly short: string };

// Can this shape run against the current cast? Mirrors the structural slice of
// validateStart (2+ speakers, a non-participant facilitator, a cross-vendor Review
// pair) so a shape the cast can't satisfy is dimmed with a reason before convening,
// rather than failing server-side. A chaired/managed shape names its facilitator from
// the cast and the convene action pulls it out, so it needs three selected — two to
// run plus one to facilitate. validateStart stays the source of truth; this only gates
// the affordance.
function evalShape(strategy: string, cast: readonly Mind[]): ShapeEval {
  switch (strategy) {
    case "group-chat":
      return cast.length >= 3
        ? { ok: true }
        : {
            ok: false,
            reason: "Select at least three Minds — two to debate and one to chair.",
            short: "Needs three — two plus a chair",
          };
    case "magentic":
      return cast.length >= 3
        ? { ok: true }
        : {
            ok: false,
            reason: "Select at least three Minds — two to do the work and one to manage.",
            short: "Needs three — two plus a manager",
          };
    case "review": {
      if (cast.length !== 2) {
        return {
          ok: false,
          reason: "Review is a pair — select exactly two Minds.",
          short: "Needs exactly two Minds",
        };
      }
      const [a, b] = cast;
      if (!a?.provider || !b?.provider) {
        return {
          ok: false,
          reason: "Pin a provider on both Minds — review is cross-vendor.",
          short: "Both Minds need a pinned provider",
        };
      }
      if (a.provider === b.provider) {
        return {
          ok: false,
          reason: `${a.name} and ${b.name} both use “${a.provider}” — review needs two vendors.`,
          short: "Needs two different vendors",
        };
      }
      return { ok: true };
    }
    default:
      return { ok: true };
  }
}

// One action per room shape the driver speaks. Each dispatches `convene` with its
// strategy; an enabled shape carries only the fields its strategy needs, a gated one
// carries none (a disabled tab can't open a form) plus the reason it can't run.
function shapeActions(
  cast: readonly Mind[],
  projects: readonly ConveneProject[],
): CanvasActionItem[] {
  const proj = projectField(projects);
  // `blurb` is the one-line description the `tabs` layout renders under the name, so
  // choosing a shape needs no hover; `hint` stays the fuller hover text, which the host
  // joins with the disabled `reason` on a gated tab.
  const defs: {
    strategy: string;
    label: string;
    glyph: string;
    blurb: string;
    hint: string;
    fields: (CanvasActionField | null)[];
  }[] = [
    {
      strategy: "sequential",
      label: "Discussion",
      glyph: "▸",
      blurb: "Round-robin — each builds on the last",
      hint: "Round-robin — each Mind speaks in turn, building on the last. The default shape.",
      fields: [topicField, proj, groundingUrlField, criteriaField],
    },
    {
      strategy: "group-chat",
      label: "Debate",
      glyph: "◆",
      blurb: "A chair you name drives one decision",
      hint: "A chaired panel — a Mind you name chairs the others toward one decision.",
      fields: [
        topicField,
        facilitatorField("moderator", "Chair (required)", cast),
        turnsField,
        groundingUrlField,
        criteriaField,
      ],
    },
    {
      strategy: "open-floor",
      label: "Open floor",
      glyph: "⊙",
      blurb: "Unchaired — they route themselves",
      hint: "Unchaired brainstorm — the Minds route themselves and stop when enough vote to end.",
      fields: [topicField, turnsField, groundingUrlField, criteriaField],
    },
    {
      strategy: "review",
      label: "Review",
      glyph: "✓",
      blurb: "Cross-vendor pair — one authors, one reviews",
      hint: "A two-Mind cross-vendor pass — one authors, a different provider reviews for an independent second opinion.",
      fields: [topicField],
    },
    {
      strategy: "magentic",
      label: "Delegate",
      glyph: "⚑",
      blurb: "A manager splits and assigns the goal",
      hint: "A manager you name splits the goal into tasks and delegates to the others until it's done. Magentic-style orchestration.",
      fields: [
        topicField,
        facilitatorField("manager", "Manager (required)", cast),
        proj,
        turnsField,
        groundingUrlField,
        criteriaField,
      ],
    },
  ];
  return defs.map((s) => {
    const gate = evalShape(s.strategy, cast);
    const base: CanvasActionItem = {
      type: "convene",
      label: s.label,
      glyph: s.glyph,
      subtitle: s.blurb,
      hint: s.hint,
      submitLabel: "Convene",
      // Convene is the board's one primary verb; tone the submit without tinting the
      // tab (`tone` would ride both).
      submitTone: "brand",
      payload: { strategy: s.strategy },
    };
    if (!gate.ok) return { ...base, subtitle: gate.short, disabled: true, reason: gate.reason };
    return {
      ...base,
      // Discussion is the default shape and is never gated, so the strip opens on it
      // rather than on nothing.
      ...(s.strategy === "sequential" ? { defaultOpen: true } : {}),
      fields: pairHalves(s.fields.filter((f): f is CanvasActionField => f !== null)),
    };
  });
}

// The composer section the merged Chamber bench folds in below its seats: the
// capability-gated shape tabs when the cast can run one, else the prompt to seat more.
// The title asks the question the tabs answer, echoing the open seat's "Who should this
// Mind feel like?" one card over — who, then how. `cast` is the Minds the operator has
// called to the table (the inclusion draft); participant selection now lives on the seat
// cards, so there are no who's-in chips here. Pure — validated against canvasViewSchema
// in the presence tests; the producer never parses (validation lives at the binding edge).
export function conveneShapeSection(
  cast: readonly Mind[],
  projects: readonly ConveneProject[] = [],
): CanvasBoardView["sections"][number] {
  if (cast.length >= 2) {
    return {
      kind: "actions",
      title: "How should they convene?",
      tabs: true,
      items: shapeActions(cast, projects),
    };
  }
  return {
    kind: "rows",
    items: [{ glyph: "neutral", text: "Seat two or more Minds to convene." }],
  };
}
