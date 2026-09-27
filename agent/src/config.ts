/**
 * Chain facts and runtime configuration.
 *
 * Everything in `CHAINS` was read from a primary source; anything not published yet is
 * `undefined` here rather than guessed, and has to be supplied from the environment.
 */

import type { Hex } from "./domain/types.js";
import { parseUsdc, usdc } from "./domain/units.js";
import type { PolicyConfig } from "./policy/config.js";
import { DEFAULT_POLICY, policyFromEnv, withOverrides } from "./policy/config.js";
import { redactUrl } from "./redact.js";
import type { ExecutionMode } from "./circle/types.js";

export type ChainName = "arc-testnet" | "arc";

export interface ChainFacts {
  readonly name: ChainName;
  readonly chainId: number;
  /** Undefined where no endpoint is published yet; supply `HUNCH_RPC_URL`. */
  readonly rpcUrl: string | undefined;
  readonly explorerBase: string | undefined;
  /** The Graph network slug a subgraph deploys against. */
  readonly graphSlug: string;
  /** USDC is Arc's native gas token and reads as 6 decimals through the ERC-20 interface. */
  readonly usdc: Hex;
}

export const CHAINS: Readonly<Record<ChainName, ChainFacts>> = {
  "arc-testnet": {
    name: "arc-testnet",
    chainId: 5042002,
    rpcUrl: "https://rpc.testnet.arc.network",
    explorerBase: "https://testnet.arcscan.app",
    graphSlug: "arc-testnet",
    usdc: "0x3600000000000000000000000000000000000000",
  },
  arc: {
    name: "arc",
    chainId: 5042,
    // Not published in our verified notes; set HUNCH_RPC_URL / HUNCH_EXPLORER_BASE.
    rpcUrl: undefined,
    explorerBase: undefined,
    graphSlug: "arc",
    usdc: "0x3600000000000000000000000000000000000000",
  },
};

/** ERC-8004 registries, live on Arc testnet. The reputation registry is what trust reads. */
export const ERC8004_ARC_TESTNET = {
  identity: "0x8004A818BFB912233c491871b3d84c89A494BD9e",
  reputation: "0x8004B663056A597Dffe9eCcC1965A193B7388713",
  validation: "0x8004Cb1BF31DAf7788923b405b754f57acEB4272",
} as const satisfies Readonly<Record<string, Hex>>;

/** Stork's oracle on Arc testnet — the one provider with a published Arc address. */
export const STORK_ARC_TESTNET: Hex = "0xacC0a0cF13571d30B4b8637996F5D6D774d4fd62";

/**
 * PLACEHOLDER. Nothing is deployed yet, so the settler address is the zero address and
 * every live-mode command will refuse to run until `HUNCH_SETTLER` is set to a real one.
 */
export const PLACEHOLDER_ADDRESS: Hex = "0x0000000000000000000000000000000000000000";

export interface AgentConfig {
  readonly mode: ExecutionMode;
  readonly chain: ChainFacts;
  readonly rpcUrl: string | undefined;
  readonly explorerBase: string | undefined;
  /** Address of the deployed `VestedParimutuel`. Placeholder until a deployment exists. */
  readonly settler: Hex;
  /** Subgraph endpoint the client reads. Undefined in dry-run. */
  readonly subgraphUrl: string | undefined;
  readonly policy: PolicyConfig;
  /** Starting balance the dry-run wallet reports. Ignored in live mode. */
  readonly dryRunBankroll: bigint;
  /** Seed for dry-run addresses and hashes. Same seed, same transcript. */
  readonly dryRunSeed: string;
  /** What one intel call costs, in micro-USDC. */
  readonly intelPriceMicroUsdc: bigint;
  readonly circle: {
    readonly apiBase: string;
    readonly apiKey: string;
    readonly walletId: string;
    readonly entitySecretCiphertext: string;
    readonly feeLevel: "LOW" | "MEDIUM" | "HIGH";
  };
  readonly gateway: {
    readonly apiBase: string;
    readonly apiKey: string;
    readonly accountId: string;
    readonly authorizePath: string;
    readonly settlePath: string;
  };
  readonly intelUrl: string | undefined;
  /** How many research/monitor rounds one `run` performs. */
  readonly rounds: number;
  readonly roundIntervalMs: number;
  /**
   * Simulated seconds the dry-run clock jumps between rounds. Live mode never jumps.
   * The default makes a three-round demo cover 90 minutes, which is enough for the
   * shortest fixture market to freeze, resolve and be claimed.
   */
  readonly demoTickSeconds: number;
  /**
   * Markets to watch in live mode. The client's read surface is per-market, so the agent
   * is told which ids to look at rather than discovering them.
   */
  readonly marketIds: readonly string[];
  /**
   * Environment variables that were set to something unreadable and therefore ignored.
   * Keeping the default is the right behaviour — a typo should not stop the agent — but
   * an operator has to be able to tell a typo from a correct run, so `describeConfig`
   * prints these.
   */
  readonly ignoredEnv: readonly string[];
}

