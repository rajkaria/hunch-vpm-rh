import { describe, expect, it } from 'vitest';

import { callFor, decide, type SpecSnapshot } from '../src/keeper/decide.js';
import { formatReport, runKeeper, type SpecReader, type SpecWriter } from '../src/keeper/run.js';

const FROZEN = 1_000_000n;

function snapshot(over: Partial<SpecSnapshot> = {}): SpecSnapshot {
  return {
    known: true,
    settled: false,
    ready: true,
    winner: 0,
    age: 5n,
    resolutionTime: FROZEN,
    maxStaleness: 60n,
    hasReading: true,
    ...over,
  };
}

describe('decide', () => {
  it('skips a spec that was never registered', () => {
    expect(decide(snapshot({ known: false }), FROZEN).kind).toBe('unknown');
  });

  it('skips a spec that has already settled, resolved or voided', () => {
    expect(decide(snapshot({ settled: true }), FROZEN).kind).toBe('done');
  });

  it('waits while the market is still open', () => {
    const action = decide(snapshot(), FROZEN - 30n);
    expect(action.kind).toBe('too-early');
    if (action.kind === 'too-early') expect(action.secondsRemaining).toBe(30n);
  });

  it('resolves at the freeze itself, not a second after', () => {
    // `resolve` reverts on `block.timestamp < resolutionTime`, so the freeze
    // second is already resolvable and a keeper that waits one more is late.
    expect(decide(snapshot(), FROZEN).kind).toBe('resolve');
  });

  it('carries the winner preview reported, so a log says what it settled to', () => {
    const action = decide(snapshot({ winner: 1 }), FROZEN);
    expect(action.kind === 'resolve' && action.winner).toBe(1);
  });

  it('waits rather than voiding when the reading is stale', () => {
    // The safety property. `resolve` reverts rather than voids on a stale
    // reading so a keeper retrying through a brief outage cannot destroy a
    // market that had a good answer coming; a keeper that voids by default
    // hands that protection straight back.
    const action = decide(snapshot({ ready: false, age: 600n }), FROZEN);
    expect(action.kind).toBe('stale');
    expect(callFor(action)).toBeNull();
  });

  it('still does not void without authorisation, however old the reading', () => {
    const action = decide(snapshot({ ready: false, age: 10_000_000n }), FROZEN);
    expect(action.kind).toBe('stale');
  });

  it('voids only when authorised AND past the bound', () => {
    const action = decide(snapshot({ ready: false, age: 600n }), FROZEN, { allowVoid: true });
    expect(action.kind).toBe('void-stale');
    expect(callFor(action)).toBe('voidStale');
  });

  it('honours a grace period on top of the bound before voiding', () => {
    const snap = snapshot({ ready: false, age: 90n }); // bound 60, so 30s past
    expect(decide(snap, FROZEN, { allowVoid: true }).kind).toBe('void-stale');
    expect(decide(snap, FROZEN, { allowVoid: true, voidAfterExtraSeconds: 3600n }).kind).toBe('stale');
  });

  it('never voids before the freeze, even when authorised', () => {
    const action = decide(snapshot({ ready: false, age: 99_999n }), FROZEN - 1n, { allowVoid: true });
    expect(action.kind).toBe('too-early');
  });

  it('waits on a feed that has never been written, and does not count it a failure', () => {
    // The CRE relay before its first delivery: the oracle reverts, so preview does too.
    const action = decide(snapshot({ hasReading: false, ready: false, age: 0n }), FROZEN, { allowVoid: true });
    expect(action.kind).toBe('no-reading');
    expect(callFor(action)).toBeNull();
  });

  it('still reports too-early for an unwritten feed before the freeze', () => {
    expect(decide(snapshot({ hasReading: false, ready: false }), FROZEN - 10n).kind).toBe('too-early');
  });

  it('never voids a spec that is already settled', () => {
    const action = decide(snapshot({ settled: true, ready: false, age: 99_999n }), FROZEN, {
      allowVoid: true,
    });
    expect(action.kind).toBe('done');
  });
});

