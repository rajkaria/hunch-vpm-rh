/**
 * The `@hunch-vpm/client` seam.
 *
 * The agent declares the surface it needs here and binds the workspace package to it at
 * first use. Two reasons for a runtime binding rather than a static import:
 *
 *   1. Dry-run must work with nothing installed. The default mode reads fixtures, and
 *      requiring the indexer client to resolve before the agent can print a decision
 *      table would make the demo depend on a subgraph being up.
 *   2. The contract the agent depends on is the ten functions below, not the client's
 *      internal types. Writing that contract down makes the coupling reviewable and puts
 *      the whole of it in one file.
 *
 * The binding goes through the package's FACTORY, never through its module namespace.
 * `@hunch-vpm/client` exports both: `createHunchClient(config)` returns an object whose
 * methods take `(marketId, options?)`, while the same names exported at module level are
 * config-first free functions, `marketBook(config, marketId, options)`. The two shapes
 * have identical names and compatible-looking arity, so a namespace passed here would
 * sail through any surface check and then be called with the market id where the config
 * belongs. `assertClientSurface` refuses a namespace outright for that reason, and
 * `loadHunchClient` fails by name when no factory is exported.
 */

import type { Hex } from "../domain/types.js";

/** Parameters for the client's write helpers. Ids are the settler's own indices, not subgraph ids. */
export interface EnterCalldataParams {
  readonly settler: Hex;
  readonly marketId: bigint;
  readonly outcome: number;
  readonly amount: bigint;
}

export interface PositionCalldataParams {
  readonly settler: Hex;
  readonly positionId: bigint;
}

export interface ApproveCalldataParams {
  /** Who may pull the stake: the settler, for `enter`. */
  readonly spender: Hex;
  readonly amount: bigint;
  readonly token: Hex;
}

export interface HunchClientSurface {
  /** The outcome with the most room left, its own headroom and its binding headroom. */
  bestHeadroom(marketId: string): Promise<unknown>;
  /** Per-outcome share of accepted principal. */
  impliedOdds(marketId: string): Promise<unknown>;
  /** Per outcome, the ERC-8004 reputation of whoever is on the other side of it. */
  counterpartyTrust(marketId: string): Promise<unknown>;
  /** What a position has accrued from stake that landed after it. */
  vestingEarned(positionId: string): Promise<unknown>;
  /** Everything this wallet can pull right now. */
  claimable(wallet: string): Promise<unknown>;
  /** The full per-outcome book state. */
  marketBook(marketId: string): Promise<unknown>;
  /** Allowance for the settler to pull the stake. `enter` uses `transferFrom`. */
  approveCalldata(params: ApproveCalldataParams): unknown;
  /** The call that puts stake on an outcome. */
  enterCalldata(params: EnterCalldataParams): unknown;
  /** The call that settles a position after the market resolved or voided. */
  claimCalldata(params: PositionCalldataParams): unknown;
  /** The call that pulls back a refused remainder before the market settles. */
  withdrawRefundCalldata(params: PositionCalldataParams): unknown;
}

const REQUIRED_METHODS = [
  "bestHeadroom",
  "impliedOdds",
  "counterpartyTrust",
  "vestingEarned",
  "claimable",
  "marketBook",
  "approveCalldata",
  "enterCalldata",
  "claimCalldata",
  "withdrawRefundCalldata",
] as const;

/** The factory names this seam accepts, in the order it looks for them. */
export const FACTORY_NAMES = ["createHunchClient", "createClient"] as const;

export class ClientBindingError extends Error {}

export interface ClientBindingOptions {
  /** Subgraph endpoint the client should read. */
  readonly subgraphUrl: string | undefined;
  /** The deployed `VestedParimutuel` the write helpers should target. */
  readonly settler: string;
  readonly chainId: number;
}

/**
 * Load the client and check it.
 *
 * The config handed to the factory is built from the package's own exports rather than
 * guessed: the settler is an address override (`addresses.vestedParimutuel`), not a
 * per-call argument, and the chain is the package's own chain object picked by id. Passing
 * a bare `{ settler, chainId }` would be silently ignored by the factory and leave every
 * write pointed at the undeployed placeholder.
 */