export type Env = Readonly<Record<string, string | undefined>>;

function str(env: Env, key: string, fallback: string): string {
  const raw = env[key];
  return raw === undefined || raw.trim() === "" ? fallback : raw.trim();
}

function optional(env: Env, key: string): string | undefined {
  const raw = env[key];
  return raw === undefined || raw.trim() === "" ? undefined : raw.trim();
}

/** Unreadable values keep the default and are reported through `ignored`, never dropped silently. */
function int(env: Env, key: string, fallback: number, ignored: string[]): number {
  const raw = optional(env, key);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    ignored.push(key);
    return fallback;
  }
  return Math.trunc(value);
}

function parseAmount(raw: string | undefined, fallback: bigint, key: string, ignored: string[]): bigint {
  if (raw === undefined) return fallback;
  try {
    return parseUsdc(raw);
  } catch {
    ignored.push(key);
    return fallback;
  }
}

export function loadConfig(env: Env): AgentConfig {
  const mode: ExecutionMode = str(env, "HUNCH_MODE", "dry-run") === "live" ? "live" : "dry-run";
  const chainName: ChainName = str(env, "HUNCH_CHAIN", "arc-testnet") === "arc" ? "arc" : "arc-testnet";
  const chain = CHAINS[chainName];
  const feeLevelRaw = str(env, "CIRCLE_FEE_LEVEL", "MEDIUM").toUpperCase();
  const feeLevel = feeLevelRaw === "LOW" || feeLevelRaw === "HIGH" ? feeLevelRaw : "MEDIUM";
  const policyEnv = policyFromEnv(env);
  const ignored: string[] = [...policyEnv.ignored];

  return {
    mode,
    chain,
    rpcUrl: optional(env, "HUNCH_RPC_URL") ?? chain.rpcUrl,
    explorerBase: optional(env, "HUNCH_EXPLORER_BASE") ?? chain.explorerBase,
    settler: (optional(env, "HUNCH_SETTLER") ?? PLACEHOLDER_ADDRESS) as Hex,
    subgraphUrl: optional(env, "HUNCH_SUBGRAPH_URL"),
    policy: withOverrides(DEFAULT_POLICY, policyEnv.overrides),
    dryRunBankroll: parseAmount(
      optional(env, "HUNCH_DRY_RUN_BANKROLL"),
      parseUsdc("1000"),
      "HUNCH_DRY_RUN_BANKROLL",
      ignored,
    ),
    dryRunSeed: str(env, "HUNCH_DRY_RUN_SEED", "hunch-vpm-demo-agent"),
    intelPriceMicroUsdc: BigInt(int(env, "HUNCH_INTEL_PRICE_MICRO_USDC", 250, ignored)),
    circle: {
      apiBase: str(env, "CIRCLE_API_BASE", "https://api.circle.com"),
      apiKey: str(env, "CIRCLE_API_KEY", ""),
      walletId: str(env, "CIRCLE_WALLET_ID", ""),
      entitySecretCiphertext: str(env, "CIRCLE_ENTITY_SECRET_CIPHERTEXT", ""),
      feeLevel,
    },
    gateway: {
      apiBase: str(env, "GATEWAY_API_BASE", "https://api.circle.com"),
      apiKey: str(env, "GATEWAY_API_KEY", ""),
      accountId: str(env, "GATEWAY_ACCOUNT_ID", ""),
      authorizePath: str(env, "GATEWAY_AUTHORIZE_PATH", "/v1/gateway/nanopayments/authorizations"),
      settlePath: str(env, "GATEWAY_SETTLE_PATH", "/v1/gateway/nanopayments/settlements"),
    },
    intelUrl: optional(env, "HUNCH_INTEL_URL"),
    rounds: Math.max(1, int(env, "HUNCH_ROUNDS", 3, ignored)),
    roundIntervalMs: Math.max(0, int(env, "HUNCH_ROUND_INTERVAL_MS", 0, ignored)),
    demoTickSeconds: Math.max(0, int(env, "HUNCH_DEMO_TICK_S", 2700, ignored)),
    marketIds: (optional(env, "HUNCH_MARKET_IDS") ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s !== ""),
    ignoredEnv: ignored,
  };
}

