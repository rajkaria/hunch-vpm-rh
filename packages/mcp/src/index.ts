#!/usr/bin/env node
/**
 * The stdio entry point.
 *
 * stdout belongs to the protocol. Every diagnostic goes to stderr — a stray console.log
 * here corrupts the JSON-RPC stream and the host disconnects with an error that points
 * nowhere near the cause.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { createSubgraphAgentDirectory } from "./agent-directory.js";
import { loadVpmClient } from "./client-loader.js";
import { ConfigError, isPlaceholderSettler, loadConfig, type ServerConfig } from "./config.js";
import { ToolError } from "./errors.js";
import { createMcpServer } from "./server.js";
import type { ToolDeps } from "./tool.js";
import { createClientVenueReader } from "./venue-reader.js";
import { SERVER_NAME, VERSION } from "./version.js";

export { createMcpServer, createToolRouter, SERVER_INSTRUCTIONS } from "./server.js";
export { loadConfig, type ServerConfig } from "./config.js";
export { createClientVenueReader, type VenueReader } from "./venue-reader.js";
export { createSubgraphAgentDirectory, type AgentDirectory } from "./agent-directory.js";
export { loadVpmClient } from "./client-loader.js";
export { TOOLS } from "./tools/index.js";
export type { ToolDeps } from "./tool.js";
export type { VpmReadClient } from "./client-surface.js";

export async function buildDeps(config: ServerConfig): Promise<ToolDeps> {
  const client = await loadVpmClient(config);
  return {
    config,
    venue: createClientVenueReader(client),
    agents: createSubgraphAgentDirectory(config),
    now: () => Math.floor(Date.now() / 1000),
  };
}

async function main(): Promise<void> {
  let config: ServerConfig;
  try {
    config = loadConfig();
  } catch (thrown) {
    if (thrown instanceof ConfigError) {
      process.stderr.write(`${SERVER_NAME} ${VERSION} cannot start.\n${thrown.message}\n`);
      process.exitCode = 1;
      return;
    }
    throw thrown;
  }

  const deps = await buildDeps(config);
  const server = createMcpServer(deps);
  await server.connect(new StdioServerTransport());

  process.stderr.write(
    `${SERVER_NAME} ${VERSION} ready on stdio — ${config.chainName} (${config.chainId}), settler ${config.settlerAddress}${
      isPlaceholderSettler(config) ? " (placeholder: no venue deployed yet)" : ""
    }\n`,
  );
}

/**
 * A startup failure is usually a missing dependency or a misconfigured endpoint, and the
 * person reading it is looking at a host's log pane. The hint is worth more to them than
 * a stack trace, so ours goes first and the trace only appears for unexpected failures.
 */
function reportStartupFailure(thrown: unknown): void {
  if (thrown instanceof ToolError) {
    const detail = thrown.toDetail();
    process.stderr.write(`${SERVER_NAME} failed to start: ${detail.message}\n${detail.hint ?? ""}\n`);
    return;
  }
  process.stderr.write(
    `${SERVER_NAME} failed to start: ${thrown instanceof Error ? (thrown.stack ?? thrown.message) : String(thrown)}\n`,
  );
}

// Only when run as a program. Importing this module for its exports starts nothing.
if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((thrown: unknown) => {
    reportStartupFailure(thrown);
    process.exitCode = 1;
  });
}
