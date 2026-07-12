// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type {
  CanvasActionField,
  CanvasActionItem,
  CanvasBoardView,
  CanvasTone,
} from "@keelson/shared";
import { identityToneForSlot, type Mind } from "../types.ts";

// The host projects a room can target — the minimal shape buildConveneBoard needs
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
  // `subtitle` carries the visible tab purpose; `hint` is hover-only elaboration.
  // On a gated tab the host joins `hint` with the disabled `reason`.
  const defs: {
    strategy: string;
    label: string;
    glyph: string;
    subtitle: string;
    hint: string;
    fields: (CanvasActionField | null)[];
  }[] = [
    {
      strategy: "sequential",
      label: "Discussion",
      glyph: "▸",
      subtitle: "Round-robin — each Mind builds on the last.",
      hint: "Round-robin — each Mind speaks in turn, building on the last. The default shape.",
      fields: [topicField, proj, groundingUrlField, criteriaField],
    },
    {
      strategy: "group-chat",
      label: "Debate",
      glyph: "◆",
      subtitle: "A chaired panel driving toward one decision.",
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
      subtitle: "Unchaired brainstorm; ends on a vote.",
      hint: "Unchaired brainstorm — the Minds route themselves and stop when enough vote to end.",
      fields: [topicField, turnsField, groundingUrlField, criteriaField],
    },
    {
      strategy: "review",
      label: "Review",
      glyph: "✓",
      subtitle: "Two-Mind cross-vendor pass — an independent second opinion.",
      hint: "A two-Mind cross-vendor pass — one authors, a different provider reviews for an independent second opinion.",
      fields: [topicField],
    },
    {
      strategy: "magentic",
      label: "Delegate",
      glyph: "⚑",
      subtitle: "A named manager splits the goal and delegates.",
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
      subtitle: s.subtitle,
      hint: s.hint,
      submitLabel: "Convene",
      payload: { strategy: s.strategy },
    };
    if (!gate.ok) return { ...base, disabled: true, reason: gate.reason };
    return { ...base, fields: s.fields.filter((f): f is CanvasActionField => f !== null) };
  });
}

// Pure: the roster + draft + host projects -> the Convene composer board. Under two
// Minds it is a single nudge; at >=2 it is the who's-in toggle chips (draft-set)
// plus the capability-gated shape tabs. `sessionCount` drives the header's
// defaultCollapsed hint so the region auto-folds once rooms exist (the composer is
// the empty-state cold, a one-click bar warm). Validated against canvasViewSchema in
// tests; the producer never parses (validation lives at the binding edge).
export function buildConveneBoard(
  minds: readonly Mind[],
  draftExcluded: ReadonlySet<string> = new Set(),
  projects: readonly ConveneProject[] = [],
  sessionCount = 0,
): CanvasBoardView {
  const selected = minds.filter((m) => !draftExcluded.has(m.slug));
  const sections: CanvasBoardView["sections"] = [];

  if (minds.length < 2) {
    sections.push({
      kind: "rows",
      items: [
        {
          glyph: "neutral",
          text:
            minds.length === 0
              ? "Author a Mind in the Chamber panel above, then seat a second to convene a Room."
              : "Seat a second Mind in the Chamber panel above to convene a Room.",
        },
      ],
    });
  } else {
    const chips: CanvasActionItem[] = minds.map((mind) => {
      const isSelected = !draftExcluded.has(mind.slug);
      return {
        type: "draft-set",
        label: mind.name,
        glyph: isSelected ? "✓" : "+",
        tone: identityToneForSlot(mind.identitySlot),
        payload: { slug: mind.slug },
      };
    });
    sections.push({ kind: "actions", title: "Who’s in", wrap: true, items: chips });
    if (selected.length >= 2) {
      sections.push({
        kind: "actions",
        title: "…and how",
        tabs: true,
        items: shapeActions(selected, projects),
      });
    } else {
      sections.push({
        kind: "rows",
        items: [{ glyph: "neutral", text: "Select two or more Minds to choose a room shape." }],
      });
    }
  }

  const status =
    minds.length < 2
      ? {
          label: `${minds.length} ${minds.length === 1 ? "mind" : "minds"}`,
          tone: "neutral" as CanvasTone,
        }
      : { label: `${selected.length} in`, tone: "brand" as CanvasTone };

  return {
    view: "board",
    title: "Convene",
    header: { status, defaultCollapsed: sessionCount > 0 },
    sections,
  };
}
