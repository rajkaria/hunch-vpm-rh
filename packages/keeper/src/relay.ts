import {
  CHAIN_ID,
  MARKET_STATUS,
  ONE_USDG,
  buildEnterAuthorization,
  callMany,
  decodeMarket,
  decodeTerms,
  enterNonce,
  enterWithAuthorizationCall,
  hunchMarketFactoryAbi,
  hunchVpmAbi,
  isDeployed,
  isRestrictedCountry,
  must,
  recoverEnterSigner,
  usdgAbi,
  type Deployment,
  type Outcome,
} from '@hunch-rh/client';
import { BaseError, ContractFunctionRevertedError, getAddress, isAddress, isHex, type Address, type Hex, type PublicClient, type WalletClient } from 'viem';

/**
 * The gasless-entry relayer (docs/spec/06 `relay`). A bettor signs USDG's EIP-3009
 * `ReceiveWithAuthorization` (to = HunchVPM, nonce = enterNonce(market, side, amount,
 * salt)); the venue checks it off-chain, simulates `enterWithAuthorization` and sends it
 * from the relayer key (RELAYER_PRIVATE_KEY, else the keeper key). The relayer can change
 * nothing the bettor signed, and the bettor can always submit the same call themselves.
 *
 * Spending limits: every relayed call carries an explicit gas limit sized to the work the
 * entry really does (a base plus the pending batch it may finalize), so no signer can make the
 * relayer pay for arbitrary computation; signers that are contracts (ERC-1271, whose signature
 * check runs their own code) are refused and pay gas themselves.
 */

/** Venue-wide bounds, independent of each market's own caps. */
export const RELAY_MIN_AMOUNT = 1n * ONE_USDG;
export const RELAY_MAX_AMOUNT = 100n * ONE_USDG;
/** An authorization may be valid for at most this long (seconds). */
export const RELAY_MAX_VALIDITY_SEC = 3600;
/** It must still be valid this long after we receive it, so the tx lands in time. */
export const RELAY_MIN_REMAINING_SEC = 30;
/** Refuse entries this close to the freeze (the tx must land before the bell). */
export const RELAY_FREEZE_MARGIN_SEC = 15;
/**
 * Gas for one relayed entry: `enterWithAuthorization` measures ~260k-300k when it also
 * finalizes a one-entry batch (contracts/GAS.md, fork), and finalizing costs ~34k per pending
 * entry (at most 200, D9). The limit is the base plus a margin per pending entry.
 */
export const RELAY_GAS_BASE = 450_000n;
export const RELAY_GAS_PER_PENDING = 40_000n;

/** The gas limit for a relayed entry into a market with `pending` unfinalized entries. */
export function relayGasLimit(pending: bigint): bigint {
  const p = pending < 0n ? 0n : pending > 200n ? 200n : pending;
  return RELAY_GAS_BASE + RELAY_GAS_PER_PENDING * p;
}

export interface RelayRequest {
  from: string;
  marketId: string | number;
  outcome: number | string;
  amount: string | number;
  validAfter: string | number;
  validBefore: string | number;
  salt: string;
  signature: string;
  /** Optional: what the client thinks it signed against (checked if present). */
  chainId?: number | string;
  hunchVpm?: string;
}

export interface ParsedRelayRequest {
  from: Address;
  marketId: bigint;
  outcome: Outcome;
  amount: bigint;
  validAfter: bigint;
  validBefore: bigint;
  salt: Hex;
  signature: Hex;
}

export type RelayErrorCode =
  | 'not-deployed'
  | 'bad-request'
  | 'geo-blocked'
  | 'rate-limited'
  | 'wrong-domain'
  | 'amount-out-of-range'
  | 'not-yet-valid'
  | 'expired'
  | 'validity-too-long'
  | 'bad-signature'
  | 'contract-signer'
  | 'market-not-found'
  | 'market-closed'
  | 'entries-paused'
  | 'below-market-min'
  | 'above-market-max'
  | 'nonce-used'
  | 'insufficient-balance'
  | 'simulation-failed'
  | 'relayer-unavailable'
  | 'send-failed';

