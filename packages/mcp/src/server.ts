/**
 * Tool listing and dispatch.
 *
 * This uses the SDK's transport-level `Server` rather than the `McpServer` convenience
 * wrapper for two reasons, both about what an agent sees:
 *
 *   1. The input schemas are hand-written JSON Schema, so the contract a model reads is
 *      exactly the text in the tool module — not whatever a zod-to-JSON-Schema
 *      conversion happens to emit.
 *   2. Every failure, argument validation included, comes back as a tool result the
 *      model can read and act on. `McpServer` raises invalid arguments as a JSON-RPC
 *      error instead, which a model sees as "the tool is broken" rather than "I passed
 *      a bad market id".
 *
 * Validation itself is the SDK's own AJV provider, so the schema published in
 * `tools/list` is the schema arguments are checked against, with no second definition
 * to drift.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import type { JsonSchemaType, JsonSchemaValidator } from "@modelcontextprotocol/sdk/validation";

import { ToolError } from "./errors.js";
import { errorResult, failureResult, toolResult, type ToolDefinition, type ToolDeps } from "./tool.js";
import { TOOLS } from "./tools/index.js";
import { SERVER_NAME, VERSION } from "./version.js";

/**
 * Shown to the model once, when the server connects. It is the shortest honest
 * description of the venue: without it an agent treats the tools as a generic market
 * API and never asks whether its stake will be accepted.
 */
export const SERVER_INSTRUCTIONS = `Hunch VPM is a parimutuel prediction market on Arc settled in USDC.

Two things make it behave unlike a pool you may have seen before:

1. Stake vests into the opposing books the moment it lands, so early money earns a
   larger multiple than late money on the same outcome. Arriving seconds before the
   freeze with the answer is not profitable here.
2. A book can only accept stake up to its headroom, H = capacity - vested. Stake beyond
   that is REFUSED, not failed: the entry still lands, a smaller amount is accepted, and
   the remainder becomes refundable. Always check headroom before sizing an entry.

Use vpm_market_book before entering, vpm_agent_reputation to judge a counterparty, and
vpm_claimable to find what is owed. All three are read-only. Entering a market or
claiming a payout means signing a transaction from your own wallet; this server holds no
keys and never moves funds.`;

export interface ToolRouter {
  list(): Tool[];
  call(name: string, args: unknown): Promise<CallToolResult>;
}

export function createToolRouter(deps: ToolDeps, tools: readonly ToolDefinition[] = TOOLS): ToolRouter {
  const provider = new AjvJsonSchemaValidator();
  const validators = new Map<string, JsonSchemaValidator<unknown>>();
  for (const tool of tools) {
    // Compiled once at startup: a schema that will not compile should break the server
    // immediately, not on the first call from an agent.
    validators.set(tool.name, provider.getValidator<unknown>(tool.inputSchema as unknown as JsonSchemaType));
  }

  return {
    list() {
      return tools.map((tool) => ({
        name: tool.name,
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: {
          title: tool.title,
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          // The answers come from a live chain and its indexers, not a closed set.
          openWorldHint: true,
        },
      }));
    },

    async call(name, args) {
      const tool = tools.find((candidate) => candidate.name === name);
      if (tool === undefined) {
        return errorResult(
          new ToolError("invalid_input", `No tool named "${name}" on this server.`, {
            hint: `Available tools: ${tools.map((candidate) => candidate.name).join(", ")}.`,
          }),
        );
      }

      const validate = validators.get(name);
      const result = validate?.(args ?? {});
      if (result !== undefined && !result.valid) {
        return errorResult(
          new ToolError("invalid_input", `Arguments for ${name} did not match its schema: ${result.errorMessage}`, {
            hint: `Required: ${(tool.inputSchema.required ?? []).join(", ") || "nothing"}. See the tool's inputSchema.`,
            detail: { tool: name },
          }),
        );
      }

      try {
        return toolResult(await tool.run(args ?? {}, deps));
      } catch (thrown) {
        return failureResult(thrown);
      }
    },
  };
}

export function createMcpServer(deps: ToolDeps, tools: readonly ToolDefinition[] = TOOLS): Server {
  const server = new Server(
    { name: SERVER_NAME, version: VERSION },
    { capabilities: { tools: {} }, instructions: SERVER_INSTRUCTIONS },
  );
  const router = createToolRouter(deps, tools);

  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: router.list() }));
  server.setRequestHandler(CallToolRequestSchema, (request) => router.call(request.params.name, request.params.arguments));

  return server;
}
