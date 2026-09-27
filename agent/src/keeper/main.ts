#!/usr/bin/env node
/** The keeper's process. Everything it does lives in `cli.ts`. */
import { runKeeperCli } from './cli.js';

const code = await runKeeperCli(process.argv.slice(2), {
  env: process.env,
  log: (line) => process.stdout.write(`${line}\n`),
  error: (line) => process.stderr.write(`${line}\n`),
});

process.exitCode = code;