const HTTP: Record<RelayErrorCode, number> = {
  'not-deployed': 503,
  'bad-request': 400,
  'geo-blocked': 451,
  'rate-limited': 429,
  'wrong-domain': 400,
  'amount-out-of-range': 400,
  'not-yet-valid': 400,
  expired: 400,
  'validity-too-long': 400,
  'bad-signature': 400,
  'contract-signer': 400,
  'market-not-found': 404,
  'market-closed': 409,
  'entries-paused': 503,
  'below-market-min': 400,
  'above-market-max': 400,
  'nonce-used': 409,
  'insufficient-balance': 400,
  'simulation-failed': 422,
  'relayer-unavailable': 503,
  'send-failed': 502,
};

export type RelayFailure = { ok: false; code: RelayErrorCode; status: number; message: string };
export type RelayValidated = { ok: true; request: ParsedRelayRequest; nonce: Hex; gasLimit: bigint };
/**
 * `txHash: null`: the send failed, but the bettor's authorization is used on chain, so the
 * entry already landed (an earlier attempt of the same signed bet); the hash is not known here.
 */
export type RelayResult = { ok: true; txHash: Hex | null; nonce: Hex } | RelayFailure;

function fail(code: RelayErrorCode, message: string): RelayFailure {
  return { ok: false, code, status: HTTP[code], message };
}

// ------------------------------------------------------------------ rate limiting

/**
 * Sliding-window limiter, 10 per minute per key by default. In memory: per serverless
 * instance, best effort (a cold start or a second instance has its own window). The
 * chain-level guards (signature, nonce, balance, caps) are what actually protect funds.
 */
export class RateLimiter {
  private readonly hits = new Map<string, number[]>();
  constructor(
    readonly limit = 10,
    readonly windowMs = 60_000,
  ) {}

  /** Records a hit; false when `key` is over the limit (the hit is not recorded then). */
  take(key: string, nowMs: number = Date.now()): boolean {
    const since = nowMs - this.windowMs;
    const list = (this.hits.get(key) ?? []).filter((t) => t > since);
    if (list.length >= this.limit) {
      this.hits.set(key, list);
      return false;
    }
    list.push(nowMs);
    this.hits.set(key, list);
    if (this.hits.size > 10_000) this.prune(since);
    return true;
  }

  /** Gives back the latest hit of `key` (a retry the venue asked for should not count). */
  release(key: string): void {
    const list = this.hits.get(key);
    if (list !== undefined && list.length > 0) list.pop();
  }

  private prune(since: number): void {
    for (const [k, v] of this.hits) if (v.every((t) => t <= since)) this.hits.delete(k);
  }
}

/** A process-wide limiter for route handlers (import it; do not create one per request). */
export const defaultRelayLimiter = new RateLimiter(10, 60_000);

// ------------------------------------------------------------------ chain reads

export interface RelayMarket {
  statusCode: number;
  resolutionTime: number;
  minEntry: bigint;
  maxEntry: bigint;
  /** Entries in the market's open batch, which this entry may finalize (sizes the gas limit). */
  pending?: bigint;
}

export interface RelayChain {
  /** null when the market does not exist or was not listed by the Hunch factory. */
  market(marketId: bigint): Promise<RelayMarket | null>;
  entriesPaused(): Promise<boolean>;
  authorizationUsed(from: Address, nonce: Hex): Promise<boolean>;
  usdgBalance(owner: Address): Promise<bigint>;
  /** Smart wallets sign through ERC-1271; ECDSA recovery cannot verify them. */
  isContract(owner: Address): Promise<boolean>;
  /** eth_call of the entry under `gas` (an entry needing more fails here, before any send). */
  simulate(r: ParsedRelayRequest, gas?: bigint): Promise<{ ok: true } | { ok: false; reason: string }>;
}

export interface RelaySender {
  /** Sends with exactly this gas limit, so the relayer never pays for more. */
  send(r: ParsedRelayRequest, gas: bigint): Promise<Hex>;
}

