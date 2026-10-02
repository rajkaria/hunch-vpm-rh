import { getAddress, type Address, type Hex, type PublicClient } from 'viem';
import {
  DOWN,
  EMBEDDED_DEPLOYMENT,
  MARKET_STATUS,
  UP,
  parseDeployment,
  previewPayout,
  settlementOf,
  simCreate,
  simEnter,
  simFinalize,
  simResolve,
  simRoll,
  simVoid,
  headroom,
  type Deployment,
  type RoundData,
  type SimMarket,
} from '../../src/index.js';

/**
 * An in-memory Robinhood Chain for read tests: HunchVPM is backed by the exact
 * simulator in src/mechanics.ts, feeds by captured round series. It answers
 * `multicall`/`readContract`/`getBlock` with the shapes viem decodes to (tuples for
 * multi-output functions, objects for single struct outputs).
 */

export const VPM: Address = getAddress('0x00000000000000000000000000000000000000a1');
export const RESOLVER: Address = getAddress('0x00000000000000000000000000000000000000a2');
export const FACTORY: Address = getAddress('0x00000000000000000000000000000000000000a3');
export const SAFE: Address = getAddress('0x00000000000000000000000000000000000000b1');
export const KEEPER: Address = getAddress('0x00000000000000000000000000000000000000c1');

/**
 * The configuration the tests are written against: seed 10 USDG per leg, bets 1 to 100 USDG,
 * daily and weekly markets on every feed. The JSON holds the operator's current tuning, which
 * changes without touching the mechanics; the tests do not follow it.
 */
function withReferenceConfig(d: Record<string, any>): Record<string, any> {
  d.params = { ...d.params, seedPerLeg: '10000000', minEntry: '1000000', maxEntry: '100000000' };
  d.feeds = d.feeds.map((f: Record<string, unknown>) => ({ ...f, families: ['daily', 'weekly'] }));
  return d;
}

/** The committed deployment with the reference configuration, in its committed status. */
export function referenceDeployment(): Deployment {
  return parseDeployment(withReferenceConfig(structuredClone(EMBEDDED_DEPLOYMENT) as unknown as Record<string, any>));
}

export function deployedDeployment(): Deployment {
  const d = withReferenceConfig(structuredClone(EMBEDDED_DEPLOYMENT) as unknown as Record<string, any>);
  d.status = 'deployed';
  d.deployedAt = '2026-09-21T10:00:00Z';
  d.gitCommit = 'test';
  d.startBlock = 1;
  d.contracts = {
    HunchVPM: { address: VPM, deployTx: `0x${'1'.repeat(64)}`, block: 1 },
    StockRoundResolver: { address: RESOLVER, deployTx: `0x${'2'.repeat(64)}`, block: 1 },
    HunchMarketFactory: { address: FACTORY, deployTx: `0x${'3'.repeat(64)}`, block: 1 },
  };
  d.safe = SAFE;
  d.keeper = KEEPER;
  return parseDeployment(d);
}

interface FakeMarket {
  sim: SimMarket;
  ids: bigint[]; // global position ids, by sim position index
  feeBps: number;
  minEntry: bigint;
  maxEntry: bigint;
  specId: Hex;
  feed: Address;
  strikeTime: number;
  finalTime: number;
  maxStrikeAge: number;
  maxFinalAge: number;
  seedPerLeg: bigint;
  opener: Address;
  openedAt: number;
  settled: boolean;
}

export class FakeChain {
  now: number;
  l1 = 1000n;
  l2 = 5_000_000n;
  entriesPaused = false;
  feesAccrued = 0n;
  readonly markets: FakeMarket[] = [];
  readonly positionIndex: { market: number; local: number }[] = [];
  readonly feeds = new Map<string, { rounds: Map<bigint, RoundData>; latest: bigint; stockToken: Address; ticker: string; allowed: boolean }>();
  readonly previews = new Map<string, readonly [number, bigint, bigint, bigint, bigint]>();
  readonly usdgBalances = new Map<string, bigint>();
  readonly allowances = new Map<string, bigint>();
  readonly openers = new Set<string>([KEEPER.toLowerCase()]);
  /** Factory ownership (two-step, the Safe accepted) and the settler's D10 wiring. */
  factoryOwner: Address = SAFE;
  factoryPendingOwner: Address = '0x0000000000000000000000000000000000000000';
  settlerFactory: Address = FACTORY;
  pauser: Address = '0x0000000000000000000000000000000000000000';
  /** Runs before each `simulateContract` (a test can let "another run" act mid-job). */
  beforeSimulate: ((functionName: string, args: readonly unknown[]) => void) | null = null;
  /** Calls simulated through `simulateContract` (what a runner would send). */
  readonly simulated: { address: Address; functionName: string; args: readonly unknown[] }[] = [];
  calls = 0;

