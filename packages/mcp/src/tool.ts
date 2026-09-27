/**
 * What a tool is here, and what it hands back.
 *
 * Every result carries the same two things: a prose summary a model can act on without
 * parsing anything, and the structured data behind it. The MCP specification asks a
 * tool with structured output to also serialize it into a text block for hosts that do
 * not read `structuredContent`, so results carry both and cost one extra block.
 */

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import type { ServerConfig } from "./config.js";
import type { AgentDirectory } from "./agent-directory.js";
import type { VenueReader } from "./venue-reader.js";
import { asToolError, type ToolError } from "./errors.js";

/**
 * The subset of JSON Schema these tools use. Hand-written rather than generated from a
 * validator library's types: the schema is the contract a model reads before deciding
 * whether to call a tool, so it is worth writing by hand and reviewing like prose.
 */
export interface JsonSchema {
  type: "object";
  title?: string;
  description?: string;
  properties?: Record<string, object>;
  required?: string[];
  additionalProperties?: boolean;
  examples?: unknown[];
  /** Keywords beyond the ones spelled out above stay legal, as JSON Schema intends. */
  [keyword: string]: unknown;
}

export interface ToolDeps {
  readonly config: ServerConfig;
  readonly venue: VenueReader;
  readonly agents: AgentDirectory;
  /** Unix seconds. Injected so "time to freeze" is testable. */
  readonly now: () => number;
}

export interface ToolPayload {
  /** Prose first: what this means and what to do about it. */
  readonly summary: string;
  /** The same answer as data, JSON-safe (no bigints — use `money()` views). */
  readonly data: Record<string, unknown>;
}

export interface ToolDefinition {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly inputSchema: JsonSchema;
  readonly run: (input: unknown, deps: ToolDeps) => Promise<ToolPayload>;
}

/**
 * Binds a tool's own input type to its handler. The cast is sound because the registry
 * validates `input` against `inputSchema` before calling, and it happens exactly once,
 * here, instead of in every handler.
 */
export function defineTool<Input>(definition: {
  name: string;
  title: string;
  description: string;
  inputSchema: JsonSchema;
  run: (input: Input, deps: ToolDeps) => Promise<ToolPayload>;
}): ToolDefinition {
  return {
    name: definition.name,
    title: definition.title,
    description: definition.description,
    inputSchema: definition.inputSchema,
    run: (input, deps) => definition.run(input as Input, deps),
  };
}

export function toolResult(payload: ToolPayload): CallToolResult {
  return {
    content: [
      { type: "text", text: payload.summary },
      { type: "text", text: jsonBlock(payload.data) },
    ],
    structuredContent: payload.data,
  };
}

export function errorResult(error: ToolError): CallToolResult {
  const detail = error.toDetail();
  const lines = [error.message];
  if (detail.hint !== undefined) lines.push(detail.hint);
  return {
    content: [
      { type: "text", text: lines.join("\n") },
      { type: "text", text: jsonBlock({ error: detail }) },
    ],
    structuredContent: { error: detail },
    isError: true,
  };
}

export function failureResult(thrown: unknown): CallToolResult {
  return errorResult(asToolError(thrown));
}

/**
 * A bigint that reaches `JSON.stringify` throws, which would turn a formatting slip into
 * a dead tool call. Amounts are meant to be converted by `money()` long before this; the
 * replacer is the seatbelt.
 */
function jsonBlock(data: unknown): string {
  return JSON.stringify(data, (_key, value: unknown) => (typeof value === "bigint" ? value.toString() : value), 2);
}