describe('callFor', () => {
  it('permits exactly two calls and nothing else', () => {
    expect(callFor({ kind: 'resolve', why: '', winner: 0 })).toBe('resolve');
    expect(callFor({ kind: 'void-stale', why: '', age: 1n, bound: 0n })).toBe('voidStale');
    expect(callFor({ kind: 'done', why: '' })).toBeNull();
    expect(callFor({ kind: 'unknown', why: '' })).toBeNull();
    expect(callFor({ kind: 'stale', why: '', age: 1n, bound: 0n })).toBeNull();
    expect(callFor({ kind: 'too-early', why: '', secondsRemaining: 1n })).toBeNull();
    expect(callFor({ kind: 'no-reading', why: '' })).toBeNull();
  });
});

describe('isRevert', () => {
  it('recognises a contract revert and nothing else', async () => {
    const { isRevert } = await import('../src/keeper/chain.js');
    const { ContractFunctionExecutionError, ContractFunctionRevertedError, HttpRequestError } = await import('viem');
    const abi = [{ type: 'function', name: 'preview', inputs: [], outputs: [], stateMutability: 'view' }] as const;

    const reverted = new ContractFunctionExecutionError(
      new ContractFunctionRevertedError({ abi, functionName: 'preview', data: '0x24c4fe43' }),
      { abi, functionName: 'preview' },
    );
    expect(isRevert(reverted)).toBe(true);
    expect(isRevert(new HttpRequestError({ url: 'https://rpc.example' }))).toBe(false);
    expect(isRevert(new Error('socket hang up'))).toBe(false);
  });
});

function reader(map: Record<string, SpecSnapshot | Error>): SpecReader {
  return {
    read: async (specId) => {
      const value = map[specId];
      if (value === undefined || value instanceof Error) throw value ?? new Error('missing');
      return value;
    },
  };
}

describe('runKeeper', () => {
  const ready = snapshot();

  it('sends nothing at all by default', async () => {
    // Dry run is the default so a misconfigured keeper is inert, not wrong.
    let sends = 0;
    const writer: SpecWriter = {
      send: async () => {
        sends += 1;
        return '0xhash';
      },
    };
    const report = await runKeeper(['0xaa'], reader({ '0xaa': ready }), writer, { now: FROZEN });

    expect(report.dryRun).toBe(true);
    expect(report.actionable).toBe(1);
    expect(report.sent).toBe(0);
    expect(sends).toBe(0);
  });

  it('sends once told to, and reports the hash', async () => {
    const writer: SpecWriter = { send: async () => '0xdeadbeef' };
    const report = await runKeeper(['0xaa'], reader({ '0xaa': ready }), writer, {
      now: FROZEN,
      dryRun: false,
    });
    expect(report.sent).toBe(1);
    expect(report.outcomes[0]?.hash).toBe('0xdeadbeef');
  });

  it('sends nothing without a writer, even out of dry run', async () => {
    const report = await runKeeper(['0xaa'], reader({ '0xaa': ready }), null, {
      now: FROZEN,
      dryRun: false,
    });
    expect(report.sent).toBe(0);
  });

  it('keeps going when one spec cannot be read', async () => {
    // A keeper that gives up on the first RPC hiccup silently stops settling.
    const report = await runKeeper(
      ['0xbad', '0xaa'],
      reader({ '0xbad': new Error('rpc down'), '0xaa': ready }),
      { send: async () => '0xhash' },
      { now: FROZEN, dryRun: false },
    );
    expect(report.checked).toBe(2);
    expect(report.failed).toBe(1);
    expect(report.sent).toBe(1);
  });

  it('records a revert against the spec without stopping the pass', async () => {
    const report = await runKeeper(
      ['0xaa', '0xbb'],
      reader({ '0xaa': ready, '0xbb': ready }),
      {
        send: async (specId) => {
          if (specId === '0xaa') throw new Error('NotStale()\nat somewhere');
          return '0xok';
        },
      },
      { now: FROZEN, dryRun: false },
    );
    expect(report.failed).toBe(1);
    expect(report.sent).toBe(1);
    expect(report.outcomes[0]?.error).toBe('NotStale()');
  });

  it('touches nothing that is not actionable', async () => {
    const report = await runKeeper(
      ['0xa', '0xb', '0xc'],
      reader({
        '0xa': snapshot({ settled: true }),
        '0xb': snapshot({ known: false }),
        '0xc': snapshot({ ready: false, age: 900n }),
      }),
      { send: async () => '0xhash' },
      { now: FROZEN, dryRun: false },
    );
    expect(report.actionable).toBe(0);
    expect(report.sent).toBe(0);
  });

  it('formats a report a human can read in a cron log', async () => {
    const report = await runKeeper(['0xaabbccddeeff'], reader({ '0xaabbccddeeff': ready }), null, {
      now: FROZEN,
    });
    const text = formatReport(report);
    expect(text).toContain('resolve');
    expect(text).toContain('would send (dry run)');
    expect(text).toContain('1 checked');
  });
});

