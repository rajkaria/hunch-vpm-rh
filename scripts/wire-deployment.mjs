#!/usr/bin/env node
/**
 * Carries deployments/arc-<network>.json into every file that reads a deployed address, and
 * checks that they still agree.
 *
 *   node scripts/wire-deployment.mjs testnet           write: addresses and start blocks
 *   node scripts/wire-deployment.mjs testnet --check   exit 1 if any reader disagrees
 *   node scripts/wire-deployment.mjs --check           both networks (what `pnpm verify` runs)
 *
 * Why this exists: four committed files hold the same four addresses and none of them imports
 * another — the web app has to typecheck before the client is built, and a subgraph manifest
 * cannot import anything. Hand-copying them after a deploy is how one reader ends up pointing
 * at a different settler than the others, and nothing fails until a stake lands in a contract
 * the index is not watching.
 *
 * The file for a network is the source of truth. With no file, every reader must hold the zero
 * address — absence means "not deployed", so a stray address anywhere is as wrong as a stale
 * one.
 *
 * Start blocks come from forge's own broadcast receipts
 * (contracts/broadcast/Deploy.s.sol/<chainId>/run-latest.json) and are written back into the
 * deployments file, so the record survives even if the broadcast directory does not. A subgraph
 * that starts at block 0 on Arc testnet walks sixty million empty blocks first.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ZERO = "0x0000000000000000000000000000000000000000";
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** Deployment key -> subgraph data source name. Order is the order the script deploys them. */
const CONTRACTS = {
  vestedParimutuel: "VestedParimutuel",
  classicParimutuel: "ClassicParimutuel",
  feedResolver: "FeedResolver",
  marketFactory: "MarketFactory",
};

const NETWORKS = {
  testnet: {
    chainId: 5042002,
    graphNetwork: "arc-testnet",
    clientBlock: "const arcTestnetAddresses: HunchAddresses = {",
    webBlock: "export const ARC_TESTNET_ADDRESSES: ContractAddresses = {",
    // The committed subgraph manifest is the arc-testnet one, so it carries these values too.
    manifest: true,
  },
  mainnet: {
    chainId: 5042,
    graphNetwork: "arc",
    clientBlock: "const arcMainnetAddresses: HunchAddresses = {",
    webBlock: "export const ARC_MAINNET_ADDRESSES: ContractAddresses = {",
    manifest: false,
  },
};

/**
 * The web app also names the oracle adapter, so it can say which provider a market's spec reads.
 * Only the web reads it; the subgraph and the client address the adapter per market.
 */
const WEB_ONLY = ["priceOracle"];

/**
 * Adapters added after the main deploy, by their own script. Optional: a deployment without one
 * wires the zero address, so the web never names a provider the network does not have.
 */
const OPTIONAL_WEB = ["chainlinkCreOracle"];

const FILES = {
  networks: "subgraph/networks.json",
  manifest: "subgraph/subgraph.yaml",
  client: "packages/client/src/addresses.ts",
  web: "apps/web/src/lib/chain.ts",
};

class WireError extends Error {}

const read = (path) => readFileSync(join(ROOT, path), "utf8");
const lower = (address) => address.toLowerCase();

// ------------------------------------------------------------------ what the readers should hold

function deploymentPath(network) {
  return `deployments/arc-${network}.json`;
}

function broadcastPath(chainId) {
  return `contracts/broadcast/Deploy.s.sol/${chainId}/run-latest.json`;
}

/** Deploy blocks per contract, from forge's receipts. */
function blocksFromBroadcast(chainId, addresses) {
  const path = broadcastPath(chainId);
  if (!existsSync(join(ROOT, path))) {
    throw new WireError(
      `no start blocks in the deployments file and no ${path} to take them from. ` +
        `Add "startBlocks": { ${Object.keys(CONTRACTS).map((key) => `"${key}": <block>`).join(", ")} } by hand`,
    );
  }
  const run = JSON.parse(read(path));
  const blockByAddress = new Map();
  for (const receipt of run.receipts ?? []) {
    if (typeof receipt.contractAddress === "string" && receipt.blockNumber !== undefined) {
      blockByAddress.set(lower(receipt.contractAddress), Number(BigInt(receipt.blockNumber)));
    }
  }
  const blocks = {};
  for (const key of Object.keys(CONTRACTS)) {
    const block = blockByAddress.get(lower(addresses[key]));
    if (block === undefined) {
      throw new WireError(`${path} has no creation receipt for ${key} at ${addresses[key]} — is it from this deploy?`);
    }
    blocks[key] = block;
  }
  return blocks;
}