export function chainRelayReads(client: PublicClient, d: Deployment, relayer?: Address): RelayChain {
  const vpm = d.contracts.HunchVPM.address;
  return {
    async market(marketId) {
      // Only markets the Hunch factory listed: HunchVPM is permissionless, and the relayer
      // must not spend the keeper's gas on (or lend the venue's name to) anyone else's market.
      const [index] = await callMany(client, [
        { address: d.contracts.HunchMarketFactory.address, abi: hunchMarketFactoryAbi, functionName: 'listingIndexOf', args: [marketId] },
      ]);
      if (must<bigint>(index, 'listingIndexOf') === 0n) return null;
      const r = await callMany(client, [
        { address: vpm, abi: hunchVpmAbi, functionName: 'getMarket', args: [marketId] },
        { address: vpm, abi: hunchVpmAbi, functionName: 'marketTerms', args: [marketId] },
        { address: vpm, abi: hunchVpmAbi, functionName: 'pendingCount', args: [marketId] },
      ]);
      const m = decodeMarket(must(r[0], 'getMarket'));
      const t = decodeTerms(must(r[1], 'marketTerms'));
      const pending = must<bigint>(r[2], 'pendingCount');
      return { statusCode: m.status, resolutionTime: m.resolutionTime, minEntry: t.minEntry, maxEntry: t.maxEntry, pending };
    },
    async entriesPaused() {
      return must<boolean>((await callMany(client, [{ address: vpm, abi: hunchVpmAbi, functionName: 'entriesPaused' }]))[0], 'entriesPaused');
    },
    async authorizationUsed(from, nonce) {
      return must<boolean>(
        (await callMany(client, [{ address: d.usdg, abi: usdgAbi, functionName: 'authorizationState', args: [from, nonce] }]))[0],
        'authorizationState',
      );
    },
    async usdgBalance(owner) {
      return must<bigint>((await callMany(client, [{ address: d.usdg, abi: usdgAbi, functionName: 'balanceOf', args: [owner] }]))[0], 'balanceOf');
    },
    async isContract(owner) {
      const code = await client.getCode({ address: owner });
      return code !== undefined && code !== '0x';
    },
    async simulate(r, gas) {
      try {
        await client.simulateContract({ ...enterWithAuthorizationCall(d, r), account: relayer ?? r.from, ...(gas === undefined ? {} : { gas }) } as never);
        return { ok: true };
      } catch (error) {
        return { ok: false, reason: shortError(error) };
      }
    },
  };
}

/** One line for logs and API errors; names the custom error when a contract reverted. */
/** Plain words for the reverts a bettor can hit (HunchVPM and USDG custom errors). */
const REVERT_WORDS: Record<string, string> = {
  VintageFull: 'Many bets landed in the last few seconds. Try again in a moment.',
  Frozen: 'This market is no longer taking bets.',
  NotOpen: 'This market is no longer taking bets.',
  EntriesArePaused: 'New bets are paused right now. Claims and payouts are not affected.',
  EntryTooSmall: 'This bet is below the market minimum.',
  EntryTooLarge: 'This bet is above the market maximum.',
  InvalidSignature: 'The signature does not match this wallet, market, side and amount.',
  AddressFrozen: 'USDG has frozen this wallet, so it cannot bet.',
  AuthorizationExpired: 'This authorization has expired. Sign again.',
  AuthorizationNotYetValid: 'This authorization is not valid yet. Check your device clock and sign again.',
  AuthorizationAlreadyUsed: 'This authorization was already used. Sign a new bet.',
  AuthorizationUsed: 'This signed bet was already used or cancelled. Sign a new bet.',
  NotPaid: 'USDG did not move for this bet, so it was not placed. Check your balance and sign again.',
  InsufficientBalance: 'Not enough USDG in this wallet on Robinhood Chain.',
};

/** A bettor-facing sentence for a simulation failure (falls back to the raw reason). */
export function revertInWords(reason: string): string {
  const name = /reverted: (\w+)/.exec(reason)?.[1];
  return (name !== undefined ? REVERT_WORDS[name] : undefined) ?? `The bet would fail on chain: ${reason}`;
}

export function shortError(error: unknown): string {
  if (error instanceof BaseError) {
    const revert = error.walk((e) => e instanceof ContractFunctionRevertedError);
    if (revert instanceof ContractFunctionRevertedError) {
      const name = revert.data?.errorName ?? revert.reason ?? revert.signature;
      if (name !== undefined) return `reverted: ${name}`;
    }
  }
  const e = error as { shortMessage?: string; message?: string };
  return (e?.shortMessage ?? e?.message ?? String(error)).split('\n')[0]!.slice(0, 300);
}

// ------------------------------------------------------------------ validation

const UINT = /^\d+$/;

function toUint(v: unknown): bigint | null {
  if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) return BigInt(v);
  if (typeof v === 'string' && UINT.test(v.trim()) && v.trim().length <= 78) return BigInt(v.trim());
  return null;
}

