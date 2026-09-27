#!/usr/bin/env node
/**
 * Runs a graph-cli command against a network from networks.json without leaving the committed
 * manifest rewritten.
 *
 * `graph build --network <name>` edits subgraph.yaml in place: it swaps in that network's
 * addresses and start blocks, and re-serialises the YAML, which drops every comment. The
 * committed manifest is the arc-testnet one, so snapshot it, run the command, and restore it
 * afterwards — including when the command fails.
 *
 *   node tools/with-network.mjs arc build
 *   node tools/with-network.mjs arc deploy erc8004-arc --node https://api.studio.thegraph.com/deploy/
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = join(root, "subgraph.yaml");

const [network, ...graphArgs] = process.argv.slice(2);
if (!network || graphArgs.length === 0) {
  console.error("usage: node tools/with-network.mjs <network> <graph-subcommand> [args...]");
  process.exit(2);
}

const networks = JSON.parse(readFileSync(join(root, "networks.json"), "utf8"));
if (!Object.hasOwn(networks, network)) {
  console.error(
    `unknown network "${network}". networks.json defines: ${Object.keys(networks).join(", ")}`,
  );
  process.exit(2);
}

if (!existsSync(manifest)) {
  console.error(`missing ${manifest}`);
  process.exit(2);
}

const original = readFileSync(manifest);
// Keep a copy on disk too, so an interrupted run (Ctrl-C, a crash) is still recoverable by hand.
copyFileSync(manifest, `${manifest}.orig`);

const result = spawnSync("graph", [...graphArgs, "--network", network], {
  cwd: root,
  stdio: "inherit",
  shell: process.platform === "win32",
  env: { ...process.env, PATH: `${join(root, "node_modules", ".bin")}:${process.env.PATH ?? ""}` },
});

writeFileSync(manifest, original);

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}
process.exit(result.status ?? 1);
