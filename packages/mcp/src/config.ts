/**
 * Configuration is environment-only: an MCP server is launched by a host (Claude
 * Desktop, Cursor, an agent runtime) that can set env vars and cannot pass flags,
 * so every knob has to live there. Every variable is documented in README.md and
 * mirrored in .env.example.
 *
 * Nothing here reaches the network. Invalid configuration is collected and reported
 * in one throw, because a host that shows the first of five problems makes the user
 * restart five times.
 */

import { isAddress, normalizeAddress, ZERO_ADDRESS } from "./format.js";

export interface ChainPreset {
  readonly chainId: number;
  readonly name: string;
  readonly rpcUrl: string | undefined;
  readonly explorerUrl: string | undefined;
  /** The Graph's network slug for this chain, useful when composing a Studio query URL. */
  readonly graphNetwork: string | undefined;
  readonly erc8004: {
    readonly identityRegistry: string;
    readonly reputationRegistry: string;
    readonly validationRegistry: string;
  } | undefined;
}

/**
 * Only what is verified. Arc mainnet's RPC and explorer are deliberately absent rather
 * than guessed: a wrong endpoint fails at the worst possible moment, and the env var
 * covers it.
 */
export const CHAIN_PRESETS: Readonly<Record<number, ChainPreset>> = {
  5042002: {
    chainId: 5042002,
    name: "Arc testnet",
    rpcUrl: "https://rpc.testnet.arc.network",
    explorerUrl: "https://testnet.arcscan.app",
    graphNetwork: "arc-testnet",
    erc8004: {
      identityRegistry: "0x8004a818bfb912233c491871b3d84c89a494bd9e",
      reputationRegistry: "0x8004b663056a597dffe9eccc1965a193b7388713",
      validationRegistry: "0x8004cb1bf31daf7788923b405b754f57aceb4272",
    },
  },
  5042: {
    chainId: 5042,
    name: "Arc",
    rpcUrl: undefined,
    explorerUrl: undefined,
    graphNetwork: "arc",
    erc8004: undefined,
  },
};

export const DEFAULT_CHAIN_ID = 5042002;

/** USDC is the native gas token on Arc and is also an ERC-20 at this address, 6 decimals. */
export const USDC_ADDRESS = "0x3600000000000000000000000000000000000000";

export interface ServerConfig {
  readonly chainId: number;
  readonly chainName: string;
  readonly rpcUrl: string | undefined;
  readonly explorerUrl: string | undefined;
  readonly graphNetwork: string | undefined;
  /** VestedParimutuel. The zero address until the venue is deployed. */
  readonly settlerAddress: string;
  /** ClassicParimutuel, when a side-by-side comparison is configured. */
  readonly classicSettlerAddress: string | undefined;
  readonly usdcAddress: string;
  /**
   * Required. Every tool here reads the venue through the subgraph — `@hunch-vpm/client`
   * refuses to be constructed without an endpoint — so a server with no venue subgraph
   * has nothing to answer with and says so at startup rather than at the first call.
   */
  readonly subgraphUrl: string;
  readonly erc8004SubgraphUrl: string | undefined;
  readonly graphApiKey: string | undefined;
  readonly erc8004Registries: ChainPreset["erc8004"];
  /** Applies to this server's own subgraph reads. The client has no timeout knob. */
  readonly requestTimeoutMs: number;
  /** Cap on per-position follow-up reads in one vpm_claimable call. */
  readonly maxPositionLookups: number;
}

export class ConfigError extends Error {
  readonly problems: readonly string[];
  constructor(problems: readonly string[]) {
    super(`Invalid configuration:\n  - ${problems.join("\n  - ")}`);
    this.name = "ConfigError";
    this.problems = problems;
  }
}

export type Env = Readonly<Record<string, string | undefined>>;

/**
 * The Graph gateway's URL shape, which is also what `@hunch-vpm/client` builds from a
 * Studio id. The API key is a path segment rather than a header, so it must never be
 * logged or echoed into a tool result.
 *
 *   https://gateway.thegraph.com/api/<API_KEY>/subgraphs/id/<SUBGRAPH_ID>
 */
export function gatewayUrl(apiKey: string, subgraphId: string): string {
  return `https://gateway.thegraph.com/api/${apiKey}/subgraphs/id/${subgraphId}`;
}

export function loadConfig(env: Env = process.env): ServerConfig {
  const problems: string[] = [];

  const chainId = readInt(env, "HUNCH_VPM_CHAIN_ID", DEFAULT_CHAIN_ID, problems, { min: 1 });
  const preset = CHAIN_PRESETS[chainId];

  const settlerAddress = readAddress(env, "HUNCH_VPM_SETTLER_ADDRESS", ZERO_ADDRESS, problems);
  const classicSettlerAddress = readOptionalAddress(env, "HUNCH_VPM_CLASSIC_SETTLER_ADDRESS", problems);
  const graphApiKey = readString(env, "HUNCH_VPM_GRAPH_API_KEY");

  const subgraphUrl = readEndpoint(env, "HUNCH_VPM_SUBGRAPH_URL", "HUNCH_VPM_SUBGRAPH_ID", graphApiKey, problems, {
    required: "the hunch-vpm subgraph is where every tool reads the venue",
  });
  const erc8004SubgraphUrl = readEndpoint(
    env,
    "HUNCH_VPM_ERC8004_SUBGRAPH_URL",
    "HUNCH_VPM_ERC8004_SUBGRAPH_ID",
    graphApiKey,
    problems,
    {},
  );

  const config: ServerConfig = {
    chainId,
    chainName: preset?.name ?? `chain ${chainId}`,
    rpcUrl: readUrl(env, "HUNCH_VPM_RPC_URL", problems) ?? preset?.rpcUrl,
    explorerUrl: readUrl(env, "HUNCH_VPM_EXPLORER_URL", problems) ?? preset?.explorerUrl,
    graphNetwork: preset?.graphNetwork,
    settlerAddress,
    classicSettlerAddress,
    usdcAddress: USDC_ADDRESS,
    // Sound because a missing endpoint is already a collected problem, and the throw
    // below happens before anything reads the field.
    subgraphUrl: subgraphUrl ?? "",
    erc8004SubgraphUrl,
    graphApiKey,
    erc8004Registries: preset?.erc8004,
    requestTimeoutMs: readInt(env, "HUNCH_VPM_REQUEST_TIMEOUT_MS", 10_000, problems, { min: 500, max: 120_000 }),
    maxPositionLookups: readInt(env, "HUNCH_VPM_MAX_POSITION_LOOKUPS", 25, problems, { min: 0, max: 200 }),
  };

  if (problems.length > 0) throw new ConfigError(problems);
  return config;
}

