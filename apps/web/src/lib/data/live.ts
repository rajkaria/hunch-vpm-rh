/**
 * The live data source: the same interface, backed by `@hunch-vpm/client`.
 *
 * Two things about this file are deliberate.
 *
 * The client is loaded through a dynamic import with a specifier the compiler
 * cannot follow, and its surface is described by the local interfaces below
 * rather than by importing its types. That is not shyness about types: the
 * client publishes its types from `dist`, and this app has to typecheck and
 * build in a workspace where that has not been produced yet — a fresh clone,
 * and CI, where `pnpm -r typecheck` runs before `pnpm -r build`. A static
 * import would make the web app's typecheck depend on another package's build
 * artefact. The declarations here are checked against the real ones at the one
 * moment it matters, when the module is loaded and called.
 *
 * And it is honest about its edges. The client answers questions about a
 * market you can name; it has no "list every market" read, no leaderboard, and
 * no entry-level history to draw a vesting curve from. Where that is the case
 * this source says so through the value it returns — an empty list, an empty
 * history — rather than inventing something, and the pages render the empty
 * state they already have to render anyway.
 */

import { isDeployed, NETWORKS, type ContractAddresses, type NetworkId } from '../chain';
import { CHAINS } from '../wallet/chains';
import { formatPrice } from '../units';
import { formatUtcDate } from '../time';
import type {
  PortfolioEntry,
  AgentRow,
  ClaimableView,
  DataSource,
  MarketDetail,
  MarketStatus,
  MarketSummary,
  OutcomeView,
  PositionView,
  ResolutionSpec,
  SettlerKind,
} from './types';

// ------------------------------------------------------------------ the client's surface, as used here

interface ClientBookView {
  outcome: number;
  principal: bigint;
  vested: bigint;
  capacity: bigint | null;
  headroom: bigint | null;
  probabilityPpm: bigint;
  maxFullyAccepted: bigint | null;
  acc: bigint;
  live: number | null;
}

interface ClientResolutionSpec {
  specId: string;
  oracle: string;
  feedKey: string;
  strike: bigint;
  direction: 'above' | 'below';
  maxStaleness: bigint;
}

interface ClientMarketBook {
  marketId: string;
  settler: string;
  settlerKind: SettlerKind;
  onChainMarketId: bigint;
  token: string;
  status: MarketStatus;
  winner: number | null;
  kappa: bigint | null;
  acceptedPool: bigint;
  paidOut: bigint;
  residue: bigint;
  residueOwner: string;
  residueClaimed: boolean;
  resolutionTime: bigint;
  secondsToFreeze: bigint;
  frozen: boolean;
  voidTimeout: bigint;
  voidableFrom: bigint;
  books: ClientBookView[];
  spec: ClientResolutionSpec | null;
  index: { block: bigint; hasIndexingErrors: boolean };
}

interface ClientClaimBreakdown {
  settlement: bigint;
  voidRefund: bigint;
  refusedRemainder: bigint;
  residue: bigint;
}

interface ClientClaimable {
  wallet: string;
  totals: ClientClaimBreakdown & { total: bigint };
  items: {
    id: string;
    marketId: string;
    amount: bigint;
    breakdown: ClientClaimBreakdown;
    call: 'claim' | 'withdrawRefund' | 'claimResidue';
    argument: bigint;
    settler: string;
  }[];
  blockedResidue: { marketId: string; amount: bigint; reason: string }[];
  index: { block: bigint; hasIndexingErrors: boolean };
}

interface ClientOwnedPosition {
  id: string;
  positionId: bigint;
  owner: string;
  outcome: number;
  offered: bigint;
  accepted: bigint;
  refused: bigint;
  entryAcc: bigint;
  vintage: bigint | null;
  finalized: boolean;
  refundWithdrawn: boolean;
  claimed: boolean;
  createdAt: bigint;
  market: { id: string };
}

interface ClientWalletPositions {
  wallet: string;
  positions: ClientOwnedPosition[];
  index: { block: bigint; hasIndexingErrors: boolean };
}

interface ClientSurface {
  marketBook(marketId: string): Promise<ClientMarketBook>;
  claimable(wallet: string): Promise<ClientClaimable>;
  positions(wallet: string): Promise<ClientWalletPositions>;
}

/** The part of `@hunch-vpm/client` this source calls, for a test to stand in for. */
export type LiveClient = ClientSurface;

interface ClientModule {
  createHunchClient(config: Record<string, unknown>): ClientSurface;
}

export interface LiveSourceOptions {
  /** The `hunch-vpm` subgraph's query endpoint. */
  subgraphUrl: string;
  /** The ERC-8004 subgraph for the same chain, when reputation is wanted. */
  erc8004SubgraphUrl?: string;
  /**
   * Which markets the board lists. The client reads a market you can name; it
   * has no query that enumerates them, so the deployment says which ones it
   * is for. Ids are subgraph ids, `<settler>-<index>`.
   */
  marketIds?: string[];
  /** The connected wallet, when there is one. */
  wallet?: string | null;
  /** Which Arc the subgraph indexes. Decides the client's chain and the addresses shown. Default testnet. */
  network?: NetworkId;
  /** Build the client from its config. Defaults to loading `@hunch-vpm/client`; tests pass a stand-in. */
  createClient?: (config: Record<string, unknown>) => LiveClient;
}

