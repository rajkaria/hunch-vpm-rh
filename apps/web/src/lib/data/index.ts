/**
 * Which data source the pages read, per network.
 *
 * This is the file. Every page imports from here and nothing else in the app
 * knows whether the numbers came from a fixture or from the chain, so pointing
 * the surface at live data is a change to this module and to the environment
 * it reads — not to any page, component or calculation.
 *
 * Each Arc reads its own index. The toggle in the header picks the network, the
 * server reads the choice from a cookie (`lib/network-server.ts`), and asks
 * `dataSourceFor(network)`. A network with no subgraph URL serves the fixture
 * dataset and the layout says so — which is the honest state of mainnet until
 * something is deployed there.
 *
 * Every endpoint variable goes through `readPublicEndpoint`, which refuses a
 * URL that looks like it carries an API key. `NEXT_PUBLIC_*` values are inlined
 * into the browser bundle, and The Graph's gateway carries its key as a path
 * segment (`/api/<API_KEY>/subgraphs/id/<ID>`), so a working gateway URL pasted
 * in here would be served to every visitor. The refusal is a throw, at module
 * load, which fails the build rather than shipping the key — see
 * `public-env.ts`. All of them are read, including one shadowed by a more
 * specific variable: a keyed value fails the build whether or not it is in use.
 */

import type { NetworkId } from '../chain';
import { DEFAULT_NETWORK } from '../wallet/chains';
import { createFixtureSource } from './fixture-source';
import { createLiveSource } from './live';
import { readPublicEndpoint } from './public-env';
import type { DataSource } from './types';

interface Endpoints {
  subgraphUrl: string | undefined;
  erc8004SubgraphUrl: string | undefined;
  marketIds: string[];
}

function marketIdList(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id !== '');
}

/** `value` unless it is unset or blank. An empty variable is not a choice. */
function present(value: string | undefined): string | undefined {
  return value === undefined || value.trim() === '' ? undefined : value;
}

/*
 * The `process.env.NEXT_PUBLIC_*` reads stay as literal member expressions
 * because that is the form Next's compiler substitutes at build time.
 */

function testnetEndpoints(): Endpoints {
  const subgraph = readPublicEndpoint(
    'NEXT_PUBLIC_HUNCH_SUBGRAPH_URL_TESTNET',
    process.env.NEXT_PUBLIC_HUNCH_SUBGRAPH_URL_TESTNET,
  );
  // The unsuffixed names predate the network toggle and are still read, as testnet.
  const legacySubgraph = readPublicEndpoint(
    'NEXT_PUBLIC_HUNCH_SUBGRAPH_URL',
    process.env.NEXT_PUBLIC_HUNCH_SUBGRAPH_URL,
  );
  const erc8004 = readPublicEndpoint(
    'NEXT_PUBLIC_ERC8004_SUBGRAPH_URL_TESTNET',
    process.env.NEXT_PUBLIC_ERC8004_SUBGRAPH_URL_TESTNET,
  );
  const legacyErc8004 = readPublicEndpoint(
    'NEXT_PUBLIC_ERC8004_SUBGRAPH_URL',
    process.env.NEXT_PUBLIC_ERC8004_SUBGRAPH_URL,
  );
  return {
    subgraphUrl: subgraph ?? legacySubgraph,
    erc8004SubgraphUrl: erc8004 ?? legacyErc8004,
    marketIds: marketIdList(
      present(process.env.NEXT_PUBLIC_HUNCH_MARKET_IDS_TESTNET) ?? process.env.NEXT_PUBLIC_HUNCH_MARKET_IDS,
    ),
  };
}

function mainnetEndpoints(): Endpoints {
  // No fallback to the unsuffixed names: those have always meant testnet, and a
  // mainnet board silently reading a testnet index is the one mix-up worth refusing.
  return {
    subgraphUrl: readPublicEndpoint(
      'NEXT_PUBLIC_HUNCH_SUBGRAPH_URL_MAINNET',
      process.env.NEXT_PUBLIC_HUNCH_SUBGRAPH_URL_MAINNET,
    ),
    erc8004SubgraphUrl: readPublicEndpoint(
      'NEXT_PUBLIC_ERC8004_SUBGRAPH_URL_MAINNET',
      process.env.NEXT_PUBLIC_ERC8004_SUBGRAPH_URL_MAINNET,
    ),
    marketIds: marketIdList(process.env.NEXT_PUBLIC_HUNCH_MARKET_IDS_MAINNET),
  };
}

function sourceFor(network: NetworkId, endpoints: Endpoints): DataSource {
  if (endpoints.subgraphUrl === undefined) return createFixtureSource();
  return createLiveSource({
    network,
    subgraphUrl: endpoints.subgraphUrl,
    marketIds: endpoints.marketIds,
    ...(endpoints.erc8004SubgraphUrl === undefined ? {} : { erc8004SubgraphUrl: endpoints.erc8004SubgraphUrl }),
    wallet: null,
  });
}

const SOURCES: Record<NetworkId, DataSource> = {
  testnet: sourceFor('testnet', testnetEndpoints()),
  mainnet: sourceFor('mainnet', mainnetEndpoints()),
};

/** The source for one Arc. */
export function dataSourceFor(network: NetworkId): DataSource {
  return SOURCES[network];
}

/** The deployment's default network's source, for callers with no request to read a choice from. */
export const dataSource: DataSource = SOURCES[DEFAULT_NETWORK];

export { createFixtureSource } from './fixture-source';
export { createLiveSource } from './live';
export { keyedUrlReason, PublicEnvError, readPublicEndpoint } from './public-env';
export * from './types';
