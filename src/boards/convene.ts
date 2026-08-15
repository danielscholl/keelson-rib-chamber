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
import { CODING_CAPABILITY_SLUGS } from "../capabilities.ts";
import type { Mind } from "../types.ts";

const SCOPE_TITLE = "What can they read?";
const NO_PROJECT_LABEL = "Nothing";
const NO_PROJECT_PLACEHOLDER = "Nothing (no project)";

// The host projects a room can target — the minimal shape conveneScopeSection needs
// (id is the option value the scope action resolves; name is the label).
export interface ConveneProject {
  id: string;
  name: string;
}

// The topic is what the shape will actually do with it — a debate decides, a delegate
// room decomposes a goal (TaskLedger.goal) — so the prompt names the shape's own verb
// rather than asking every room the same generic question. Required where a room drives
// to a definite outcome: those close on a decision, a ledger, or a review target, and a
// topicless one spends its turns with nothing to converge on.
//
// Unmarked reads as optional, so only a required field is marked — and it is marked in
// the label text because the renderer draws no required affordance of its own (it
// raises a submit-time error instead).
function topicField(placeholder: string, required = false): CanvasActionField {
  return {
    name: "topic",
    label: required ? "Topic (required)" : "Topic",
    placeholder,
    multiline: true,
    ...(required ? { required: true } : {}),
  };
}
const turnsField: CanvasActionField = {
  name: "turns",
  label: "Turns",
  placeholder: "8",
};
// The two halves of the grounding brief are one type but not one thing: the source is
// narration (renderGrounding puts it in every prompt and nothing reads it back), while
// the criteria are the only field here that is CHECKED — a cross-vendor room spends an
// extra paid turn diffing the outcome against them before it closes. Labelled by what
// each does rather than by the type they share.
const referenceField: CanvasActionField = {
  name: "groundingUrl",
  label: "Reference link",
  placeholder: "Issue or spec the room should work from",
};
const criteriaField: CanvasActionField = {
  name: "criteria",
  label: "Done when",
  placeholder: "One per line — a cross-vendor room spends a turn checking these at close",
  multiline: true,
};

// The most answers that read as a strip rather than wrapping into a block. Counted over
// the chips actually emitted — Nothing, one per project, and a dropped project's own —
// not over the project list, or a stale scope silently pushes the row two past it. Same
// threshold rule facilitatorField applies with `segmented`, but expressed as actions
// rather than a field: a field needs a submit, and a scope that can be picked without
// being committed is the whole failure this control has to stop making possible.
const MAX_SCOPE_CHIPS = 6;

// What the room can read, as a standing bar above the shape tabs rather than a field
// inside one of them: a project is a property of the room (it resolves to the cwd every
// turn takes) and not of how the Minds take turns, so asking for it per-shape both
// scattered it across two of five forms and lost it on every change of shape. Null only
// when there is neither anything to scope to nor a scope to recover from.
//
// Named for what it grants rather than where it points: picking a project IS the read
// grant (readToolPool, room-lifecycle.ts), and an unscoped room is one whose Minds can
// read nothing at all.
export function conveneScopeSection(
  projects: readonly ConveneProject[],
  scope: { projectId?: string; coding?: boolean },
): CanvasBoardView["sections"][number] | null {
  // A scope naming a project the host no longer offers still has to be selectable: the
  // draft holds a projectId every convene would reject, so the bar has to stay reachable
  // to clear it.
  const stale =
    scope.projectId && !projects.some((p) => p.id === scope.projectId)
      ? scope.projectId
      : undefined;
  // Nothing to scope to and nothing to recover from.
  if (projects.length === 0 && !stale) return null;
  const current = scope.projectId
    ? (projects.find((p) => p.id === scope.projectId)?.name ?? `${scope.projectId} (unavailable)`)
    : NO_PROJECT_LABEL;
  const chips = scopeChips(projects, scope, stale);
  const items: CanvasActionItem[] =
    chips.length <= MAX_SCOPE_CHIPS ? chips : [scopePicker(projects, scope, stale, current)];
  // The tier is a boolean, so it gets ONE control rather than a pair of segments implying
  // two peer choices: unset is read-only. It carries no fields, so it flips on click like
  // a seat card. It appears only for a LIVE project: the tier has no confinement boundary
  // without a repo to bound it to, and offering it against a project the host no longer
  // lists would only deepen a scope that already fails validateStart — the one useful
  // move there is to repick or clear the project.
  if (scope.projectId && !stale) {
    const on = scope.coding === true;
    items.push({
      type: "scope-set",
      // One constant label naming the capability, with `selected` carrying whether it
      // is granted. A label that swaps on click reads as two different things on one
      // control — "Discuss only" could equally describe what is true now or what a
      // click will do — and it also mislabelled the off state, since a scoped room
      // already reads the repo.
      label: "…and edit it",
      glyph: "✎",
      selected: on,
      hint: on
        ? `Turns may run Bash, Edit and Write inside ${current}. Click to make the room read-only.`
        : `Let this room's turns run Bash, Edit and Write inside ${current}. Reading is already allowed.`,
      payload: { coding: on ? "off" : "on" },
    });
  }
  return { kind: "actions", title: SCOPE_TITLE, wrap: true, items };
}

