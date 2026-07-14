import type { RibAction, RibActionResult } from "@keelson/shared";
import {
  deleteExhibitAction,
  lensHtmlAction,
  lensNoteAction,
  lensOpenAction,
  refreshLensAction,
  retireHtmlLensAction,
  retireLensAction,
} from "./lenses.ts";
import {
  authorArchetypeAction,
  describeOwnAction,
  dismissGenesisAction,
  enterMindAction,
  retireAction,
  setModelAction,
} from "./minds.ts";
import {
  conveneAction,
  draftSetAction,
  outcomeCopyAction,
  outcomeExploreAction,
  roomDeleteAction,
  roomInjectAction,
  roomOpenAction,
  roomSummaryAction,
  roomStartAction,
  roomStopAction,
} from "./rooms.ts";

// The only chamber verbs an untrusted HTML-lens iframe may reach (origin
// "canvas-html"): a no-op ack (`lens-html`) and read-only navigation to a lens
// panel (`lens-open`). Everything destructive or paid stays off this list, so a
// prompt-injected lens can't drive retire / room-* / set-model / convene. See #124.
const FRAME_SAFE_ACTIONS: ReadonlySet<string> = new Set(["lens-html", "lens-open"]);

export function dispatchChamberAction(
  action: RibAction,
): RibActionResult | Promise<RibActionResult> {
  // Actions relayed from the sandboxed HTML-lens iframe arrive with origin
  // "canvas-html" (the host stamps it; the frame can't forge it — see #124). That
  // markup is LLM-authored and can auto-fire on load, so gate it to a non-paid,
  // non-destructive subset — never retire / room-* / set-model / convene. Trusted
  // board actions (origin absent) keep the full verb surface below.
  if (action.origin === "canvas-html" && !FRAME_SAFE_ACTIONS.has(action.type)) {
    return { ok: false, error: `'${action.type}' is not permitted from an HTML lens` };
  }
  switch (action.type) {
    case "enter-mind":
      return enterMindAction(action);
    case "author-archetype":
      return authorArchetypeAction(action);
    case "describe-own":
      return describeOwnAction(action);
    case "dismiss-genesis":
      return dismissGenesisAction(action);
    case "retire":
      return retireAction(action);
    case "set-model":
      return setModelAction(action);
    case "lens-html":
      return lensHtmlAction(action);
    case "room-start":
      return roomStartAction(action);
    case "draft-set":
      return draftSetAction(action);
    case "convene":
      return conveneAction(action);
    case "room-inject":
      return roomInjectAction(action);
    case "room-stop":
      return roomStopAction(action);
    case "room-delete":
      return roomDeleteAction(action);
    case "room-open":
      return roomOpenAction(action);
    case "room-summary":
      return roomSummaryAction(action);
    case "outcome-copy":
      return outcomeCopyAction(action);
    case "outcome-explore":
      return outcomeExploreAction(action);
    case "retire-lens":
      return retireLensAction(action);
    case "retire-lens-html":
      return retireHtmlLensAction(action);
    case "delete-exhibit":
      return deleteExhibitAction(action);
    case "lens-open":
      return lensOpenAction(action);
    case "lens-note":
      return lensNoteAction(action);
    case "refresh-lens":
      return refreshLensAction(action);
    default:
      return { ok: false, error: `unknown action '${action.type}'` };
  }
}
