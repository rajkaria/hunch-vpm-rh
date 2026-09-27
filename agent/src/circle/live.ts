/**
 * The live Circle implementations.
 *
 * Custody is a Circle developer-controlled wallet: the agent holds no private key at any
 * point. It holds an API key and a pre-encrypted entity-secret ciphertext, sends a
 * contract-execution request, and polls for the hash. The raw entity secret never enters
 * this process — `CIRCLE_ENTITY_SECRET_CIPHERTEXT` is supplied already encrypted with the
 * account's registered public key, so there is nothing here that could be logged by
 * accident.
 *
 * Paid research is a Gateway nanopayment channel: one authorization per intel call, one
 * settlement per loop. That surface is young, so every path is overridable from
 * configuration rather than hard-coded, and the dry-run channel is what CI runs.
 *
 * No test here reaches Circle — that would need credentials. What the tests do cover is
 * everything that can go wrong without a network: that the adapters refuse to construct
 * without credentials, and that the unit convention below survives a round trip in both
 * directions against a stubbed transport.
 */

import { randomUUID } from "node:crypto";
import type { Hex } from "../domain/types.js";
import { formatUsdc, parseUsdc } from "../domain/units.js";
import { HttpClient, pick } from "./http.js";
import type {
  AgentTx,
  AgentWallet,
  NanopaymentAuthorization,
  NanopaymentChannel,
  NanopaymentSettlement,
  TxResult,
} from "./types.js";
import { CircleConfigError, CircleRequestError } from "./types.js";

export interface CircleWalletConfig {
  readonly apiBase: string;
  readonly apiKey: string;
  readonly walletId: string;
  readonly entitySecretCiphertext: string;
  /** USDC on Arc: native gas token, ERC-20 interface at this address. */
  readonly usdcAddress: Hex;
  readonly explorerBase: string;
  readonly feeLevel: "LOW" | "MEDIUM" | "HIGH";
  readonly pollIntervalMs: number;
  readonly pollAttempts: number;
}

export interface LiveDeps {
  readonly fetchImpl: typeof fetch;
  readonly sleep: (ms: number) => Promise<void>;
}

export class CircleAgentWallet implements AgentWallet {
  readonly mode = "live" as const;
  readonly description: string;

  readonly #http: HttpClient;
  readonly #config: CircleWalletConfig;
  readonly #deps: LiveDeps;

  constructor(config: CircleWalletConfig, deps: LiveDeps) {
    if (config.apiKey === "") throw new CircleConfigError("CIRCLE_API_KEY is required in live mode");
    if (config.walletId === "") throw new CircleConfigError("CIRCLE_WALLET_ID is required in live mode");
    if (config.entitySecretCiphertext === "") {
      throw new CircleConfigError("CIRCLE_ENTITY_SECRET_CIPHERTEXT is required in live mode");
    }
    this.#config = config;
    this.#deps = deps;
    this.#http = new HttpClient({
      baseUrl: config.apiBase,
      headers: { authorization: `Bearer ${config.apiKey}` },
      timeoutMs: 20_000,
      maxAttempts: 3,
      fetchImpl: deps.fetchImpl,
      sleep: deps.sleep,
    });
    // The wallet id is an opaque handle, not a secret, and it is the only thing an
    // operator needs to tell one configured agent from another. The key is never here.
    this.description = `Circle Agent Wallet ${config.walletId}`;
  }

  async address(): Promise<Hex> {
    const body = await this.#http.get(`/v1/w3s/wallets/${this.#config.walletId}`);
    const address = pick(body, "data", "wallet", "address");
    if (typeof address !== "string") throw new CircleRequestError("wallet response had no address", 200);
    return address as Hex;
  }

  async balance(): Promise<bigint> {
    const body = await this.#http.get(`/v1/w3s/wallets/${this.#config.walletId}/balances`);
    const balances = pick(body, "data", "tokenBalances");
    if (!Array.isArray(balances)) return 0n;
    const wanted = this.#config.usdcAddress.toLowerCase();
    for (const entry of balances) {
      const tokenAddress = pick(entry, "token", "tokenAddress");
      const isNative = pick(entry, "token", "isNative") === true;
      const matches = typeof tokenAddress === "string" && tokenAddress.toLowerCase() === wanted;
      if (!matches && !isNative) continue;
      const amount = pick(entry, "amount");
      // See the note above `send`: Circle's amounts are human decimal strings both ways.
      if (typeof amount === "string") return parseUsdc(amount);
    }
    return 0n;
  }

  /**
   * The unit convention, stated once for the whole adapter: Circle's REST API talks in
   * human decimal strings of the token, not base units. `balance()` parses one on the way
   * in and `send()` formats one on the way out. `AgentTx.value` is base units like every
   * other amount in this package, so it is converted here rather than at the call site.
   *
   * Today the client's calldata always carries `value: 0n` — stake moves through the
   * ERC-20 interface even though USDC is Arc's gas token — so this branch is unexercised
   * in practice. That is exactly why it is unit-tested: the first call that does carry
   * native value should not be the one that discovers a 1e6 error.
   */
  async send(tx: AgentTx): Promise<TxResult> {
    const submitted = await this.#http.post("/v1/w3s/developer/transactions/contractExecution", {
      idempotencyKey: randomUUID(),
      entitySecretCiphertext: this.#config.entitySecretCiphertext,
      walletId: this.#config.walletId,
      contractAddress: tx.to,
      callData: tx.data,
      amount: tx.value === 0n ? undefined : formatUsdc(tx.value),
      feeLevel: this.#config.feeLevel,
    });
    const id = pick(submitted, "data", "id");
    if (typeof id !== "string") throw new CircleRequestError("contractExecution returned no id", 200);
    return this.#await(id);
  }

  /** Poll until the transaction has a hash or a terminal failure state. */
  async #await(id: string): Promise<TxResult> {
    for (let attempt = 0; attempt < this.#config.pollAttempts; attempt += 1) {
      const body = await this.#http.get(`/v1/w3s/transactions/${id}`);
      const state = pick(body, "data", "transaction", "state");
      const hash = pick(body, "data", "transaction", "txHash");
      if (state === "FAILED" || state === "CANCELLED" || state === "DENIED") {
        return { hash: "0x" as Hex, status: "failed", mode: this.mode, explorerUrl: undefined };
      }
      if (typeof hash === "string" && hash !== "" && (state === "CONFIRMED" || state === "COMPLETE")) {
        return {
          hash: hash as Hex,
          status: "confirmed",
          mode: this.mode,
          explorerUrl: `${this.#config.explorerBase}/tx/${hash}`,
        };
      }
      await this.#deps.sleep(this.#config.pollIntervalMs);
    }
    throw new CircleRequestError(`transaction ${id} did not confirm in time`, 504);
  }
}