/**
 * A config summary safe to print. Secrets appear as "set"/"unset" and never as values —
 * this is the only function that is allowed to describe them at all.
 *
 * Endpoints count as secrets. `HUNCH_SUBGRAPH_URL` and `HUNCH_INTEL_URL` are printed
 * through `redactUrl`, which keeps the scheme, the host and the shape of the path and
 * replaces every identifying segment with `***`, because The Graph's gateway carries its
 * API key in the path: `https://gateway.thegraph.com/api/<API_KEY>/subgraphs/id/<ID>`.
 * A banner that echoed the variable would print that key to stdout on every run.
 *
 * It covers every policy knob as well as the plumbing, because a knob that silently kept
 * its default after a typo'd override is the failure this banner exists to prevent.
 */
export function describeConfig(config: AgentConfig): readonly string[] {
  const flag = (value: string): string => (value === "" ? "unset" : "set");
  const p = config.policy;
  const lines = [
    `mode            ${config.mode}`,
    `chain           ${config.chain.name} (chainId ${String(config.chain.chainId)})`,
    `settler         ${config.settler}${config.settler === PLACEHOLDER_ADDRESS ? "  [placeholder — nothing deployed yet]" : ""}`,
    `usdc            ${config.chain.usdc}  (native gas token, 6dp via ERC-20)`,
    `subgraph        ${config.subgraphUrl === undefined ? "none — dry-run fixtures" : redactUrl(config.subgraphUrl)}`,
    `intel           ${config.intelUrl === undefined ? "none — dry-run quotes" : redactUrl(config.intelUrl)}`,
    `circle api key  ${flag(config.circle.apiKey)}`,
    `circle wallet   ${config.circle.walletId === "" ? "unset" : config.circle.walletId}`,
    `entity secret   ${flag(config.circle.entitySecretCiphertext)} (ciphertext; the raw secret never reaches this process)`,
    `gateway api key ${flag(config.gateway.apiKey)}`,
    `minEdge         ${String(p.minEdge)}`,
    `edgeSaturation  ${String(p.edgeSaturation)}`,
    `freezeBuffer    ${String(p.freezeBufferSeconds)}s`,
    `minVestOutlook  ${String(p.minVestingOutlook)}`,
    `trustFloor      ${String(p.trustFloor)}`,
    `maxBankrollFrac ${String(p.maxBankrollFraction)}`,
    `headroomUtil    ${String(p.headroomUtilisation)}`,
    `maxTicket       ${usdc(p.maxTicket)}`,
    `minTicket       ${usdc(p.minTicket)}`,
    `dryRunBankroll  ${usdc(config.dryRunBankroll)}`,
    `rounds          ${String(config.rounds)}`,
    `demo tick       ${String(config.demoTickSeconds)}s`,
  ];
  if (config.ignoredEnv.length > 0) {
    lines.push(`IGNORED         ${config.ignoredEnv.join(", ")} — unreadable, default kept`);
  }
  return lines;
}