// One chip per answer, each dispatching on click. The strip echoes the shape tabs
// directly below it, so the whole composer answers its questions the same way — and
// there is no commit step to skip.
function scopeChips(
  projects: readonly ConveneProject[],
  scope: { projectId?: string },
  stale: string | undefined,
): CanvasActionItem[] {
  const chip = (
    project: string,
    label: string,
    glyph: string,
    selected: boolean,
    hint: string,
  ): CanvasActionItem => ({
    type: "scope-set",
    label,
    glyph,
    selected,
    hint,
    payload: { project },
  });
  return [
    chip(
      "",
      NO_PROJECT_LABEL,
      "⊘",
      !scope.projectId,
      "No project: the Minds reason from what they already know and can read no files. A Mind's own `read`/`code` grants nothing here.",
    ),
    ...projects.map((p) =>
      chip(
        p.id,
        p.name,
        "⌂",
        scope.projectId === p.id,
        `Every Mind in this room can read ${p.name}.`,
      ),
    ),
    // A dropped project keeps its own chip so the scope reads as stale rather than
    // vanishing — and so one click on any other chip replaces it.
    ...(stale
      ? [
          chip(
            stale,
            `${stale} (unavailable)`,
            "⌂",
            true,
            "The host no longer lists this project — every convene against it fails. Pick another, or Nothing.",
          ),
        ]
      : []),
  ];
}

// Past MAX_SCOPE_CHIPS the strip stops reading at a glance, so the picker returns to a
// select behind a control whose label is its current value. A defaultValue matching no
// option fails the board's own schema — which would stop the whole panel publishing
// rather than merely look stale — so a dropped project still contributes its option.
function scopePicker(
  projects: readonly ConveneProject[],
  scope: { projectId?: string },
  stale: string | undefined,
  current: string,
): CanvasActionItem {
  return {
    type: "scope-set",
    label: `Reads — ${current}`,
    glyph: "⌂",
    hint: "What this room can read: the project root each turn takes as its working directory. Every Mind in a scoped room can read it.",
    submitLabel: "Set project",
    fields: [
      {
        name: "project",
        label: "Project",
        // Not required, so its placeholder doubles as the clear option — picking it
        // dispatches "" and drops the scope (and the coding tier with it).
        placeholder: NO_PROJECT_PLACEHOLDER,
        options: [
          ...projects.map((p) => ({ value: p.id, label: p.name })),
          ...(stale ? [{ value: stale, label: `${stale} (unavailable)` }] : []),
        ],
        defaultValue: scope.projectId ?? "",
      },
    ],
  };
}

