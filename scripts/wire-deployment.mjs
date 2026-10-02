#!/usr/bin/env node
// Wires deployments/robinhood-mainnet.json (the single source of addresses) into every
// reader that cannot read the file at runtime:
//
//   1. packages/client/src/deployment/embedded.ts  (the copy @hunch-rh/client ships)
//   2. README.md, between <!-- deployment:start --> and <!-- deployment:end -->, if present
//
// Usage (plain Node ESM, no dependencies; run through pnpm exec in this repo):
//   pnpm exec node scripts/wire-deployment.mjs            validate + write (same as --write)
//   pnpm exec node scripts/wire-deployment.mjs --write    validate + write
//   pnpm exec node scripts/wire-deployment.mjs --check    validate + fail on drift (CI)
//
// The validation rules mirror validateDeployment() in packages/client/src/deployment
// (which additionally checks EIP-55 checksums with viem).

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const JSON_PATH = join(ROOT, 'deployments', 'robinhood-mainnet.json');
const EMBED_PATH = join(ROOT, 'packages', 'client', 'src', 'deployment', 'embedded.ts');
const README_PATH = join(ROOT, 'README.md');
const START = '<!-- deployment:start -->';
const END = '<!-- deployment:end -->';

const CHAIN_ID = 4663;
const ZERO = '0x0000000000000000000000000000000000000000';
const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
const MULTICALL3 = '0xca11bde05977b3631167028862be2a173976ca11';
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HEX32 = /^0x[0-9a-fA-F]{64}$/;
const UINT = /^\d+$/;

const args = new Set(process.argv.slice(2));
const CHECK = args.has('--check');
for (const a of args) {
  if (!['--check', '--write'].includes(a)) {
    console.error(`unknown argument ${a}`);
    process.exit(2);
  }
}

const isObj = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const isInt = (v) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;

const TOP_LEVEL_KEYS = new Set([
  'network', 'chainId', 'status', 'deployedAt', 'gitCommit', 'startBlock', 'contracts',
  'safe', 'keeper', 'usdg', 'multicall3', 'explorer', 'params', 'feeds',
]);

