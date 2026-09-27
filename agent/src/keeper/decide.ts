/**
 * What a keeper should do about one resolution spec.
 *
 * Pure: same inputs, same answer, no clock and no I/O of its own. Every branch
 * below is a state the chain can actually be in, and the reason this is a
 * separate module from the runner is that the dangerous branch — voiding — has
 * to be testable without a chain in front of it.
 */

export interface SpecSnapshot {
  /** `false` when `specs[specId].settler` is the zero address: never registered. */
  known: boolean;
  /** `settled[specId]`. Once true the spec is finished, resolved or voided. */
  settled: boolean;
  /** From `preview`: whether `resolve` would succeed this second. */
  ready: boolean;
  /** From `preview`: the outcome `resolve` would settle to. */
  winner: number;
  /** From `preview`: how old the reading is, in seconds. */
  age: bigint;
  /** From `specs`: the freeze. */
  resolutionTime: bigint;
  /** From `specs`: the staleness bound the market settles against. */
  maxStaleness: bigint;
  /**
   * `false` when the oracle has never written this feed, so `preview` reverts (a relay that
   * has not delivered its first price, say). That is a state of the chain, not a failure to
   * read it, and `ready`, `winner` and `age` mean nothing while it holds.
   */
  hasReading: boolean;
}

export type KeeperAction =
  | { kind: 'unknown'; why: string }
  | { kind: 'done'; why: string }
  | { kind: 'too-early'; why: string; secondsRemaining: bigint }
  | { kind: 'no-reading'; why: string }
  | { kind: 'stale'; why: string; age: bigint; bound: bigint }
  | { kind: 'resolve'; why: string; winner: number }
  | { kind: 'void-stale'; why: string; age: bigint; bound: bigint };

export interface DecideOptions {
  /**
   * Permission to void a market whose feed has gone quiet past its bound.
   *
   * **Off by default, and that default is the whole safety property.** `resolve`
   * reverts rather than voids on a stale reading precisely so that a keeper
   * retrying through a brief provider outage cannot destroy a market that had a
   * perfectly good answer coming. A keeper that voids on its own initiative
   * hands that protection straight back. Voiding is an operator's decision about
   * a feed that is not coming back, so it takes an explicit flag and refuses to
   * be a default.
   */
  allowVoid?: boolean;
  /**
   * How long past the bound the reading must be before a void is even
   * considered, on top of `allowVoid`. A second belt: `age > maxStaleness` is
   * true the instant a feed misses one publish, which is not evidence that it
   * is gone.
   */
  voidAfterExtraSeconds?: bigint;
}

export function decide(
  snapshot: SpecSnapshot,
  now: bigint,
  options: DecideOptions = {},
): KeeperAction {
  if (!snapshot.known) {
    return { kind: 'unknown', why: 'No spec is registered under that id.' };
  }

  if (snapshot.settled) {
    return { kind: 'done', why: 'Already resolved or voided. Nothing to do, ever again.' };
  }

  if (now < snapshot.resolutionTime) {
    return {
      kind: 'too-early',
      why: 'The market has not frozen yet.',
      secondsRemaining: snapshot.resolutionTime - now,
    };
  }

  // Frozen, but the feed has never been written. `voidStale` would revert exactly as
  // `preview` did, and a feed that has not started is no evidence that it never will, so
  // this waits whatever voiding was authorised. The settler's own voidTimeout is the
  // backstop if it truly never comes.
  if (!snapshot.hasReading) {
    return {
      kind: 'no-reading',
      why: 'Frozen, but the oracle has no reading for this feed yet. Waiting for the first one.',
    };
  }

  // Frozen and unsettled. `ready` folds the freeze and the staleness bound
  // together, so past the freeze it is exactly "the reading is fresh enough".
  if (snapshot.ready) {
    return {
      kind: 'resolve',
      why: 'Frozen, and the reading is inside its staleness bound.',
      winner: snapshot.winner,
    };
  }

  const bound = snapshot.maxStaleness;
  const extra = options.voidAfterExtraSeconds ?? 0n;

  if (options.allowVoid === true && snapshot.age > bound + extra) {
    return {
      kind: 'void-stale',
      why: 'The feed has been quiet past its bound for long enough, and voiding was authorised.',
      age: snapshot.age,
      bound,
    };
  }

  return {
    kind: 'stale',
    why:
      options.allowVoid === true
        ? 'The reading is stale but not yet stale enough to void. Waiting.'
        : 'The reading is stale. Waiting for the feed rather than voiding a market that may still settle.',
    age: snapshot.age,
    bound,
  };
}

/** The calls a keeper is ever allowed to send. Nothing else belongs in it. */
export function callFor(action: KeeperAction): 'resolve' | 'voidStale' | null {
  if (action.kind === 'resolve') return 'resolve';
  if (action.kind === 'void-stale') return 'voidStale';
  return null;
}
