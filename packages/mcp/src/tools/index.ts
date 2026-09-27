import type { ToolDefinition } from "../tool.js";
import { agentReputationTool } from "./agent-reputation.js";
import { claimableTool } from "./claimable.js";
import { marketBookTool } from "./market-book.js";

/** The three tools, in the order an agent usually needs them. */
export const TOOLS: readonly ToolDefinition[] = [marketBookTool, agentReputationTool, claimableTool];

export { agentReputationTool, claimableTool, marketBookTool };
