// The C1 agent-turn seam now lives in @keelson/shared (RibContext.runAgentTurn).
// This module is a thin re-export so ports.ts / room.ts keep importing the turn
// types and the RunAgentTurn alias from here, unchanged.
export type { RibAgentTurn, RibAgentTurnRequest, RibAgentTurnResult } from "@keelson/shared";

import type { RibAgentTurn, RibAgentTurnRequest } from "@keelson/shared";

export type RunAgentTurn = (req: RibAgentTurnRequest) => RibAgentTurn;