/** Shape-check a JSON body. Numbers may arrive as decimal strings (bigint is not JSON). */
export function parseRelayRequest(body: unknown): { ok: true; request: ParsedRelayRequest } | RelayFailure {
  if (typeof body !== 'object' || body === null) return fail('bad-request', 'Send a JSON object.');
  const b = body as Partial<RelayRequest>;
  if (typeof b.from !== 'string' || !isAddress(b.from, { strict: false })) return fail('bad-request', '`from` must be an address.');
  const marketId = toUint(b.marketId);
  const outcomeN = toUint(b.outcome);
  const amount = toUint(b.amount);
  const validAfter = toUint(b.validAfter);
  const validBefore = toUint(b.validBefore);
  if (marketId === null) return fail('bad-request', '`marketId` must be a whole number.');
  if (outcomeN === null || (outcomeN !== 0n && outcomeN !== 1n)) return fail('bad-request', '`outcome` must be 0 (UP) or 1 (DOWN).');
  if (amount === null) return fail('bad-request', '`amount` must be a whole number of USDG base units.');
  if (validAfter === null || validBefore === null) return fail('bad-request', '`validAfter` and `validBefore` must be unix seconds.');
  if (typeof b.salt !== 'string' || !isHex(b.salt) || b.salt.length !== 66) return fail('bad-request', '`salt` must be 32 bytes of hex.');
  if (typeof b.signature !== 'string' || !isHex(b.signature) || b.signature.length < 130) return fail('bad-request', '`signature` must be hex.');
  return {
    ok: true,
    request: {
      from: getAddress(b.from),
      marketId,
      outcome: Number(outcomeN) as Outcome,
      amount,
      validAfter,
      validBefore,
      salt: b.salt as Hex,
      signature: b.signature as Hex,
    },
  };
}

export interface RelayContext {
  deployment: Deployment;
  chain: RelayChain;
  nowSec: number;
  /** ISO country from the edge (e.g. `x-vercel-ip-country`); null when unknown. */
  country?: string | null;
  /** Client IP for rate limiting; null when unknown. */
  ip?: string | null;
  limiter?: RateLimiter;
}

/**
 * Everything short of sending: shape, domain, geo, rate limit, amount, validity window,
 * signature, market state and caps, pause, nonce, balance, simulation.
 */