/**
 * What every reader should hold for one network: the deployed addresses and their deploy blocks,
 * or zeros when the network has no deployments file.
 */
function expected(network, { write }) {
  const spec = NETWORKS[network];
  const path = deploymentPath(network);
  if (!existsSync(join(ROOT, path))) {
    const zeros = Object.fromEntries(Object.keys(CONTRACTS).map((key) => [key, { address: ZERO, startBlock: 0 }]));
    return { deployed: false, contracts: zeros, oracle: ZERO, optional: optionalAddresses({}) };
  }

  let deployment;
  try {
    deployment = JSON.parse(read(path));
  } catch (error) {
    throw new WireError(`${path} is not JSON (${error.message}). The sed cut is a text cut — read the file`);
  }
  if (deployment.chainId !== spec.chainId) {
    throw new WireError(`${path} says chainId ${deployment.chainId}; Arc ${network} is ${spec.chainId}. DO NOT WIRE`);
  }
  for (const key of [...Object.keys(CONTRACTS), ...WEB_ONLY]) {
    const address = deployment[key];
    if (typeof address !== "string" || !ADDRESS.test(address) || lower(address) === ZERO) {
      throw new WireError(`${path}: ${key} is ${JSON.stringify(address)}, not a deployed address`);
    }
  }

  let blocks = deployment.startBlocks;
  if (blocks === undefined) {
    if (!write) throw new WireError(`${path} has no startBlocks. Run: node scripts/wire-deployment.mjs ${network}`);
    blocks = blocksFromBroadcast(spec.chainId, deployment);
    deployment.startBlocks = blocks;
    writeFileSync(join(ROOT, path), `${JSON.stringify(deployment, null, 2)}\n`);
    console.log(`  wrote startBlocks into ${path} from ${broadcastPath(spec.chainId)}`);
  }
  for (const key of Object.keys(CONTRACTS)) {
    if (!Number.isInteger(blocks[key]) || blocks[key] <= 0) {
      throw new WireError(`${path}: startBlocks.${key} is ${JSON.stringify(blocks[key])}, not a block number`);
    }
  }

  const contracts = Object.fromEntries(
    Object.keys(CONTRACTS).map((key) => [key, { address: deployment[key], startBlock: blocks[key] }]),
  );
  for (const key of OPTIONAL_WEB) {
    const address = deployment[key];
    if (address !== undefined && (typeof address !== "string" || !ADDRESS.test(address))) {
      throw new WireError(`${path}: ${key} is ${JSON.stringify(address)}, not an address`);
    }
  }
  return { deployed: true, contracts, oracle: deployment.priceOracle, optional: optionalAddresses(deployment), deployment };
}

/** The optional adapters, zero where the deployment has none. */
function optionalAddresses(deployment) {
  return Object.fromEntries(OPTIONAL_WEB.map((key) => [key, deployment[key] ?? ZERO]));
}

/** key -> address, without the start blocks. */
function addressesOf(contracts) {
  return Object.fromEntries(Object.entries(contracts).map(([key, { address }]) => [key, address]));
}

// ------------------------------------------------------------------ the readers

/** The `{ ... }` block that starts at `opener` in a TypeScript file, as [start, end] offsets. */
function objectBlock(source, opener, file) {
  const start = source.indexOf(opener);
  if (start === -1) throw new WireError(`${file}: cannot find \`${opener}\``);
  const end = source.indexOf("\n};", start);
  if (end === -1) throw new WireError(`${file}: \`${opener}\` has no closing \`};\``);
  return [start, end];
}

function tsKeyPattern(key) {
  return new RegExp(`(\\n\\s*${key}: )(UNDEPLOYED|'0x[0-9a-fA-F]{40}'),`);
}

