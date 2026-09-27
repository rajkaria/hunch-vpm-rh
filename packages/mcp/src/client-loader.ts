/**
 * Loading `@hunch-vpm/client` at runtime.
 *
 * The import is by variable specifier, not a literal, and that is deliberate: this
 * package typechecks and tests on its own, against the interface in `client-surface.ts`,
 * while the client is developed in parallel. pnpm resolves the workspace dependency at
 * run time; nothing here is bundled.
 *
 * The supported shape is a factory — `createHunchClient(config)`, which is what
 * `@hunch-vpm/client` exports — returning an object whose methods are already bound to a
 * resolved configuration. A module that exports the six reads directly is still accepted,
 * but only after an arity check: the client ALSO exports `marketBook(config, marketId)`
 * and friends at module level, and binding those would put the market id in the config
 * slot and fail on every call with an error pointing at the network instead of at here.
 */

import type { ServerConfig } from "./config.js";
import { isVpmReadClient, missingClientMethods, CLIENT_METHODS, type VpmReadClient } from "./client-surface.js";
import { ToolError } from "./errors.js";
import { ZERO_ADDRESS } from "./format.js";

export const CLIENT_SPECIFIER = "@hunch-vpm/client";

const FACTORY_NAMES = ["createHunchClient", "createClient", "createVpmClient", "createHunchVpmClient", "default"] as const;

/**
 * Reads that take exactly one argument in this server's read surface. A module-level
 * function that declares two is config-first, so the module is a namespace of unbound
 * reads rather than a client, and binding it would silently misread every argument.
 */
const SINGLE_ARGUMENT_METHODS = ["impliedOdds", "vestingEarned", "claimable"] as const;

export interface LoadClientOptions {
  readonly specifier?: string;
  /** Injected in tests so the loader can be exercised without the real package. */
  readonly importer?: (specifier: string) => Promise<unknown>;
}

/**
 * A viem `Chain`, structurally. Building it here rather than importing viem keeps this
 * package's dependency list to the MCP SDK and its validator; the client only reads
 * `chain.id` (to pick its default addresses) and carries the rest through.
 */
export interface ClientChain {
  readonly id: number;
  readonly name: string;
  readonly nativeCurrency: { readonly name: string; readonly symbol: string; readonly decimals: number };
  readonly rpcUrls: { readonly default: { readonly http: readonly string[] } };
  readonly blockExplorers?: { readonly default: { readonly name: string; readonly url: string } };
  readonly testnet?: boolean;
}

/**
 * What the factory is handed. The field names are `HunchClientConfig`'s, because that is
 * the config the client actually reads — a differently spelled object is accepted
 * silently and every value in it is dropped.
 */
export interface ClientFactoryConfig {
  readonly subgraphUrl: string;
  readonly erc8004SubgraphUrl?: string;
  readonly apiKey?: string;
  readonly chain: ClientChain;
  readonly addresses: Readonly<Record<string, string>>;
}

export function clientFactoryConfig(config: ServerConfig): ClientFactoryConfig {
  return {
    subgraphUrl: config.subgraphUrl,
    ...(config.erc8004SubgraphUrl === undefined ? {} : { erc8004SubgraphUrl: config.erc8004SubgraphUrl }),
    ...(config.graphApiKey === undefined ? {} : { apiKey: config.graphApiKey }),
    chain: {
      id: config.chainId,
      name: config.chainName,
      // USDC is the native gas token on Arc: 18 decimals natively (this field),
      // 6 through the ERC-20 interface that every amount here actually uses.
      nativeCurrency: { name: "USD Coin", symbol: "USDC", decimals: 18 },
      rpcUrls: { default: { http: config.rpcUrl === undefined ? [] : [config.rpcUrl] } },
      ...(config.explorerUrl === undefined
        ? {}
        : { blockExplorers: { default: { name: "explorer", url: config.explorerUrl } } }),
      testnet: config.chainId !== 5042,
    },
    addresses: {
      usdc: config.usdcAddress,
      // The zero placeholder is what the client defaults to anyway, so an undeployed
      // settler is left out rather than written over its own default.
      ...(config.settlerAddress === ZERO_ADDRESS ? {} : { vestedParimutuel: config.settlerAddress }),
      ...(config.classicSettlerAddress === undefined ? {} : { classicParimutuel: config.classicSettlerAddress }),
    },
  };
}