  constructor(readonly d: Deployment, now: number) {
    this.now = now;
  }

  /** Rounds after `now` are dropped: the chain cannot know them yet. */
  addFeed(feed: Address, ticker: string, stockToken: Address, all: RoundData[]): void {
    const rounds = all.filter((r) => r.updatedAt <= BigInt(this.now));
    this.feeds.set(feed.toLowerCase(), {
      rounds: new Map(rounds.map((r) => [r.roundId, r])),
      latest: rounds[rounds.length - 1]!.roundId,
      stockToken,
      ticker,
      allowed: true,
    });
  }

  open(p: { feed: Address; strikeTime: number; finalTime: number; maxFinalAge?: number; opener?: Address }): number {
    const sim = simCreate([10_000_000n, 10_000_000n], 30n, p.opener ?? KEEPER);
    const i = this.markets.length;
    const m: FakeMarket = {
      sim,
      ids: [],
      feeBps: 200,
      minEntry: 1_000_000n,
      maxEntry: 100_000_000n,
      specId: `0x${(i + 1).toString(16).padStart(64, '0')}` as Hex,
      feed: p.feed,
      strikeTime: p.strikeTime,
      finalTime: p.finalTime,
      maxStrikeAge: 93_600,
      maxFinalAge: p.maxFinalAge ?? 93_600,
      seedPerLeg: 10_000_000n,
      opener: p.opener ?? KEEPER,
      openedAt: this.now,
      settled: false,
    };
    this.markets.push(m);
    for (let local = 0; local < sim.positions.length; local++) this.track(i, local);
    return i;
  }

  private track(market: number, local: number): void {
    this.markets[market]!.sim.positions[local]!.marketId = BigInt(market);
    this.markets[market]!.ids[local] = BigInt(this.positionIndex.length);
    this.positionIndex.push({ market, local });
  }

  enter(i: number, e: { owner: Address; outcome: number; amount: bigint; block?: bigint }): bigint {
    const m = this.markets[i]!;
    const block = e.block ?? this.l1;
    const pos = simEnter(m.sim, { outcome: e.outcome, amount: e.amount, block, owner: e.owner });
    this.track(i, pos.id);
    return m.ids[pos.id]!;
  }

  finalize(i: number, block = this.l1): void {
    simRoll(this.markets[i]!.sim, block);
  }

  resolve(i: number, winner: number): void {
    simResolve(this.markets[i]!.sim, winner, this.l1 + 1n);
    this.markets[i]!.settled = true;
  }

  void(i: number): void {
    simVoid(this.markets[i]!.sim, this.l1 + 1n);
    this.markets[i]!.settled = true;
  }

  /** claim a position as `claimFor` would (fees accrue). */
  claim(globalId: bigint): void {
    const { market, local } = this.positionIndex[Number(globalId)]!;
    const m = this.markets[market]!;
    const p = m.sim.positions[local]!;
    const winnerBook = m.sim.status === MARKET_STATUS.Resolved ? m.sim.books[m.sim.winner]! : null;
    const s = settlementOf(p, m.sim, winnerBook, m.feeBps);
    this.feesAccrued += s.fee;
    if (m.sim.status === MARKET_STATUS.Resolved) m.sim.paidOut += s.gross;
    p.claimed = true;
    p.refunded = true;
  }

  // ------------------------------------------------------------------ dispatch