export interface GatewayNanopaymentConfig {
  readonly apiBase: string;
  readonly apiKey: string;
  /** Which payer account the authorizations draw on. */
  readonly accountId: string;
  /** Overridable because this surface is young; defaults are in `config.ts`. */
  readonly authorizePath: string;
  readonly settlePath: string;
}

export class GatewayNanopayments implements NanopaymentChannel {
  readonly mode = "live" as const;
  readonly description: string;

  readonly #http: HttpClient;
  readonly #config: GatewayNanopaymentConfig;
  #pending: NanopaymentAuthorization[] = [];

  constructor(config: GatewayNanopaymentConfig, deps: LiveDeps) {
    if (config.apiKey === "") throw new CircleConfigError("GATEWAY_API_KEY is required in live mode");
    this.#config = config;
    this.#http = new HttpClient({
      baseUrl: config.apiBase,
      headers: { authorization: `Bearer ${config.apiKey}` },
      timeoutMs: 10_000,
      maxAttempts: 3,
      fetchImpl: deps.fetchImpl,
      sleep: deps.sleep,
    });
    this.description = `Gateway nanopayments, account ${config.accountId}`;
  }

  async authorize(amountMicroUsdc: bigint, memo: string): Promise<NanopaymentAuthorization> {
    const body = await this.#http.post(this.#config.authorizePath, {
      accountId: this.#config.accountId,
      amountMicroUsdc: amountMicroUsdc.toString(),
      memo,
    });
    const id = pick(body, "data", "id");
    const auth: NanopaymentAuthorization = {
      id: typeof id === "string" ? id : randomUUID(),
      amountMicroUsdc,
      memo,
      at: Math.floor(Date.now() / 1000),
    };
    this.#pending.push(auth);
    return auth;
  }

  pending(): readonly NanopaymentAuthorization[] {
    return this.#pending;
  }

  totalAuthorizedMicroUsdc(): bigint {
    let total = 0n;
    for (const a of this.#pending) total += a.amountMicroUsdc;
    return total;
  }

  async settle(): Promise<NanopaymentSettlement> {
    const authorizations = this.#pending.length;
    const totalMicroUsdc = this.totalAuthorizedMicroUsdc();
    if (authorizations === 0) {
      return {
        settlementId: "",
        authorizations: 0,
        totalMicroUsdc: 0n,
        txHash: undefined,
        mode: this.mode,
      };
    }
    const body = await this.#http.post(this.#config.settlePath, {
      accountId: this.#config.accountId,
      authorizationIds: this.#pending.map((a) => a.id),
    });
    // Clear only after the settlement call returns: a failed settle leaves the
    // authorizations outstanding so the next loop retries them rather than dropping them.
    this.#pending = [];
    const settlementId = pick(body, "data", "id");
    const txHash = pick(body, "data", "txHash");
    return {
      settlementId: typeof settlementId === "string" ? settlementId : "",
      authorizations,
      totalMicroUsdc,
      txHash: typeof txHash === "string" ? (txHash as Hex) : undefined,
      mode: this.mode,
    };
  }
}