function readTsAddresses(file, opener, keys = Object.keys(CONTRACTS)) {
  const source = read(file);
  const [start, end] = objectBlock(source, opener, file);
  const block = source.slice(start, end);
  return Object.fromEntries(
    keys.map((key) => {
      const match = block.match(tsKeyPattern(key));
      if (match === null) throw new WireError(`${file}: no \`${key}:\` line inside \`${opener}\``);
      return [key, match[2] === "UNDEPLOYED" ? ZERO : match[2].slice(1, -1)];
    }),
  );
}

function writeTsAddresses(file, opener, network, addresses, deployed) {
  const source = read(file);
  const [start, end] = objectBlock(source, opener, file);
  let block = source.slice(start, end);
  for (const [key, address] of Object.entries(addresses)) {
    if (!tsKeyPattern(key).test(block)) throw new WireError(`${file}: no \`${key}:\` line inside \`${opener}\``);
    const value = deployed && lower(address) !== ZERO ? `'${address}'` : "UNDEPLOYED";
    block = block.replace(tsKeyPattern(key), `$1${value},`);
  }
  // The placeholder comment above the settlers stops being true the moment they are wired.
  if (deployed) {
    block = block.replace(
      /\/\/ PLACEHOLDER until[^\n]*/,
      `// From deployments/arc-${network}.json, carried here by scripts/wire-deployment.mjs.`,
    );
  }
  writeFileSync(join(ROOT, file), source.slice(0, start) + block + source.slice(end));
}

function manifestPattern(name) {
  // name → network → source → address, then the same source's startBlock.
  return new RegExp(
    `(name: ${name}\\n\\s+network: arc-testnet\\n\\s+source:\\n\\s+address: ")(0x[0-9a-fA-F]{40})("\\n(?:\\s+[a-zA-Z]+: [^\\n]*\\n)*?\\s+startBlock: )(\\d+)`,
  );
}

function readManifest() {
  const source = read(FILES.manifest);
  return Object.fromEntries(
    Object.entries(CONTRACTS).map(([key, name]) => {
      const match = source.match(manifestPattern(name));
      if (match === null) throw new WireError(`${FILES.manifest}: cannot find the ${name} data source`);
      return [key, { address: match[2], startBlock: Number(match[4]) }];
    }),
  );
}

function writeManifest(contracts) {
  let source = read(FILES.manifest);
  for (const [key, name] of Object.entries(CONTRACTS)) {
    const { address, startBlock } = contracts[key];
    source = source.replace(manifestPattern(name), `$1${address}$3${startBlock}`);
  }
  writeFileSync(join(ROOT, FILES.manifest), source);
}

// ------------------------------------------------------------------ check and write

function disagreements(network, want) {
  const spec = NETWORKS[network];
  const problems = [];
  const compare = (where, key, got, expectedValue) => {
    if (typeof expectedValue === "number" ? got !== expectedValue : lower(got) !== lower(expectedValue)) {
      problems.push(`${where} ${key}: holds ${got}, deployments says ${expectedValue}`);
    }
  };

  const networks = JSON.parse(read(FILES.networks))[spec.graphNetwork];
  if (networks === undefined) throw new WireError(`${FILES.networks} has no "${spec.graphNetwork}" entry`);

  const client = readTsAddresses(FILES.client, spec.clientBlock);
  const web = readTsAddresses(FILES.web, spec.webBlock, [...Object.keys(CONTRACTS), ...WEB_ONLY, ...OPTIONAL_WEB]);
  const manifest = spec.manifest ? readManifest() : null;
  compare(FILES.web, "priceOracle", web.priceOracle, want.oracle);
  for (const key of OPTIONAL_WEB) compare(FILES.web, key, web[key], want.optional[key]);

  for (const [key, name] of Object.entries(CONTRACTS)) {
    const { address, startBlock } = want.contracts[key];
    compare(`${FILES.networks} ${spec.graphNetwork}.${name}`, "address", networks[name]?.address ?? "missing", address);
    compare(`${FILES.networks} ${spec.graphNetwork}.${name}`, "startBlock", networks[name]?.startBlock, startBlock);
    compare(FILES.client, key, client[key], address);
    compare(FILES.web, key, web[key], address);
    if (manifest !== null) {
      compare(`${FILES.manifest} ${name}`, "address", manifest[key].address, address);
      compare(`${FILES.manifest} ${name}`, "startBlock", manifest[key].startBlock, startBlock);
    }
  }
  return problems;
}

