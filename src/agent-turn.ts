// Local mirror of the C1 agent-turn seam (docs/design/C1-agent-invocation.md).
// RibContext does not expose `runAgentTurn` yet; the room driver is written
// against these types now and wired to the real seam when C1 lands. At that
// point this file's body collapses to:
//   export type { RibAgentTurnRequest, RibAgentTurnResult, RibAgentTurn } from "@keelson/shared";
// keeping the `RunAgentTurn` alias below.
import type { MessageChunk } from "@keelson/shared";

export interface RibAgentTurnRequest {
  prompt: string;
  system?: string;
  provider?: string;
  model?: string;
  tools?: readonly { name: string; [k: string]: unknown }[];
  allowedTools?: readonly string[];
  disallowedTools?: readonly string[];
  abortSignal?: AbortSignal;
  timeoutMs?: number;
  cwd?: string;
  resumeSessionId?: string;
}

export interface RibAgentTurnResult {
  status: "ok" | "aborted" | "timeout" | "error";
  text: string;
  error?: string;
  providerId?: string;
  sessionId?: string;
}

export interface RibAgentTurn {
  stream: AsyncIterable<MessageChunk>;
  result: Promise<RibAgentTurnResult>;
}

export type RunAgentTurn = (req: RibAgentTurnRequest) => RibAgentTurn;