/**
 * Load the client once, lazily.
 *
 * The specifier is a literal so the bundler compiles the client into the server
 * bundle. It used to go through a variable, which kept it out of the bundler's
 * sight — and out of Vercel's file trace, so every deployed function failed
 * with "Cannot find module" and every live read became "the index could not be
 * reached". The bundle is built from the client's `dist`, which the web app's
 * own `build` script produces first; `vitest.config.ts` points tests at the
 * client's source, so tests never need `dist`. The compiler is still told
 * nothing about it (see the note at the top of this file): the local
 * interfaces are the contract.
 */
let clientModule: Promise<ClientModule> | null = null;
function loadClient(): Promise<ClientModule> {
  if (clientModule === null) {
    // @ts-ignore -- deliberately untyped here; `tsc` may run before the client's `dist` exists.
    clientModule = import('@hunch-vpm/client') as Promise<ClientModule>;
  }
  return clientModule;
}

export function createLiveSource(options: LiveSourceOptions): DataSource {
  const marketIds = options.marketIds ?? [];
  const wallet = options.wallet ?? null;
  const network = options.network ?? 'testnet';
  const addresses = NETWORKS[network].addresses;

  const client = async (): Promise<ClientSurface> => {
    const config = {
      subgraphUrl: options.subgraphUrl,
      // The client picks its default addresses — and so every calldata target — by
      // chain, so it has to be told which Arc this index is for.
      chain: CHAINS[network],
      ...(options.erc8004SubgraphUrl === undefined ? {} : { erc8004SubgraphUrl: options.erc8004SubgraphUrl }),
    };
    if (options.createClient !== undefined) return options.createClient(config);
    const module = await loadClient();
    return module.createHunchClient(config);
  };

  const read = async (id: string): Promise<MarketDetail> => {
    const book = await (await client()).marketBook(id);
    return toMarketDetail(book, addresses);
  };

  return {
    kind: 'live',

    async listMarkets(): Promise<MarketSummary[]> {
      const hunch = await client();
      const books = await Promise.all(marketIds.map((id) => hunch.marketBook(id)));
      return books.map((book) => toMarketDetail(book, addresses));
    },

    async getMarket(id: string): Promise<MarketDetail | null> {
      try {
        return await read(id);
      } catch (error) {
        // The client throws `NotFoundError` for an id the index does not hold,
        // which is a 404 here and not a failure worth a stack trace.
        if (error instanceof Error && error.name === 'NotFoundError') return null;
        throw error;
      }
    },

    async listAgents(): Promise<AgentRow[]> {
      // The client reads the counterparties of one market, not a ranking
      // across all of them. A leaderboard needs an aggregate the subgraph does
      // not publish yet; returning nothing renders the empty state rather than
      // a made-up ranking.
      return [];
    },

    async getClaimable(forWallet: string): Promise<ClaimableView> {
      const claimable = await (await client()).claimable(forWallet);
      return {
        wallet: claimable.wallet,
        totals: claimable.totals,
        items: claimable.items.map((item) => ({
          ...item,
          // The claim read does not carry the question, and fetching every
          // market to label a row would multiply the request count. The id is
          // what the transaction needs and the row links to the market.
          question: item.marketId,
        })),
        blockedResidue: claimable.blockedResidue.map((entry) => ({ ...entry, question: entry.marketId })),
        index: { ...claimable.index, source: 'live' },
      };
    },

    /**
     * Every position an address holds or has held on this network, newest
     * first, each with its market read in full.
     *
     * One `positions` read, then one `marketBook` per distinct market: the
     * portfolio shows each market's status, freeze and outcome labels, which the
     * position read does not carry priced. A wallet sits in few enough markets
     * that this is a handful of requests, and a market is read once however many
     * positions it holds.
     */
    async getPositions(forWallet: string): Promise<PortfolioEntry[]> {
      const hunch = await client();
      const held = await hunch.positions(forWallet);
      const ids = [...new Set(held.positions.map((position) => position.market.id))];
      const books = await Promise.all(ids.map((id) => hunch.marketBook(id)));
      const markets = new Map(books.map((book) => [book.marketId, toMarketDetail(book, addresses)]));

      return held.positions.flatMap((position) => {
        const market = markets.get(position.market.id);
        // Unreachable through the client, which reads each market by the id its position names.
        if (market === undefined) return [];
        return [{ market, position: toPositionView(position) }];
      });
    },

    currentWallet(): string | null {
      return wallet;
    },
  };
}

// ------------------------------------------------------------------ mapping

function toPositionView(position: ClientOwnedPosition): PositionView {
  return {
    id: position.id,
    positionId: position.positionId,
    owner: position.owner,
    outcome: position.outcome,
    offered: position.offered,
    accepted: position.accepted,
    refused: position.refused,
    entryAcc: position.entryAcc,
    // Stays null on a classic position rather than becoming 0n, which is the seed vintage.
    vintage: position.vintage,
    finalized: position.finalized,
    refundWithdrawn: position.refundWithdrawn,
    claimed: position.claimed,
    enteredAt: position.createdAt,
  };
}