async function confirmCode(network, contracts) {
  const variable = network === "mainnet" ? "ARC_MAINNET_RPC_URL" : "ARC_TESTNET_RPC_URL";
  const rpc = process.env[variable];
  if (!rpc) {
    console.log(`  (${variable} unset — not confirming the addresses hold code)`);
    return;
  }
  for (const [key, { address }] of Object.entries(contracts)) {
    const response = await fetch(rpc, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getCode", params: [address, "latest"] }),
    });
    const { result } = await response.json();
    if (typeof result !== "string" || result === "0x") {
      throw new WireError(`${key} at ${address} has no code on ${variable}. Wrong network, or a bad cut`);
    }
  }
  console.log(`  every address holds code on ${variable}`);
}

async function wire(network) {
  const spec = NETWORKS[network];
  const want = expected(network, { write: true });
  if (want.deployed) await confirmCode(network, want.contracts);

  const networksFile = JSON.parse(read(FILES.networks));
  for (const [key, name] of Object.entries(CONTRACTS)) {
    networksFile[spec.graphNetwork][name] = { ...want.contracts[key] };
  }
  writeFileSync(join(ROOT, FILES.networks), `${JSON.stringify(networksFile, null, 2)}\n`);
  writeTsAddresses(FILES.client, spec.clientBlock, network, addressesOf(want.contracts), want.deployed);
  writeTsAddresses(
    FILES.web,
    spec.webBlock,
    network,
    { ...addressesOf(want.contracts), priceOracle: want.oracle, ...want.optional },
    want.deployed,
  );
  if (spec.manifest) writeManifest(want.contracts);

  const problems = disagreements(network, want);
  if (problems.length > 0) throw new WireError(`wrote, but readers still disagree:\n  ${problems.join("\n  ")}`);

  console.log(`\nArc ${network} wired: ${Object.values(FILES).join(", ")}`);
  if (want.deployed) {
    const { contracts } = want;
    console.log(`\nThe two environment readers are not files. Set them where each process runs:`);
    console.log(`  packages/mcp   HUNCH_VPM_SETTLER_ADDRESS=${contracts.vestedParimutuel.address}`);
    console.log(`  packages/mcp   HUNCH_VPM_CLASSIC_SETTLER_ADDRESS=${contracts.classicParimutuel.address}`);
    console.log(`  agent          HUNCH_SETTLER=${contracts.vestedParimutuel.address}`);
    const earliest = Math.min(...Object.values(contracts).map((contract) => contract.startBlock));
    console.log(`\nEarliest deploy block: ${earliest}. Then: git diff, and deploy the subgraph.`);
  }
}

function check(networks) {
  let failed = false;
  for (const network of networks) {
    const want = expected(network, { write: false });
    const problems = disagreements(network, want);
    const state = want.deployed ? "deployed" : "not deployed";
    if (problems.length === 0) {
      const source = want.deployed
        ? `agrees with ${relative(ROOT, join(ROOT, deploymentPath(network)))}`
        : `holds the zero address, as it must with no ${deploymentPath(network)}`;
      console.log(`  ✓ Arc ${network} (${state}): every reader ${source}`);
    } else {
      failed = true;
      console.log(`  ✗ Arc ${network} (${state}):\n    ${problems.join("\n    ")}`);
    }
  }
  if (failed) {
    console.log(`\nFix with: node scripts/wire-deployment.mjs <testnet|mainnet>`);
    process.exit(1);
  }
}

const args = process.argv.slice(2);
const checking = args.includes("--check");
const named = args.filter((arg) => arg !== "--check");
for (const name of named) {
  if (!Object.hasOwn(NETWORKS, name)) {
    console.error(`unknown network "${name}". Use: testnet | mainnet`);
    process.exit(2);
  }
}

try {
  if (checking) {
    check(named.length > 0 ? named : Object.keys(NETWORKS));
  } else {
    if (named.length !== 1) {
      console.error("usage: node scripts/wire-deployment.mjs <testnet|mainnet> [--check]");
      process.exit(2);
    }
    await wire(named[0]);
  }
} catch (error) {
  if (error instanceof WireError) {
    console.error(`\n✗ ${error.message}`);
    process.exit(1);
  }
  throw error;
}