export async function loadVpmClient(config: ServerConfig, options: LoadClientOptions = {}): Promise<VpmReadClient> {
  const specifier = options.specifier ?? CLIENT_SPECIFIER;
  const importer: (id: string) => Promise<unknown> = options.importer ?? ((id) => import(id));

  let module: unknown;
  try {
    module = await importer(specifier);
  } catch (thrown) {
    throw new ToolError("not_configured", `Could not load ${specifier}: ${thrown instanceof Error ? thrown.message : String(thrown)}`, {
      hint: `Install the workspace dependencies (pnpm install at the repository root) so ${specifier} resolves, or point the server at a built copy.`,
      detail: { specifier },
      cause: thrown,
    });
  }

  const client = await adapt(module, config, specifier);
  if (client === undefined) {
    throw new ToolError("not_configured", `${specifier} does not expose the reads this server needs.`, {
      hint: `Missing: ${missingClientMethods(module).join(", ")}. Expected a factory (${FACTORY_NAMES.join(" / ")}) returning the six reads, or the six reads exported directly as single-argument functions: ${CLIENT_METHODS.join(", ")}.`,
      detail: { specifier },
    });
  }
  return client;
}

async function adapt(module: unknown, config: ServerConfig, specifier: string): Promise<VpmReadClient | undefined> {
  if (typeof module !== "object" || module === null) return undefined;
  const namespace = module as Record<string, unknown>;

  for (const name of FACTORY_NAMES) {
    const factory = namespace[name];
    if (typeof factory !== "function") continue;
    let built: unknown;
    try {
      // Awaited so a factory that resolves asynchronously works too.
      built = await (factory as (input: ClientFactoryConfig) => unknown)(clientFactoryConfig(config));
    } catch (thrown) {
      // The client validates its configuration in the constructor, so this is where a
      // missing endpoint or an unknown chain surfaces. It is configuration, not a bug.
      throw new ToolError("not_configured", `${specifier} ${name}() refused the server's configuration: ${thrown instanceof Error ? thrown.message : String(thrown)}`, {
        hint: "Check HUNCH_VPM_SUBGRAPH_URL (or HUNCH_VPM_SUBGRAPH_ID with HUNCH_VPM_GRAPH_API_KEY) and HUNCH_VPM_CHAIN_ID.",
        detail: { specifier, factory: name },
        cause: thrown,
      });
    }
    const bound = bind(built);
    if (bound !== undefined) return bound;
  }

  const fromClientExport = bind(namespace["client"]);
  if (fromClientExport !== undefined) return fromClientExport;

  const configFirst = configFirstMethods(namespace);
  if (configFirst.length > 0) {
    throw new ToolError("not_configured", `${specifier} exports its reads config-first, so they cannot be used as a client.`, {
      hint: `${configFirst.join(", ")} take a configuration as their first argument. Export a factory (${FACTORY_NAMES.join(" / ")}) that binds one, and this server will use it.`,
      detail: { specifier, methods: configFirst },
    });
  }
  return bind(namespace);
}

/** The module's reads that declare more parameters than the read surface passes. */
function configFirstMethods(namespace: Record<string, unknown>): string[] {
  return SINGLE_ARGUMENT_METHODS.filter((method) => {
    const fn = namespace[method];
    return typeof fn === "function" && fn.length > 1;
  });
}

/**
 * Methods are bound to their source so a class-based client keeps its `this`. A module
 * namespace of plain functions is unaffected.
 */
function bind(source: unknown): VpmReadClient | undefined {
  if (!isVpmReadClient(source)) return undefined;
  const holder = source as unknown as Record<string, (...args: never[]) => unknown>;
  const bound = {} as Record<string, unknown>;
  for (const method of CLIENT_METHODS) {
    const fn = holder[method];
    if (typeof fn !== "function") return undefined;
    bound[method] = fn.bind(holder);
  }
  return bound as unknown as VpmReadClient;
}