function toMarketDetail(book: ClientMarketBook, addresses: ContractAddresses): MarketDetail {
  const spec = book.spec === null ? null : toSpec(book.spec, addresses);
  return {
    id: book.marketId,
    onChainMarketId: book.onChainMarketId,
    settler: book.settler,
    settlerKind: book.settlerKind,
    question: describe(spec, book.resolutionTime),
    subject: spec?.feedLabel ?? 'Unknown feed',
    status: book.status,
    winner: book.winner,
    kappa: book.kappa,
    acceptedPool: book.acceptedPool,
    resolutionTime: book.resolutionTime,
    secondsToFreeze: book.secondsToFreeze,
    frozen: book.frozen,
    outcomes: book.books.map((entry) => toOutcome(entry, spec)),
    token: book.token,
    creator: book.settler,
    resolver: addresses.feedResolver,
    residueOwner: book.residueOwner,
    residueClaimed: book.residueClaimed,
    residue: book.residue,
    paidOut: book.paidOut,
    voidTimeout: book.voidTimeout,
    voidableFrom: book.voidableFrom,
    vintageOpen: false,
    vintageBlock: null,
    spec,
    // The curve needs per-entry history, which is an event query the client
    // does not expose. The market page renders without it.
    history: [],
    positions: [],
    index: { ...book.index, source: 'live' },
  };
}

function toOutcome(entry: ClientBookView, spec: ResolutionSpec | null): OutcomeView {
  return {
    outcome: entry.outcome,
    label: outcomeLabel(entry.outcome, spec),
    tone: entry.outcome === 0 ? 'up' : entry.outcome === 1 ? 'down' : 'neutral',
    principal: entry.principal,
    vested: entry.vested,
    capacity: entry.capacity,
    acc: entry.acc,
    // `marketBook` reports the room, not the queue behind it. Treating the
    // queue as empty makes `maxFullyAccepted` an upper bound, which is what
    // the client's own `demandUnknown` flag says about the same read.
    demand: 0n,
    live: entry.live,
    probabilityPpm: entry.probabilityPpm,
  };
}

function toSpec(spec: ClientResolutionSpec, addresses: ContractAddresses): ResolutionSpec {
  return {
    specId: spec.specId,
    oracle: spec.oracle,
    // A spec names the ADAPTER it reads, not the provider's own contract, so that is
    // what identifies it — one of the adapters this network's deployment shipped.
    oracleName: oracleNameFor(spec.oracle, addresses),
    feedKey: spec.feedKey,
    feedLabel: FEED_LABELS[spec.feedKey.toLowerCase()] ?? spec.feedKey,
    strike: spec.strike,
    direction: spec.direction,
    maxStaleness: spec.maxStaleness,
    lastPrice: null,
    lastUpdatedAt: null,
  };
}

/**
 * Feed keys are opaque bytes32 to everyone but the adapter. This maps the ones
 * this deployment uses; anything else shows the key itself rather than a guess.
 */
const FEED_LABELS: Record<string, string> = {
  // Stork: keccak256 of its asset id.
  '0x7404e3d104ea7841c3d9e6fd20adfe99b4ad586bc08d8f3bd3afef894cf184de': 'ETHUSD',
  // ChainlinkCreOracle: keccak256 of the source feed's own `description()`.
  '0x62ddc8c5ffbd077b5a28e92efd10abcc58e66fb2a326401f0efd02e173ac1777': 'ETH / USD',
  '0x0e3e290fbc572c3c2d1656bd757b05413d2fc62474d95064641dcabee325eb93': 'BTC / USD',
};

export function oracleNameFor(oracle: string, addresses: ContractAddresses): string {
  const address = oracle.toLowerCase();
  if (isDeployed(addresses.chainlinkCreOracle) && address === addresses.chainlinkCreOracle.toLowerCase()) {
    return 'Chainlink Data Feed, relayed by Chainlink CRE';
  }
  if (isDeployed(addresses.priceOracle) && address === addresses.priceOracle.toLowerCase()) {
    return 'Stork, through the IPriceOracle adapter';
  }
  return `Oracle adapter at ${oracle}`;
}

/**
 * A market has no title on chain: it has a spec. Say what the spec says, in a
 * sentence, rather than leave the page headed by a hash.
 */
function describe(spec: ResolutionSpec | null, resolutionTime: bigint): string {
  if (spec === null) return 'Market with no registered resolution spec';
  const side = spec.direction === 'above' ? 'above' : 'below';
  return `Will ${spec.feedLabel} be ${side} ${formatPrice(spec.strike)} on ${formatUtcDate(resolutionTime)}?`;
}

function outcomeLabel(outcome: number, spec: ResolutionSpec | null): string {
  if (spec === null) return `Outcome ${outcome}`;
  const strike = formatPrice(spec.strike);
  if (spec.direction === 'above') return outcome === 0 ? `Above ${strike}` : `Below ${strike}`;
  return outcome === 0 ? `Below ${strike}` : `Above ${strike}`;
}