// --------------------------------------------------------------- the CLI

import { runKeeperCli, type KeeperEnv } from '../src/keeper/cli.js';

function cli(argv: string[], env: KeeperEnv = {}) {
  const out: string[] = [];
  const err: string[] = [];
  return runKeeperCli(argv, {
    env,
    log: (line) => out.push(line),
    error: (line) => err.push(line),
  }).then((code) => ({ code, out: out.join('\n'), err: err.join('\n') }));
}

const SPEC = `0x${'ab'.repeat(32)}`;
const RESOLVER = `0x${'cd'.repeat(20)}`;
const KEY = `0x${'11'.repeat(32)}`;

describe('the keeper CLI', () => {
  it('explains itself and exits clean', async () => {
    const { code, out } = await cli(['--help']);
    expect(code).toBe(0);
    expect(out).toContain('hunch-keeper');
    // The default has to be discoverable from --help, not only from the source.
    expect(out).toContain('OFF by default');
  });

  it('names every missing variable at once rather than one per run', async () => {
    const { code, err } = await cli([]);
    expect(code).toBe(2);
    expect(err).toContain('ARC_RPC_URL');
    expect(err).toContain('FEED_RESOLVER');
    expect(err).toContain('KEEPER_SPEC_IDS');
  });

  it('rejects a resolver that is not an address', async () => {
    const { code, err } = await cli([], {
      ARC_RPC_URL: 'http://x',
      FEED_RESOLVER: 'nope',
      KEEPER_SPEC_IDS: SPEC,
    });
    expect(code).toBe(2);
    expect(err).toContain('not an address');
  });

  it('rejects a spec id that is not bytes32, before touching the network', async () => {
    const { code, err } = await cli([], {
      ARC_RPC_URL: 'http://x',
      FEED_RESOLVER: RESOLVER,
      KEEPER_SPEC_IDS: '0x1234',
    });
    expect(code).toBe(2);
    expect(err).toContain('not bytes32');
  });

  it('refuses to run live without a key rather than falling back to dry run', async () => {
    // Silently downgrading would leave an operator believing markets are being
    // settled when nothing is being sent.
    const { code, err } = await cli(['--live'], {
      ARC_RPC_URL: 'http://x',
      FEED_RESOLVER: RESOLVER,
      KEEPER_SPEC_IDS: SPEC,
    });
    expect(code).toBe(2);
    expect(err).toContain('KEEPER_PRIVATE_KEY');
  });

  it('rejects a malformed --void-after before doing anything', async () => {
    const { code, err } = await cli(['--void-after', 'soon'], {
      ARC_RPC_URL: 'http://x',
      FEED_RESOLVER: RESOLVER,
      KEEPER_SPEC_IDS: SPEC,
    });
    expect(code).toBe(2);
    expect(err).toContain('whole number');
  });

  it('never prints the private key, whatever happens', async () => {
    const { out, err } = await cli(['--live'], {
      ARC_RPC_URL: 'http://x',
      FEED_RESOLVER: RESOLVER,
      KEEPER_SPEC_IDS: SPEC,
      KEEPER_PRIVATE_KEY: KEY,
    });
    expect(`${out}${err}`).not.toContain(KEY);
    expect(`${out}${err}`).not.toContain('1111111111');
  });
});
