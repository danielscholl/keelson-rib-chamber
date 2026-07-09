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

// The facilitator (Debate chair / Build manager) is drawn from the Minds NOT in the
// cast — the "second selection" that ties to who's left out. Only built for an
// enabled shape, where `eligible` is non-empty (evalShape gates on it), so the
// select always carries at least one option.
function facilitatorField(
  name: "moderator" | "manager",
  label: string,
  eligible: readonly Mind[],
): CanvasActionField {
  return {
    name,
    label,
    placeholder: "A Mind not in the room",
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
// rather than failing server-side. validateStart stays the source of truth; this only
// gates the affordance.
function evalShape(strategy: string, cast: readonly Mind[], out: readonly Mind[]): ShapeEval {
  switch (strategy) {
    case "group-chat":
      return out.length > 0
        ? { ok: true }
        : { ok: false, reason: "Every Mind is in — free one from the cast to chair." };
    case "magentic":
      return out.length > 0
        ? { ok: true }
        : { ok: false, reason: "Every Mind is in — free one from the cast to manage." };
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
  out: readonly Mind[],
  projects: readonly ConveneProject[],
): CanvasActionItem[] {
  const proj = projectField(projects);
  // `hint` is the room shape's purpose, surfaced on hover so the driver need not
  // remember which tab does what. It stays put whether the tab is enabled or gated;
  // on a gated tab the host joins it with the disabled `reason` (what it does — why
  // it can't run now). Kept to one line, matching the concepts doc's voice.
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
      fields: [topicField, proj],
    },
    {
      strategy: "group-chat",
      label: "Debate",
      glyph: "◆",
      hint: "A chaired panel — a Mind you leave out moderates the others toward one decision.",
      fields: [
        topicField,
        facilitatorField("moderator", "Chair — a Mind not in the room", out),
        turnsField,
      ],
    },
    {
      strategy: "open-floor",
      label: "Open floor",
      glyph: "⊙",
      hint: "Unchaired brainstorm — the Minds route themselves and stop when enough vote to end.",
      fields: [topicField, turnsField],
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
      label: "Build",
      glyph: "⚑",
      hint: "A manager you leave out splits the goal into tasks and delegates to the others until it's built.",
      fields: [
        topicField,
        facilitatorField("manager", "Manager — a Mind not in the room", out),
        proj,
        turnsField,
      ],
    },
  ];
  return defs.map((s) => {
    const gate = evalShape(s.strategy, cast, out);
    const base: CanvasActionItem = {
      type: "convene",
      label: s.label,
      glyph: s.glyph,
      hint: s.hint,
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
  const out = minds.filter((m) => draftExcluded.has(m.slug));
  const sections: CanvasBoardView["sections"] = [];

  if (minds.length < 2) {
    sections.push({
      kind: "rows",
      items: [
        {
          glyph: "neutral",
          text:
            minds.length === 0
              ? "Author a Mind in the Roster, then seat a second to convene a Room."
              : "Seat a second Mind in the Roster to convene a Room.",
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
        items: shapeActions(selected, out, projects),
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