export async function validateRelayRequest(body: unknown, ctx: RelayContext): Promise<RelayValidated | RelayFailure> {
  const d = ctx.deployment;
  if (!isDeployed(d)) return fail('not-deployed', 'Hunch is not deployed on Robinhood Chain yet.');
  const parsed = parseRelayRequest(body);
  if (!parsed.ok) return parsed;
  const r = parsed.request;
  const b = body as Partial<RelayRequest>;

  if (isRestrictedCountry(ctx.country)) {
    return fail('geo-blocked', 'Stock-price markets are not offered in the United States, Canada, the United Kingdom or Switzerland.');
  }
  const limiter = ctx.limiter ?? defaultRelayLimiter;
  const nowMs = ctx.nowSec * 1000;
  if (ctx.ip !== undefined && ctx.ip !== null && ctx.ip !== '' && !limiter.take(`ip:${ctx.ip}`, nowMs)) {
    return fail('rate-limited', 'Too many bets from this connection. Wait a minute and try again.');
  }

  if (b.chainId !== undefined && String(b.chainId) !== String(CHAIN_ID)) {
    return fail('wrong-domain', `Sign on Robinhood Chain (chain ${CHAIN_ID}).`);
  }
  if (b.hunchVpm !== undefined && (typeof b.hunchVpm !== 'string' || b.hunchVpm.toLowerCase() !== d.contracts.HunchVPM.address.toLowerCase())) {
    return fail('wrong-domain', 'This authorization was signed for a different Hunch contract.');
  }

  if (r.amount < RELAY_MIN_AMOUNT || r.amount > RELAY_MAX_AMOUNT) return fail('amount-out-of-range', 'Bets are 1 to 100 USDG.');

  const now = BigInt(ctx.nowSec);
  if (r.validAfter >= now) return fail('not-yet-valid', 'This authorization is not valid yet. Check your device clock and sign again.');
  if (r.validBefore <= now + BigInt(RELAY_MIN_REMAINING_SEC)) return fail('expired', 'This authorization has expired. Sign again.');
  if (r.validBefore > now + BigInt(RELAY_MAX_VALIDITY_SEC)) return fail('validity-too-long', 'Authorizations may be valid for at most one hour. Sign again.');

  const nonce = enterNonce({ hunchVpm: d.contracts.HunchVPM.address, marketId: r.marketId, outcome: r.outcome, amount: r.amount, salt: r.salt });
  const auth = buildEnterAuthorization({ ...r, hunchVpm: d.contracts.HunchVPM.address });
  let recovered: Address | null = null;
  try {
    recovered = await recoverEnterSigner(auth, r.signature);
  } catch {
    recovered = null;
  }
  if (recovered === null || recovered.toLowerCase() !== r.from.toLowerCase()) {
    // A smart wallet (ERC-1271) cannot be verified by recovery, and its signature check runs its
    // own code at the relayer's expense: it pays gas itself instead.
    if (await ctx.chain.isContract(r.from)) {
      return fail('contract-signer', 'This wallet signs as a smart contract, which gasless bets do not support. Use "Pay gas yourself".');
    }
    return fail('bad-signature', 'The signature does not match this wallet, market, side and amount.');
  }
  // Per wallet only once the wallet itself signed, so nobody can use up someone else's budget.
  const fromKey = `from:${r.from.toLowerCase()}`;
  if (!limiter.take(fromKey, nowMs)) {
    return fail('rate-limited', 'Too many bets from this wallet. Wait a minute and try again.');
  }

  const market = await ctx.chain.market(r.marketId);
  if (market === null) return fail('market-not-found', 'No such market.');
  if (market.statusCode !== MARKET_STATUS.Open || ctx.nowSec + RELAY_FREEZE_MARGIN_SEC >= market.resolutionTime) {
    return fail('market-closed', 'This market is no longer taking bets.');
  }
  if (await ctx.chain.entriesPaused()) return fail('entries-paused', 'New bets are paused right now. Claims and payouts are not affected.');
  if (market.minEntry !== 0n && r.amount < market.minEntry) return fail('below-market-min', 'This bet is below the market minimum.');
  if (market.maxEntry !== 0n && r.amount > market.maxEntry) return fail('above-market-max', 'This bet is above the market maximum.');
  if (await ctx.chain.authorizationUsed(r.from, nonce)) return fail('nonce-used', 'This authorization was already used. Sign a new bet.');
  if ((await ctx.chain.usdgBalance(r.from)) < r.amount) return fail('insufficient-balance', 'Not enough USDG in this wallet on Robinhood Chain.');
  const gasLimit = relayGasLimit(market.pending ?? 0n);
  const sim = await ctx.chain.simulate(r, gasLimit);
  if (!sim.ok) {
    // A full batch is the venue asking for a retry in a few seconds: it does not count.
    if (/reverted: VintageFull/.test(sim.reason)) limiter.release(fromKey);
    return fail('simulation-failed', revertInWords(sim.reason));
  }
  return { ok: true, request: r, nonce, gasLimit };
}

/** Validate, then send `enterWithAuthorization` from the relayer. Returns the tx hash. */
export async function relayEnter(body: unknown, ctx: RelayContext & { sender: RelaySender | null }): Promise<RelayResult> {
  const v = await validateRelayRequest(body, ctx);
  if (!v.ok) return v;
  if (ctx.sender === null) return fail('relayer-unavailable', 'Gasless bets are unavailable right now. Use "Pay gas yourself".');
  try {
    const txHash = await ctx.sender.send(v.request, v.gasLimit);
    return { ok: true, txHash, nonce: v.nonce };
  } catch (error) {
    // A retried or timed-out send may still have reached the chain: if the bettor's authorization
    // is now used, the bet is in, and telling them to "pay gas yourself" would bet twice.
    const landed = await ctx.chain.authorizationUsed(v.request.from, v.nonce).catch(() => false);
    if (landed) return { ok: true, txHash: null, nonce: v.nonce };
    return fail('send-failed', `Could not send the bet: ${shortError(error)}`);
  }
}

/**
 * A `RelaySender` over the relayer's wallet: simulate, then send with the given gas limit
 * (never an open-ended estimate); returns the tx hash without waiting for the receipt (the
 * client polls the market, and the vintage is finalized by the next entry or the deliver job).
 */
export function walletRelaySender(wallet: WalletClient, client: PublicClient, d: Deployment): RelaySender {
  return {
    async send(r, gas) {
      const { request } = await client.simulateContract({ ...enterWithAuthorizationCall(d, r), account: wallet.account, gas } as never);
      return (await wallet.writeContract({ ...(request as object), gas } as never)) as Hex;
    },
  };
}
