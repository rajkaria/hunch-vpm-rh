import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  DeploymentError,
  EMBEDDED_DEPLOYMENT,
  USDG_ADDRESS,
  ZERO_ADDRESS,
  deploymentParams,
  feedByAddress,
  feedByTicker,
  isDeployed,
  loadDeployment,
  makeRedactor,
  notDeployed,
  parseDeployment,
  redactRpcUrl,
  urlSecrets,
  validateDeployment,
} from '../src/index.js';

const committed = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../../deployments/robinhood-mainnet.json', import.meta.url)), 'utf8'),
) as unknown;

describe('deployments/robinhood-mainnet.json', () => {
  it('is valid (incl. EIP-55 checksums) and embedded verbatim', () => {
    expect(validateDeployment(committed)).toEqual([]);
    expect(EMBEDDED_DEPLOYMENT).toEqual(committed);
  });

  it('is the committed Robinhood Chain mainnet deployment: real USDG, v1 feeds, the launch configuration', () => {
    const d = loadDeployment({ env: {} });
    if (isDeployed(d)) {
      for (const c of Object.values(d.contracts)) expect(c.address).not.toBe(ZERO_ADDRESS);
      expect(d.safe).not.toBe(ZERO_ADDRESS);
      expect(d.keeper).toBe('0xEb420AD181518814B6E3feb89A9d369Da3F5b580');
      expect(d.startBlock).toBeGreaterThan(78_371_935); // after the superseded 2026-10-02 deploy (FACTS.md)
      expect(d.gitCommit).toMatch(/^[0-9a-f]{40}$/); // clean: no "-dirty"
    } else {
      expect(d.contracts.HunchVPM.address).toBe(ZERO_ADDRESS);
    }
    expect(Object.keys(committed as object).some((k) => k.includes('['))).toBe(false); // no stray "feeds[i]" keys
    expect(d.usdg).toBe(USDG_ADDRESS);
    expect(d.feeds.map((f) => f.ticker)).toEqual(['NVDA', 'TSLA', 'AAPL', 'COIN']);
    expect(feedByTicker(d, 'coin')?.pendingFlatRateCheck).toBe(false); // passed measure-feeds on 2026-09-28 (DECISIONS.md)
    expect(feedByTicker(d, 'NVDA')?.feed).toBe('0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15');
    expect(feedByAddress(d, '0x379ec4f7c378f34a1b47e4f3cbebcbac3e8e9f15')?.ticker).toBe('NVDA');
    expect(d.feeds.every((f) => f.maxStrikeAge === 93_600 && f.maxFinalAge === 93_600)).toBe(true);
    expect(deploymentParams(d)).toEqual({
      kappa: 30n,
      feeBps: 200,
      voidTimeoutSec: 259_200n,
      seedPerLeg: 1_000_000n, // launch tuning: the keeper float is 4 USDG (NVDA and TSLA dailies)
      minEntry: 1_000_000n,
      maxEntry: 25_000_000n,
    });
    expect(d.feeds.map((f) => [f.ticker, f.families])).toEqual([['NVDA', ['daily']], ['TSLA', ['daily']], ['AAPL', []], ['COIN', []]]);
  });
});

const deployedFixture = () => {
  const d = structuredClone(EMBEDDED_DEPLOYMENT) as unknown as Record<string, any>;
  d.status = 'deployed';
  d.deployedAt = '2026-09-29T10:00:00Z';
  d.gitCommit = 'abc1234';
  d.startBlock = 74_300_000;
  const addrs = ['0x00000000000000000000000000000000000000A1', '0x00000000000000000000000000000000000000a2', '0x00000000000000000000000000000000000000a3'];
  ['HunchVPM', 'StockRoundResolver', 'HunchMarketFactory'].forEach((k, i) => {
    d.contracts[k] = { address: addrs[i], deployTx: `0x${'1'.repeat(64)}`, block: 74_300_000 + i };
  });
  d.safe = '0x00000000000000000000000000000000000000b1';
  d.keeper = '0x00000000000000000000000000000000000000c1';
  return d;
};

describe('overrides and validation', () => {
  it('reads HUNCH_DEPLOYMENT_JSON, then NEXT_PUBLIC_HUNCH_DEPLOYMENT_JSON, then the embedded file', () => {
    const json = JSON.stringify(deployedFixture());
    expect(isDeployed(loadDeployment({ env: { HUNCH_DEPLOYMENT_JSON: json } }))).toBe(true);
    expect(isDeployed(loadDeployment({ env: { NEXT_PUBLIC_HUNCH_DEPLOYMENT_JSON: json } }))).toBe(true);
    expect(isDeployed(loadDeployment({ json, env: {} }))).toBe(true);
    const before = JSON.stringify(notDeployed(EMBEDDED_DEPLOYMENT));
    expect(isDeployed(loadDeployment({ env: { HUNCH_DEPLOYMENT_JSON: before, NEXT_PUBLIC_HUNCH_DEPLOYMENT_JSON: json } }))).toBe(false);
    expect(loadDeployment({ json: '', env: {} })).toEqual(loadDeployment({ env: {} }));
  });

  it('checksums addresses and rejects a broken override loudly', () => {
    const d = parseDeployment(JSON.stringify(deployedFixture()));
    expect(d.contracts.HunchVPM.address).toBe('0x00000000000000000000000000000000000000A1');
    expect(() => loadDeployment({ env: { HUNCH_DEPLOYMENT_JSON: '{' } })).toThrow(DeploymentError);
    const bad = deployedFixture();
    bad.contracts.HunchVPM.address = ZERO_ADDRESS;
    bad.usdg = '0x0000000000000000000000000000000000000001';
    bad.params.feeBps = 900;
    const problems = validateDeployment(bad);
    expect(problems).toContain('contracts.HunchVPM.address: zero address');
    expect(problems.some((p) => p.startsWith('usdg:'))).toBe(true);
    expect(problems.some((p) => p.startsWith('params.feeBps'))).toBe(true);
    expect(validateDeployment({ ...deployedFixture(), 'feeds[0]': { aggregator: ZERO_ADDRESS } })).toEqual(['feeds[0]: unknown key']);
    const notDeployedWithAddress = structuredClone(notDeployed(EMBEDDED_DEPLOYMENT)) as unknown as Record<string, any>;
    notDeployedWithAddress.contracts.HunchVPM.address = '0x00000000000000000000000000000000000000a1';
    expect(validateDeployment(notDeployedWithAddress)).toContain('contracts.HunchVPM.address: must be zero while not deployed');
  });
});

describe('redaction', () => {
  it('hides keyed RPC credentials', () => {
    const alchemy = 'https://robinhood-mainnet.g.alchemy.com/v2/AbCdEf1234567890XyZ';
    expect(redactRpcUrl(alchemy)).toBe('https://robinhood-mainnet.g.alchemy.com/v2/***');
    expect(redactRpcUrl('https://rpc.mainnet.chain.robinhood.com')).toBe('https://rpc.mainnet.chain.robinhood.com');
    expect(redactRpcUrl('https://x.robinhood-mainnet.quiknode.pro/0123456789abcdef0123/')).toBe('https://x.robinhood-mainnet.quiknode.pro/***');
    const scrub = makeRedactor([...urlSecrets(alchemy), '0xdeadbeefdeadbeefdeadbeef']);
    expect(scrub(`failed ${alchemy} with 0xdeadbeefdeadbeefdeadbeef`)).toBe('failed https://robinhood-mainnet.g.alchemy.com/v2/*** with ***');
  });
});