export function validate(d) {
  const p = [];
  if (!isObj(d)) return ['not an object'];
  const addr = (v, path, allowZero = true) => {
    if (typeof v !== 'string' || !ADDRESS.test(v)) {
      p.push(`${path}: not an address`);
      return false;
    }
    if (!allowZero && v.toLowerCase() === ZERO) p.push(`${path}: zero address`);
    return true;
  };
  for (const k of Object.keys(d)) if (!TOP_LEVEL_KEYS.has(k)) p.push(`${k}: unknown key`);
  if (typeof d.network !== 'string' || d.network === '') p.push('network: missing');
  if (d.chainId !== CHAIN_ID) p.push(`chainId: expected ${CHAIN_ID}`);
  if (d.status !== 'deployed' && d.status !== 'not-deployed') p.push('status: must be "deployed" or "not-deployed"');
  const deployed = d.status === 'deployed';
  if (d.deployedAt !== null && typeof d.deployedAt !== 'string') p.push('deployedAt: string or null');
  if (d.gitCommit !== null && typeof d.gitCommit !== 'string') p.push('gitCommit: string or null');
  if (d.startBlock !== null && !isInt(d.startBlock)) p.push('startBlock: integer or null');
  if (deployed) {
    if (typeof d.deployedAt !== 'string') p.push('deployedAt: required when deployed');
    if (!isInt(d.startBlock)) p.push('startBlock: required when deployed');
  }
  if (!isObj(d.contracts)) p.push('contracts: missing');
  else {
    for (const name of ['HunchVPM', 'StockRoundResolver', 'HunchMarketFactory']) {
      const c = d.contracts[name];
      if (!isObj(c)) {
        p.push(`contracts.${name}: missing`);
        continue;
      }
      if (addr(c.address, `contracts.${name}.address`, !deployed) && !deployed && c.address.toLowerCase() !== ZERO) {
        p.push(`contracts.${name}.address: must be zero while not deployed`);
      }
      if (c.deployTx !== null && (typeof c.deployTx !== 'string' || !HEX32.test(c.deployTx))) {
        p.push(`contracts.${name}.deployTx: 32-byte hex or null`);
      }
      if (c.block !== null && !isInt(c.block)) p.push(`contracts.${name}.block: integer or null`);
      if (deployed && (c.deployTx === null || c.block === null)) p.push(`contracts.${name}: deployTx and block required when deployed`);
    }
  }
  addr(d.safe, 'safe', !deployed);
  addr(d.keeper, 'keeper', !deployed);
  if (addr(d.usdg, 'usdg') && d.usdg.toLowerCase() !== USDG) p.push('usdg: not the canonical USDG');
  if (addr(d.multicall3, 'multicall3') && d.multicall3.toLowerCase() !== MULTICALL3) p.push('multicall3: not the canonical Multicall3');
  if (typeof d.explorer !== 'string' || !/^https:\/\//.test(d.explorer)) p.push('explorer: https URL required');
  if (!isObj(d.params)) p.push('params: missing');
  else {
    const pr = d.params;
    if (!isInt(pr.kappa) || pr.kappa < 1) p.push('params.kappa: integer >= 1');
    if (!isInt(pr.feeBps) || pr.feeBps > 500) p.push('params.feeBps: integer 0..500');
    if (!isInt(pr.voidTimeoutSec)) p.push('params.voidTimeoutSec: integer');
    for (const k of ['seedPerLeg', 'minEntry', 'maxEntry']) {
      if (typeof pr[k] !== 'string' || !UINT.test(pr[k])) p.push(`params.${k}: decimal string of base units`);
    }
    if (UINT.test(pr.minEntry ?? '') && UINT.test(pr.maxEntry ?? '') && BigInt(pr.maxEntry) !== 0n && BigInt(pr.minEntry) > BigInt(pr.maxEntry)) {
      p.push('params: minEntry > maxEntry');
    }
    if (UINT.test(pr.seedPerLeg ?? '') && BigInt(pr.seedPerLeg) < 1000000n) p.push('params.seedPerLeg: at least 1 USDG (1000000)');
  }
  if (!Array.isArray(d.feeds)) p.push('feeds: array required');
  else {
    const tickers = new Set();
    const feeds = new Set();
    d.feeds.forEach((f, i) => {
      const at = `feeds[${i}]`;
      if (!isObj(f)) return p.push(`${at}: not an object`);
      if (typeof f.ticker !== 'string' || !/^[A-Z][A-Z0-9.]{0,9}$/.test(f.ticker)) p.push(`${at}.ticker: upper-case symbol`);
      else if (tickers.has(f.ticker)) p.push(`${at}.ticker: duplicate ${f.ticker}`);
      else tickers.add(f.ticker);
      if (addr(f.feed, `${at}.feed`, false)) {
        if (feeds.has(f.feed.toLowerCase())) p.push(`${at}.feed: duplicate`);
        feeds.add(f.feed.toLowerCase());
      }
      addr(f.aggregator, `${at}.aggregator`, false);
      addr(f.stockToken, `${at}.stockToken`, false);
      for (const k of ['maxStrikeAge', 'maxFinalAge']) {
        if (!isInt(f[k]) || f[k] === 0 || f[k] > 8 * 86400) p.push(`${at}.${k}: seconds in 1..691200`);
      }
      if (!Array.isArray(f.families) || f.families.some((x) => x !== 'daily' && x !== 'weekly')) {
        p.push(`${at}.families: subset of ["daily","weekly"]`);
      }
      if (f.pendingFlatRateCheck !== undefined && typeof f.pendingFlatRateCheck !== 'boolean') p.push(`${at}.pendingFlatRateCheck: boolean`);
      if (f.description !== undefined && typeof f.description !== 'string') p.push(`${at}.description: string`);
    });
  }
  return p;
}

export function renderEmbedded(d) {
  return [
    '// GENERATED by scripts/wire-deployment.mjs from deployments/robinhood-mainnet.json.',
    '// Do not edit by hand: edit the JSON, then run `pnpm exec node scripts/wire-deployment.mjs --write`.',
    "import type { Deployment } from './types.js';",
    '',
    `export const EMBEDDED_DEPLOYMENT: Deployment = ${JSON.stringify(d, null, 2)};`,
    '',
  ].join('\n');
}

const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;

export function renderReadmeTable(d) {
  const ex = d.explorer.replace(/\/$/, '');
  const link = (a) => `[\`${short(a)}\`](${ex}/address/${a})`;
  const deployed = d.status === 'deployed';
  const lines = [
    `Network: Robinhood Chain mainnet (chain ${d.chainId}). Status: **${deployed ? 'deployed' : 'not deployed yet'}**${
      deployed && d.deployedAt ? ` (${d.deployedAt})` : ''
    }. Source: \`deployments/robinhood-mainnet.json\`.`,
    '',
    '| What | Address |',
    '|---|---|',
  ];
  for (const name of ['HunchVPM', 'StockRoundResolver', 'HunchMarketFactory']) {
    const c = d.contracts[name];
    lines.push(`| ${name} | ${deployed ? link(c.address) : 'not deployed yet'} |`);
  }
  if (deployed) {
    lines.push(`| Safe (owner, guardian, treasury) | ${link(d.safe)} |`);
    lines.push(`| Keeper (opener, relayer) | ${link(d.keeper)} |`);
  }
  lines.push(`| USDG | ${link(d.usdg)} |`);
  for (const f of d.feeds) {
    const note = f.pendingFlatRateCheck ? ' (held back until its FLAT-rate check passes)' : '';
    lines.push(`| ${f.ticker} Chainlink feed · Stock Token${note} | ${link(f.feed)} · ${link(f.stockToken)} |`);
  }
  return lines.join('\n');
}

function spliceReadme(readme, table) {
  const s = readme.indexOf(START);
  const e = readme.indexOf(END);
  if (s === -1 || e === -1 || e < s) return null;
  return `${readme.slice(0, s + START.length)}\n${table}\n${readme.slice(e)}`;
}

function main() {
  const rel = (p) => relative(ROOT, p);
  let d;
  try {
    d = JSON.parse(readFileSync(JSON_PATH, 'utf8'));
  } catch (error) {
    console.error(`wire-deployment: cannot read ${rel(JSON_PATH)}: ${error.message}`);
    process.exit(1);
  }
  const problems = validate(d);
  if (problems.length > 0) {
    console.error(`wire-deployment: ${rel(JSON_PATH)} is invalid:\n  - ${problems.join('\n  - ')}`);
    process.exit(1);
  }
  console.log(`wire-deployment: ${rel(JSON_PATH)} valid (status ${d.status}, ${d.feeds.length} feeds)`);

  const drift = [];
  const embedded = renderEmbedded(d);
  const current = existsSync(EMBED_PATH) ? readFileSync(EMBED_PATH, 'utf8') : null;
  if (current !== embedded) {
    if (CHECK) drift.push(rel(EMBED_PATH));
    else {
      writeFileSync(EMBED_PATH, embedded);
      console.log(`wire-deployment: wrote ${rel(EMBED_PATH)}`);
    }
  }

  if (existsSync(README_PATH)) {
    const readme = readFileSync(README_PATH, 'utf8');
    const next = spliceReadme(readme, renderReadmeTable(d));
    if (next === null) console.log('wire-deployment: README.md has no deployment markers, skipping the address table');
    else if (next !== readme) {
      if (CHECK) drift.push('README.md (address table)');
      else {
        writeFileSync(README_PATH, next);
        console.log('wire-deployment: updated the README.md address table');
      }
    }
  }

  if (drift.length > 0) {
    console.error(`wire-deployment: out of date with deployments/robinhood-mainnet.json:\n  - ${drift.join('\n  - ')}\nrun: pnpm exec node scripts/wire-deployment.mjs --write`);
    process.exit(1);
  }
  if (CHECK) console.log('wire-deployment: every reader agrees with the deployment');
}

main();
