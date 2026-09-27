#!/usr/bin/env node
/** The entrypoint. Everything it does lives in `commands.ts`; this file only supplies the process. */

import { loadConfig } from "../config.js";
import { ConsoleLogger } from "../log.js";
import { urlSecrets } from "../redact.js";
import { runCli } from "./commands.js";

const env = process.env;
const config = loadConfig(env);

// The logger scrubs these before writing anything, so a key that leaks into an error
// message from a dependency still does not reach the terminal or a CI log.
//
// The endpoint URLs are in that list because The Graph's gateway puts its API key in the
// path, so `HUNCH_SUBGRAPH_URL` is a credential even though it does not read like one.
// `describeConfig` already redacts it; this covers the messages we do not write, such as
// a fetch failure that quotes the URL it was given.
const logger = new ConsoleLogger([
  config.circle.apiKey,
  config.circle.entitySecretCiphertext,
  config.gateway.apiKey,
  ...urlSecrets(config.subgraphUrl),
  ...urlSecrets(config.intelUrl),
]);

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const code = await runCli(process.argv.slice(2), {
  logger,
  env,
  fetchImpl: fetch,
  sleep,
  now: () => Math.floor(Date.now() / 1000),
});

process.exitCode = code;