// The contradiction a blind room hides: a Mind declaring `read`/`code` carries a skill
// this room resolves to nothing (resolveMindTools intersects the declaration against a
// pool the unscoped room never fills). Stated where the scope is chosen, before any turn
// is billed — a warning and not a gate, since a discussion between capable Minds who
// simply have nothing to read is a legitimate room to convene.
export function conveneScopeWarning(
  cast: readonly Mind[],
  scope: { projectId?: string },
): CanvasBoardView["sections"][number] | null {
  if (scope.projectId) return null;
  const blind = cast.filter((m) => m.tools?.some((t) => CODING_CAPABILITY_SLUGS.has(t)));
  if (blind.length === 0) return null;
  const names = blind.map((m) => m.name);
  const who =
    names.length === 1
      ? `${names[0]} can read code`
      : names.length === 2
        ? `${names[0]} and ${names[1]} can read code`
        : `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]} can read code`;
  return {
    kind: "rows",
    items: [{ glyph: "warn" as CanvasTone, text: `${who} — but this room reads nothing.` }],
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
function shapeActions(cast: readonly Mind[]): CanvasActionItem[] {
  // `blurb` is the one-line description the `tabs` layout renders under the name, so
  // choosing a shape needs no hover; `hint` stays the fuller hover text, which the host
  // joins with the disabled `reason` on a gated tab.
  //
  // Field order follows what each answer is FOR: what they're working on (topic, then
  // the reference that frames it), how this shape runs (facilitator, turns), and last
  // the one thing that is checked at close.
  const defs: {
    strategy: string;
    label: string;
    glyph: string;
    blurb: string;
    hint: string;
    fields: CanvasActionField[];
  }[] = [
    {
      strategy: "sequential",
      label: "Discussion",
      glyph: "▸",
      blurb: "Round-robin — each builds on the last",
      hint: "Round-robin — each Mind speaks in turn, building on the last. The default shape.",
      fields: [topicField("What should they discuss?"), referenceField, turnsField, criteriaField],
    },
    {
      strategy: "group-chat",
      label: "Debate",
      glyph: "◆",
      blurb: "A chair you name drives one decision",
      hint: "A chaired panel — a Mind you name chairs the others toward one decision.",
      fields: [
        topicField("What should they decide?", true),
        referenceField,
        facilitatorField("moderator", "Chair (required)", cast),
        turnsField,
        criteriaField,
      ],
    },
    {
      strategy: "open-floor",
      label: "Open floor",
      glyph: "⊙",
      blurb: "Unchaired — they route themselves",
      hint: "Unchaired brainstorm — the Minds route themselves and stop when enough vote to end.",
      fields: [topicField("What should they explore?"), referenceField, turnsField, criteriaField],
    },
    {
      strategy: "review",
      label: "Review",
      glyph: "✓",
      blurb: "Cross-vendor pair — one authors, one reviews",
      hint: "A two-Mind cross-vendor pass — one authors, a different provider reviews for an independent second opinion.",
      fields: [topicField("What should they review?", true)],
    },
    {
      strategy: "magentic",
      label: "Delegate",
      glyph: "⚑",
      blurb: "A manager splits and assigns the goal",
      hint: "A manager you name splits the goal into tasks and delegates to the others until it's done. Magentic-style orchestration.",
      fields: [
        topicField("What goal should they complete?", true),
        referenceField,
        facilitatorField("manager", "Manager (required)", cast),
        turnsField,
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
      // The tab's strategy rides `binding` (merged after the collected fields),
      // so no field can shadow which shape the click convenes.
      binding: { strategy: s.strategy },
    };
    if (!gate.ok) return { ...base, subtitle: gate.short, disabled: true, reason: gate.reason };
    return {
      ...base,
      // Discussion is the default shape and is never gated, so the strip opens on it
      // rather than on nothing.
      ...(s.strategy === "sequential" ? { defaultOpen: true } : {}),
      fields: s.fields,
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
export function conveneShapeSection(cast: readonly Mind[]): CanvasBoardView["sections"][number] {
  if (cast.length >= 2) {
    return {
      kind: "actions",
      title: "How should they convene?",
      tabs: true,
      items: shapeActions(cast),
    };
  }
  return {
    kind: "rows",
    items: [{ glyph: "neutral", text: "Seat two or more Minds to convene." }],
  };
}
