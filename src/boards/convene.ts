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

const topicField: CanvasActionField = {
  name: "topic",
  label: "Topic",
  placeholder: "What should they discuss? (optional)",
  multiline: true,
};
const turnsField: CanvasActionField = {
  name: "turns",
  label: "Turns (optional)",
  placeholder: "default 8",
};
// Grounding is a brief distinct from the topic: a source and the acceptance criteria
// the room is convened to satisfy. When criteria are given, a design-bearing room runs
// a cross-vendor fidelity check against them before it closes.
const groundingUrlField: CanvasActionField = {
  name: "groundingUrl",
  label: "Grounding source (optional)",
  placeholder: "Link to the issue / spec / acceptance criteria",
};
const criteriaField: CanvasActionField = {
  name: "criteria",
  label: "Acceptance criteria (optional)",
  placeholder: "One criterion per line (a cross-vendor room checks these before it closes)",
  multiline: true,
};

// The project field is a real picker over the host's projects (option value = id,
// which the convene action resolves the same as a typed id). Null when the host
// exposes no projects, so the shape drops the field rather than offering an empty
// select — a room simply runs in the shared scope.
function projectField(projects: readonly ConveneProject[]): CanvasActionField | null {
  if (projects.length === 0) return null;
  return {
    name: "project",
    label: "Project (optional)",
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
  };
}

// A gated shape carries the reason it can't run; an enabled one carries none —
// `reason` is the canvas contract's disabled-explanation (reason ⇒ disabled).
type ShapeEval = { readonly ok: true } | { readonly ok: false; readonly reason: string };

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
        : { ok: false, reason: "Select at least three Minds — two to debate and one to chair." };
    case "magentic":
      return cast.length >= 3
        ? { ok: true }
        : {
            ok: false,
            reason: "Select at least three Minds — two to do the work and one to manage.",
          };
    case "review": {
      if (cast.length !== 2) {
        return { ok: false, reason: "Review is a pair — select exactly two Minds." };
      }
      const [a, b] = cast;
      if (!a?.provider || !b?.provider) {
        return { ok: false, reason: "Pin a provider on both Minds — review is cross-vendor." };
      }
      if (a.provider === b.provider) {
        return {
          ok: false,
          reason: `${a.name} and ${b.name} both use “${a.provider}” — review needs two vendors.`,
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
  // Each shape shows only its name inline (the `tabs` layout); `hint` is the hover
  // description, which the host joins with the disabled `reason` on a gated tab.
  const defs: {
    strategy: string;
    label: string;
    glyph: string;
    hint: string;
    fields: (CanvasActionField | null)[];
  }[] = [
    {
      strategy: "sequential",
      label: "Discussion",
      glyph: "▸",
      hint: "Round-robin — each Mind speaks in turn, building on the last. The default shape.",
      fields: [topicField, proj, groundingUrlField, criteriaField],
    },
    {
      strategy: "group-chat",
      label: "Debate",
      glyph: "◆",
      hint: "A chaired panel — a Mind you name chairs the others toward one decision.",
      fields: [
        topicField,
        facilitatorField("moderator", "Chair — one of the selected Minds", cast),
        turnsField,
        groundingUrlField,
        criteriaField,
      ],
    },
    {
      strategy: "open-floor",
      label: "Open floor",
      glyph: "⊙",
      hint: "Unchaired brainstorm — the Minds route themselves and stop when enough vote to end.",
      fields: [topicField, turnsField, groundingUrlField, criteriaField],
    },
    {
      strategy: "review",
      label: "Review",
      glyph: "✓",
      hint: "A two-Mind cross-vendor pass — one authors, a different provider reviews for an independent second opinion.",
      fields: [topicField],
    },
    {
      strategy: "magentic",
      label: "Delegate",
      glyph: "⚑",
      hint: "A manager you name splits the goal into tasks and delegates to the others until it's done. Magentic-style orchestration.",
      fields: [
        topicField,
        facilitatorField("manager", "Manager — one of the selected Minds", cast),
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
      hint: s.hint,
      submitLabel: "Convene",
      payload: { strategy: s.strategy },
    };
    if (!gate.ok) return { ...base, disabled: true, reason: gate.reason };
    return { ...base, fields: s.fields.filter((f): f is CanvasActionField => f !== null) };
  });
}

// The "…and how" composer section the merged Chamber bench folds in below its seats:
// the capability-gated shape tabs when the cast can run one, else the prompt to seat
// more. `cast` is the Minds the operator has called to the table (the inclusion draft);
// participant selection now lives on the seat cards, so there are no who's-in chips
// here. Pure — validated against canvasViewSchema in the presence tests; the producer
// never parses (validation lives at the binding edge).
export function conveneShapeSection(
  cast: readonly Mind[],
  projects: readonly ConveneProject[] = [],
): CanvasBoardView["sections"][number] {
  if (cast.length >= 2) {
    return { kind: "actions", title: "…and how", tabs: true, items: shapeActions(cast, projects) };
  }
  return {
    kind: "rows",
    items: [{ glyph: "neutral", text: "Seat two or more Minds to choose a room shape." }],
  };
}