/**
 * A subgraph endpoint given either as a URL or as a Studio id to be expanded against the
 * gateway with an API key. Nothing is guessed: an id without a key is a problem, not a
 * silent fallback to an endpoint that would 401 on the first read.
 */
function readEndpoint(
  env: Env,
  urlKey: string,
  idKey: string,
  apiKey: string | undefined,
  problems: string[],
  options: { required?: string },
): string | undefined {
  const rawUrl = readString(env, urlKey);
  if (rawUrl !== undefined) return readUrl(env, urlKey, problems);

  const id = readString(env, idKey);
  if (id !== undefined) {
    if (apiKey === undefined) {
      problems.push(`${idKey} needs HUNCH_VPM_GRAPH_API_KEY to build a gateway URL; set it, or set ${urlKey} instead.`);
      return undefined;
    }
    return gatewayUrl(apiKey, id);
  }

  if (options.required !== undefined) {
    problems.push(`${urlKey} is required (${options.required}). Set it, or set ${idKey} with HUNCH_VPM_GRAPH_API_KEY.`);
  }
  return undefined;
}

/** True while the venue is still undeployed; tools say so instead of pretending. */
export function isPlaceholderSettler(config: ServerConfig): boolean {
  return config.settlerAddress === ZERO_ADDRESS;
}

function readString(env: Env, key: string): string | undefined {
  const value = env[key]?.trim();
  return value === undefined || value === "" ? undefined : value;
}

function readInt(
  env: Env,
  key: string,
  fallback: number,
  problems: string[],
  bounds: { min?: number; max?: number },
): number {
  const raw = readString(env, key);
  if (raw === undefined) return fallback;
  if (!/^\d+$/.test(raw)) {
    problems.push(`${key} must be a whole number. Its value is not shown here: any\n      environment variable can end up holding a pasted credential.`);
    return fallback;
  }
  const value = Number(raw);
  if (bounds.min !== undefined && value < bounds.min) {
    problems.push(`${key} must be at least ${bounds.min}, got ${value}.`);
    return fallback;
  }
  if (bounds.max !== undefined && value > bounds.max) {
    problems.push(`${key} must be at most ${bounds.max}, got ${value}.`);
    return fallback;
  }
  return value;
}

/**
 * Endpoint variables are validated without ever echoing their value.
 *
 * `HUNCH_VPM_SUBGRAPH_URL`, `HUNCH_VPM_ERC8004_SUBGRAPH_URL` and `HUNCH_VPM_RPC_URL` can
 * all hold a gateway URL, and the gateway's API key is a path segment (see `gatewayUrl`
 * above). A malformed value is exactly the case where a credential is most likely to be
 * in there — a half-pasted URL, a key pasted into the wrong variable — and `ConfigError`
 * goes straight to the host's log and to the user's screen. So a problem reports the
 * variable, the rule it broke, and a shape hint that cannot reconstruct the value: its
 * length, and for a parseable URL its scheme, neither of which is the key.
 */
function readUrl(env: Env, key: string, problems: string[]): string | undefined {
  const raw = readString(env, key);
  if (raw === undefined) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    problems.push(
      `${key} must be an absolute URL such as https://host/path — the value is ${describeLength(raw)} and did not parse as one. ` +
        `Its value is not shown here because this variable can carry a Graph gateway API key in its path.`,
    );
    return undefined;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    problems.push(
      `${key} must be http(s); its scheme is "${parsed.protocol}". ` +
        `The rest of the value is not shown here because this variable can carry a Graph gateway API key in its path.`,
    );
    return undefined;
  }
  return raw;
}

/** A shape hint for a value that must not be printed. Length alone reconstructs nothing. */
function describeLength(raw: string): string {
  return `${raw.length} character${raw.length === 1 ? "" : "s"}`;
}

function readAddress(env: Env, key: string, fallback: string, problems: string[]): string {
  const raw = readString(env, key);
  if (raw === undefined) return fallback;
  if (!isAddress(raw)) {
    problems.push(`${key} must be a 20-byte hex address. Its value is not shown here: any\n      environment variable can end up holding a pasted credential.`);
    return fallback;
  }
  return normalizeAddress(raw);
}

function readOptionalAddress(env: Env, key: string, problems: string[]): string | undefined {
  const raw = readString(env, key);
  if (raw === undefined) return undefined;
  if (!isAddress(raw)) {
    problems.push(`${key} must be a 20-byte hex address. Its value is not shown here: any\n      environment variable can end up holding a pasted credential.`);
    return undefined;
  }
  return normalizeAddress(raw);
}