  private call(address: Address, fn: string, args: readonly unknown[]): unknown {
    this.calls++;
    const a = address.toLowerCase();
    const feed = this.feeds.get(a);
    if (feed !== undefined) {
      if (fn === 'latestRoundData') return tuple(feed.rounds.get(feed.latest)!);
      if (fn === 'getRoundData') {
        const r = feed.rounds.get(args[0] as bigint);
        if (r === undefined) throw new Error('execution reverted: No data present');
        return tuple(r);
      }
    }
    for (const f of this.feeds.values()) {
      if (f.stockToken.toLowerCase() === a && fn === 'oraclePaused') return false;
    }
    if (a === this.d.usdg.toLowerCase()) {
      if (fn === 'balanceOf') return this.usdgBalances.get((args[0] as string).toLowerCase()) ?? 0n;
      if (fn === 'allowance') return this.allowances.get(`${(args[0] as string).toLowerCase()}:${(args[1] as string).toLowerCase()}`) ?? 0n;
      if (fn === 'authorizationState') return false;
    }
    if (a === this.d.multicall3.toLowerCase()) {
      if (fn === 'getBlockNumber') return this.l1;
      if (fn === 'getCurrentBlockTimestamp') return BigInt(this.now);
    }
    if (a === FACTORY.toLowerCase()) return this.factory(fn, args);
    if (a === VPM.toLowerCase()) return this.vpm(fn, args);
    if (a === RESOLVER.toLowerCase()) return this.resolver(fn, args);
    if (a === SAFE.toLowerCase()) {
      if (fn === 'getThreshold') return 2n;
      if (fn === 'getOwners') return [KEEPER, SAFE];
    }
    throw new Error(`execution reverted: fake has no ${fn} at ${address}`);
  }

  private factory(fn: string, args: readonly unknown[]): unknown {
    switch (fn) {
      case 'listingCount':
        return BigInt(this.markets.length);
      case 'listings': {
        const m = this.markets[Number(args[0])];
        if (m === undefined) throw new Error('execution reverted');
        const id = BigInt(this.markets.indexOf(m));
        return [id, m.specId, m.feed, BigInt(m.strikeTime), BigInt(m.finalTime), m.maxStrikeAge, m.maxFinalAge, m.seedPerLeg, m.minEntry, m.maxEntry, m.opener, BigInt(m.openedAt)];
      }
      case 'listingIndexOf': {
        const i = Number(args[0]);
        return i < this.markets.length ? BigInt(i + 1) : 0n;
      }
      case 'feeds': {
        const f = this.feeds.get((args[0] as string).toLowerCase());
        return f === undefined ? ['0x0000000000000000000000000000000000000000', 0, 0, false, ''] : [f.stockToken, 93_600, 93_600, f.allowed, f.ticker];
      }
      case 'feedCount':
        return BigInt(this.feeds.size);
      case 'feedAt':
        return [...this.feeds.keys()][Number(args[0])];
      case 'openers':
        return this.openers.has((args[0] as string).toLowerCase());
      case 'owner':
        return this.factoryOwner;
      case 'pendingOwner':
        return this.factoryPendingOwner;
    }
    throw new Error(`execution reverted: factory.${fn}`);
  }

