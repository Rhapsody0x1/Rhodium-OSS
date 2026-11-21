// The daemon owns the plugin registry. A slot response includes the same metadata as the board.
import { createContext, useContext } from "react";
import { AGENT_KINDS, agentDef } from "../../src/agents";
import type { BoardMetadata } from "../../src/board";

export const Metadata = createContext<BoardMetadata | undefined>(undefined);
const builtins = AGENT_KINDS.map(id => ({ id, ...agentDef(id) }));
export const useAgents = () => useContext(Metadata)?.agents ?? builtins;
export function useAgent(id: string) {
  return useAgents().find(a => a.id === id) ?? agentDef(id);
}