export async function loadHunchClient(
  options: ClientBindingOptions,
  specifier = "@hunch-vpm/client",
): Promise<HunchClientSurface> {
  let namespace: Record<string, unknown>;
  try {
    namespace = (await import(specifier)) as Record<string, unknown>;
  } catch (cause) {
    throw new ClientBindingError(
      `could not load ${specifier}. Live mode reads the book through it; install the workspace ` +
        `(pnpm install at the repo root) or run in dry-run mode. Cause: ${String(cause)}`,
    );
  }
  return bindHunchClient(namespace, options, specifier);
}

/** The half of `loadHunchClient` that does not need a module loader, so a test can drive it. */
export function bindHunchClient(
  namespace: Record<string, unknown>,
  options: ClientBindingOptions,
  origin: string,
): HunchClientSurface {
  const factoryName = FACTORY_NAMES.find((name) => typeof namespace[name] === "function");
  if (factoryName === undefined) {
    throw new ClientBindingError(
      `${origin} exports no client factory (looked for ${FACTORY_NAMES.join(", ")}). The agent ` +
        `binds through a factory because the package's module-level reads are config-first ` +
        `(marketBook(config, marketId)); calling them as marketBook(marketId) would pass the ` +
        `market id where the config belongs.`,
    );
  }
  const factory = namespace[factoryName] as (config: unknown) => unknown;
  return assertClientSurface(factory(clientConfig(namespace, options, origin)), `${origin}.${factoryName}()`);
}

/** The config shape `createHunchClient` takes, built from what the package itself exports. */
export function clientConfig(
  namespace: Record<string, unknown>,
  options: ClientBindingOptions,
  origin: string,
): Record<string, unknown> {
  const config: Record<string, unknown> = {
    // The write helpers read the settler from the resolved addresses, not from their
    // parameters, so it belongs here. Everything else keeps the package's default.
    addresses: { vestedParimutuel: options.settler },
    chain: findChain(namespace, options.chainId, origin),
  };
  if (options.subgraphUrl !== undefined) config["subgraphUrl"] = options.subgraphUrl;
  return config;
}

/**
 * The package's chain object for this chain id. Picked by id rather than by name so that
 * a mismatch is an error here instead of a silent fall back to the package's default
 * chain, which would resolve mainnet reads against testnet addresses.
 */
function findChain(namespace: Record<string, unknown>, chainId: number, origin: string): unknown {
  for (const name of ["arcTestnet", "arcMainnet"]) {
    const candidate = namespace[name];
    if (typeof candidate === "object" && candidate !== null && (candidate as { id?: unknown }).id === chainId) {
      return candidate;
    }
  }
  throw new ClientBindingError(
    `${origin} exports no chain with id ${String(chainId)} (looked at arcTestnet, arcMainnet). ` +
      `Set HUNCH_CHAIN to a chain the client knows.`,
  );
}

export function assertClientSurface(candidate: unknown, origin: string): HunchClientSurface {
  if (typeof candidate !== "object" || candidate === null) {
    throw new ClientBindingError(`${origin} did not provide an object to call`);
  }
  // A module namespace is a bag of config-first free functions, not a bound client. It
  // would pass the name check below and then be called with the market id in the config
  // position, which is the failure this seam exists to make impossible.
  if ((candidate as { [Symbol.toStringTag]?: unknown })[Symbol.toStringTag] === "Module") {
    throw new ClientBindingError(
      `${origin} is a module namespace, not a bound client. Its reads take the config first ` +
        `(marketBook(config, marketId)); bind them with ${FACTORY_NAMES[0]}(config) and pass ` +
        `the result.`,
    );
  }
  const record = candidate as Record<string, unknown>;
  const missing = REQUIRED_METHODS.filter((name) => typeof record[name] !== "function");
  if (missing.length > 0) {
    throw new ClientBindingError(`${origin} is missing ${missing.join(", ")}`);
  }
  return candidate as HunchClientSurface;
}
