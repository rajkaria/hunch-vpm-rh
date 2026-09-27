/**
 * Every failure an agent can hit is a piece of information it can act on, so failures
 * travel as tool results (`isError: true`) rather than as transport-level exceptions.
 * A model that gets a JSON-RPC error sees "the tool broke"; a model that gets
 * `not_configured` with the name of the missing environment variable can tell its user
 * exactly what to fix, and a model that gets `market_frozen` can stop trying to enter.
 */

export type ToolErrorCode =
  /** The arguments did not match the tool's input schema. */
  | "invalid_input"
  /** The server is missing configuration this tool needs (the message names the variable). */
  | "not_configured"
  /** A data source (subgraph, RPC) was unreachable, slow or returned a transport error. */
  | "upstream_unavailable"
  /** The data source answered, but the thing asked for does not exist. */
  | "not_found"
  /** The data source answered with a shape this server does not understand. */
  | "bad_upstream_data"
  /** A bug on our side. */
  | "internal";

export interface ToolErrorDetail {
  readonly code: ToolErrorCode;
  readonly message: string;
  /** What the caller (or its user) can do about it. Omitted when there is nothing useful to say. */
  readonly hint?: string;
  /** Machine-readable extras: the offending field, the endpoint that failed, and so on. */
  readonly detail?: Record<string, unknown>;
}

export class ToolError extends Error {
  readonly code: ToolErrorCode;
  readonly hint: string | undefined;
  readonly detail: Record<string, unknown> | undefined;

  constructor(code: ToolErrorCode, message: string, options?: { hint?: string; detail?: Record<string, unknown>; cause?: unknown }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ToolError";
    this.code = code;
    this.hint = options?.hint;
    this.detail = options?.detail;
  }

  toDetail(): ToolErrorDetail {
    return {
      code: this.code,
      message: this.message,
      ...(this.hint === undefined ? {} : { hint: this.hint }),
      ...(this.detail === undefined ? {} : { detail: this.detail }),
    };
  }
}

/** Raised by the decoders when an upstream payload does not match the shape we expect. */
export function badUpstreamData(path: string, expected: string, got: unknown): ToolError {
  return new ToolError("bad_upstream_data", `Expected ${expected} at \`${path}\`, got ${describe(got)}.`, {
    hint: "The data source returned a shape this server does not understand. If @hunch-vpm/client changed, update packages/mcp/src/client-surface.ts to match.",
    detail: { path, expected },
  });
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return `an array of ${value.length}`;
  if (typeof value === "object") return `an object with keys [${Object.keys(value as object).join(", ")}]`;
  if (typeof value === "string") return `the string ${JSON.stringify(value.length > 40 ? `${value.slice(0, 40)}…` : value)}`;
  return `${typeof value} ${String(value)}`;
}

/**
 * Anything that escapes a handler becomes an `internal` error rather than killing the
 * process. An MCP server that exits takes the agent's whole session with it.
 */
export function asToolError(thrown: unknown): ToolError {
  if (thrown instanceof ToolError) return thrown;
  if (thrown instanceof Error) {
    return new ToolError("internal", thrown.message, { cause: thrown, detail: { name: thrown.name } });
  }
  return new ToolError("internal", `Unexpected failure: ${String(thrown)}`);
}