  private vpm(fn: string, args: readonly unknown[]): unknown {
    const market = () => {
      const m = this.markets[Number(args[0])];
      if (m === undefined) throw new Error('execution reverted: panic');
      return m;
    };
    const position = () => {
      const ix = this.positionIndex[Number(args[0])];
      if (ix === undefined) throw new Error('execution reverted: panic');
      return { m: this.markets[ix.market]!, p: this.markets[ix.market]!.sim.positions[ix.local]! };
    };
    switch (fn) {
      case 'entriesPaused':
        return this.entriesPaused;
      case 'factory':
        return this.settlerFactory;
      case 'pauser':
        return this.pauser;
      case 'feesAccrued':
        return this.feesAccrued;
      case 'marketCount':
        return BigInt(this.markets.length);
      case 'getMarket': {
        const m = market();
        return [this.d.usdg, FACTORY, RESOLVER, SAFE, BigInt(m.finalTime), 259_200n, 2, m.sim.status, m.sim.winner, 30n, m.sim.acceptedPool, m.sim.paidOut];
      }
      case 'getBook': {
        const b = market().sim.books[Number(args[1])]!;
        return { ...b };
      }
      case 'marketTerms': {
        const m = market();
        return [m.feeBps, m.minEntry, m.maxEntry];
      }
      case 'pendingCount':
        return BigInt(market().sim.pending.length);
      case 'headroom':
        return headroom(market().sim.books[Number(args[1])]!);
      case 'marketPositionCount':
        return BigInt(market().ids.length);
      case 'marketPositions': {
        const m = market();
        const from = Number(args[1]);
        const count = Number(args[2]);
        return m.ids.slice(from, from + count);
      }
      case 'positions': {
        const { p } = position();
        return [p.marketId, p.owner, p.outcome, p.finalized, p.refunded, p.claimed, p.vintage, p.offered, p.accepted, p.entryAcc];
      }
      case 'accrued': {
        const { m, p } = position();
        if (!p.finalized || p.accepted === 0n) return 0n;
        return (p.accepted * (10n ** 18n + m.sim.books[p.outcome]!.acc - p.entryAcc)) / 10n ** 18n;
      }
      case 'previewFee': {
        const { m, p } = position();
        if (p.claimed) return 0n;
        const gross = previewPayout(p, m.sim, m.sim.books[m.sim.winner]!);
        return gross > p.accepted ? ((gross - p.accepted) * BigInt(m.feeBps)) / 10_000n : 0n;
      }
    }
    throw new Error(`execution reverted: vpm.${fn}`);
  }

  private resolver(fn: string, args: readonly unknown[]): unknown {
    const m = this.markets.find((x) => x.specId === args[0]);
    switch (fn) {
      case 'settled':
        return m?.settled ?? false;
      case 'getSpec':
        if (m === undefined) throw new Error('execution reverted');
        return {
          settler: VPM,
          marketId: BigInt(this.markets.indexOf(m)),
          feed: m.feed,
          stockToken: this.feeds.get(m.feed.toLowerCase())!.stockToken,
          strikeTime: BigInt(m.strikeTime),
          finalTime: BigInt(m.finalTime),
          maxStrikeAge: m.maxStrikeAge,
          maxFinalAge: m.maxFinalAge,
        };
      case 'preview': {
        const key = `${args[0]}:${args[1]}:${args[2]}`;
        const p = this.previews.get(key);
        if (p !== undefined) return p;
        const feed = this.feeds.get(m!.feed.toLowerCase())!;
        const s = feed.rounds.get(args[1] as bigint)!;
        const f = feed.rounds.get(args[2] as bigint)!;
        const status = s.answer === f.answer ? 3 : f.answer > s.answer ? 1 : 2;
        return [status, s.answer, s.updatedAt, f.answer, f.updatedAt];
      }
    }
    throw new Error(`execution reverted: resolver.${fn}`);
  }

  client(): PublicClient {
    const self = this;
    const run = (c: { address: Address; functionName: string; args?: readonly unknown[] }) => self.call(c.address, c.functionName, c.args ?? []);
    return {
      async multicall({ contracts }: { contracts: { address: Address; functionName: string; args?: readonly unknown[] }[] }) {
        return contracts.map((c) => {
          try {
            return { status: 'success', result: run(c) };
          } catch (error) {
            return { status: 'failure', error };
          }
        });
      },
      async readContract(c: { address: Address; functionName: string; args?: readonly unknown[] }) {
        return run(c);
      },
      async getBlock() {
        return { number: self.l2, timestamp: BigInt(self.now) };
      },
      async getBlockNumber() {
        return self.l2;
      },
      async getBalance() {
        return 10n ** 16n;
      },
      async getCode() {
        return '0x';
      },
      async simulateContract(c: { address: Address; functionName: string; args?: readonly unknown[] }) {
        self.beforeSimulate?.(c.functionName, c.args ?? []);
        self.simulated.push({ address: c.address, functionName: c.functionName, args: c.args ?? [] });
        return { request: c, result: undefined };
      },
      async waitForTransactionReceipt({ hash }: { hash: Hex }) {
        return { status: 'success', transactionHash: hash };
      },
    } as unknown as PublicClient;
  }
}

function tuple(r: RoundData) {
  return [r.roundId, r.answer, r.startedAt, r.updatedAt, r.answeredInRound] as const;
}

export { UP, DOWN, simFinalize };
