/**
 * The Circle Agent Stack, behind two interfaces.
 *
 * Custody is an `AgentWallet` and paid research is a `NanopaymentChannel`. Each has a
 * live implementation and a dry-run one. The dry-run pair needs no key and no network,
 * and it is the default, so `hunch-agent run` and the whole test suite work on a laptop
 * with nothing configured.
 */

import type { Hex } from "../domain/types.js";

export type ExecutionMode = "dry-run" | "live";

/** One call the agent wants made. Built from the client's calldata helpers. */
export interface AgentTx {
  /** Short name for logs: "approve", "enter", "claim". */
  readonly label: string;
  readonly to: Hex;
  readonly data: Hex;
  /** Native USDC sent with the call. Arc's gas token is the stake asset. */
  readonly value: bigint;
  /**
   * What this call moves out of the wallet through the token's `transferFrom`.
   * The live wallet ignores it — the chain is the ledger. The dry-run wallet uses it to
   * keep a believable balance without pretending to be an EVM.
   */
  readonly settlementDebit: bigint;
}

export interface TxResult {
  readonly hash: Hex;
  readonly status: "confirmed" | "failed";
  readonly mode: ExecutionMode;
  readonly explorerUrl: string | undefined;
}

export interface AgentWallet {
  readonly mode: ExecutionMode;
  /** One line for the startup banner. Never contains a key. */
  readonly description: string;
  address(): Promise<Hex>;
  /** Spendable USDC in base units. */
  balance(): Promise<bigint>;
  send(tx: AgentTx): Promise<TxResult>;
}

/**
 * One authorization for one paid call. It is not a transaction: it is a promise to pay
 * that the channel batches.
 */
export interface NanopaymentAuthorization {
  readonly id: string;
  readonly amountMicroUsdc: bigint;
  readonly memo: string;
  readonly at: number;
}

export interface NanopaymentSettlement {
  readonly settlementId: string;
  /** How many authorizations collapsed into this one on-chain payment. */
  readonly authorizations: number;
  readonly totalMicroUsdc: bigint;
  readonly txHash: Hex | undefined;
  readonly mode: ExecutionMode;
}

/**
 * Nanopayments exist because the research loop is the wrong shape for per-call on-chain
 * payment: one quote per market per round is a few hundredths of a cent of value and far
 * more than that in gas. Authorizations accumulate off-chain and settle once.
 */
export interface NanopaymentChannel {
  readonly mode: ExecutionMode;
  readonly description: string;
  authorize(amountMicroUsdc: bigint, memo: string): Promise<NanopaymentAuthorization>;
  pending(): readonly NanopaymentAuthorization[];
  totalAuthorizedMicroUsdc(): bigint;
  /** Collapse everything outstanding into a single payment. Idempotent when empty. */
  settle(): Promise<NanopaymentSettlement>;
}

export class CircleConfigError extends Error {}
export class CircleRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}
