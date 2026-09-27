/**
 * Who is on the other side of a book.
 *
 * Two sources, deliberately separate:
 *   - the ERC-8004 subgraph on Arc gives identity (IdentityRegistry) and reputation
 *     (ReputationRegistry, ValidationRegistry);
 *   - the venue's own subgraph gives the AgentBook human-backed flag and what the
 *     wallet has actually done here.
 *
 * Either can fail without taking the answer down with it: a partial record with a note
 * saying what is missing beats an error, because "registered, AgentBook status unknown"
 * is still a decision an agent can make.
 *
 * ## Where the field names come from
 *
 * Both queries are built from the schemas in this repository — `subgraph/schema.graphql`
 * for the venue and `subgraph-erc8004-arc/schema.graphql` for the registries — and
 * `test/agent-directory.test.ts` asserts every selected field and every filter still
 * exists in them. A GraphQL server rejects a whole document for one unknown field, so a
 * guess here does not degrade the answer, it deletes it.
 */

import { asArray, asBigInt, asFlag, asIdString, asNumber, asObject, asString, asUnixSeconds, optional, pick } from "./decode.js";
import type { AgentRecord } from "./domain.js";
import { normalizeAddress } from "./format.js";
import { createGraphQLClient, type FetchLike, type GraphQLClient } from "./graphql.js";
import type { ServerConfig } from "./config.js";

export interface AgentDirectory {
  lookup(wallet: string): Promise<AgentRecord>;
}

/** Selected fields of `Agent` in subgraph-erc8004-arc/schema.graphql. */
export const ERC8004_AGENT_FIELDS = [
  "id",
  "agentId",
  "owner",
  "agentWallet",
  "name",
  "metadataURI",
  "registeredAt",
  "updatedAt",
  "burned",
  "feedbackCount",
  "activeFeedbackCount",
  "revokedFeedbackCount",
  "averageScore",
  "validationCount",
] as const;

/** Fields of the same type used as filters, which must exist for the same reason. */
export const ERC8004_AGENT_FILTERS = ["owner", "agentWallet"] as const;

/**
 * Two selections, because the NFT holder and the wallet the agent signs as are separate
 * concepts in ERC-8004 and a counterparty address can be either one. `owner` and
 * `agentWallet` are `Bytes`, so the variable is `Bytes!` — a `String!` is a filter type
 * mismatch the server rejects outright.
 */
export const ERC8004_AGENT_QUERY = `query HunchVpmAgentIdentity($wallet: Bytes!) {
  byOwner: agents(where: { owner: $wallet }, first: 1) {
    ${ERC8004_AGENT_FIELDS.join("\n    ")}
  }
  byWallet: agents(where: { agentWallet: $wallet }, first: 1) {
    ${ERC8004_AGENT_FIELDS.join("\n    ")}
  }
}`;

/** Selected fields of `Agent` in subgraph/schema.graphql. */
export const VENUE_AGENT_FIELDS = [
  "id",
  "erc8004Id",
  "agentBookVerified",
  "marketsEntered",
  "totalOffered",
  "totalAccepted",
  "totalClaimed",
  "firstSeenAt",
] as const;

/**
 * `Agent.id` is the lowercase wallet address, so the lookup is by id and the variable is
 * `ID!`. `positions` is a @derivedFrom list rather than a count, and is not selected: a
 * position count is not worth paging a collection for.
 */
export const VENUE_AGENT_QUERY = `query HunchVpmAgentVenue($wallet: ID!) {
  agent(id: $wallet) {
    ${VENUE_AGENT_FIELDS.join("\n    ")}
  }
}`;

export interface SubgraphAgentDirectoryDeps {
  readonly fetchImpl?: FetchLike | undefined;
}

export function createSubgraphAgentDirectory(config: ServerConfig, deps: SubgraphAgentDirectoryDeps = {}): AgentDirectory {
  const identityClient = config.erc8004SubgraphUrl
    ? createGraphQLClient({
        url: config.erc8004SubgraphUrl,
        apiKey: config.graphApiKey,
        timeoutMs: config.requestTimeoutMs,
        fetchImpl: deps.fetchImpl,
        label: "the ERC-8004 subgraph",
      })
    : undefined;

  // The venue subgraph is required configuration, so this half always exists.
  const venueClient = createGraphQLClient({
    url: config.subgraphUrl,
    apiKey: config.graphApiKey,
    timeoutMs: config.requestTimeoutMs,
    fetchImpl: deps.fetchImpl,
    label: "the hunch-vpm subgraph",
  });

  return {
    async lookup(wallet) {
      const address = normalizeAddress(wallet);
      const notes: string[] = [];
      const identity = await tolerate(
        identityClient === undefined ? undefined : () => readIdentity(identityClient, address),
        notes,
        "ERC-8004 identity and reputation unavailable",
        "HUNCH_VPM_ERC8004_SUBGRAPH_URL is not set, so ERC-8004 identity and reputation were not read.",
      );
      const venue = await tolerate(
        () => readVenue(venueClient, address),
        notes,
        "venue activity and AgentBook status unavailable",
        "",
      );

      // Both sources can carry the ERC-8004 id; the registry's own answer wins.
      const agentId = identity?.agentId ?? venue?.erc8004Id;

      return {
        wallet: address,
        identity: {
          registered: identity !== undefined && identity.found && !identity.burned,
          burned: identity?.burned,
          agentId,
          name: identity?.name,
          metadataUri: identity?.metadataUri,
          registry: config.erc8004Registries?.identityRegistry,
        },
        reputation: {
          feedbackCount: identity?.feedbackCount,
          activeFeedbackCount: identity?.activeFeedbackCount,
          revokedFeedbackCount: identity?.revokedFeedbackCount,
          averageScore: identity?.averageScore,
          validationCount: identity?.validationCount,
          lastSeen: identity?.updatedAt ?? identity?.registeredAt,
        },
        humanBacked: venue?.humanBacked,
        venue:
          venue === undefined
            ? undefined
            : {
                marketsEntered: venue.marketsEntered,
                offered: venue.offered,
                acceptedStake: venue.acceptedStake,
                claimed: venue.claimed,
                firstSeen: venue.firstSeen,
              },
        notes,
      };
    },
  };
}

/**
 * Runs one source and turns its failure into a note. A source the operator chose not to
 * configure is not a failure, so it gets its own wording.
 */
async function tolerate<T>(
  read: (() => Promise<T>) | undefined,
  notes: string[],
  failureNote: string,
  absentNote: string,
): Promise<T | undefined> {
  if (read === undefined) {
    if (absentNote !== "") notes.push(absentNote);
    return undefined;
  }
  try {
    return await read();
  } catch (thrown) {
    const message = thrown instanceof Error ? thrown.message : String(thrown);
    notes.push(`${failureNote}: ${message}`);
    return undefined;
  }
}

interface IdentityRead {
  readonly found: boolean;
  readonly burned: boolean | undefined;
  readonly agentId: string | undefined;
  readonly name: string | undefined;
  readonly metadataUri: string | undefined;
  readonly registeredAt: number | undefined;
  readonly updatedAt: number | undefined;
  readonly feedbackCount: number | undefined;
  readonly activeFeedbackCount: number | undefined;
  readonly revokedFeedbackCount: number | undefined;
  readonly averageScore: number | undefined;
  readonly validationCount: number | undefined;
}

const NO_IDENTITY: IdentityRead = {
  found: false,
  burned: undefined,
  agentId: undefined,
  name: undefined,
  metadataUri: undefined,
  registeredAt: undefined,
  updatedAt: undefined,
  feedbackCount: undefined,
  activeFeedbackCount: undefined,
  revokedFeedbackCount: undefined,
  averageScore: undefined,
  validationCount: undefined,
};

async function readIdentity(client: GraphQLClient, wallet: string): Promise<IdentityRead> {
  const data = await client.query(ERC8004_AGENT_QUERY, { wallet });
  // The holder's identity is the authoritative one; the signing-wallet match is the
  // fallback for an agent whose NFT sits in a different wallet.
  const byOwner = asArray(data["byOwner"] ?? [], "erc8004.byOwner");
  const byWallet = asArray(data["byWallet"] ?? [], "erc8004.byWallet");
  const first = byOwner[0] ?? byWallet[0];
  if (first === undefined) return NO_IDENTITY;

  const path = "erc8004.agent";
  const agent = asObject(first, path);
  return {
    found: true,
    burned: optional(pick(agent, ["burned"]), asFlag, `${path}.burned`),
    agentId: optional(pick(agent, ["agentId", "tokenId"]), asIdString, `${path}.agentId`),
    name: optional(pick(agent, ["name"]), asString, `${path}.name`),
    metadataUri: optional(pick(agent, ["metadataURI", "metadataUri"]), asString, `${path}.metadataURI`),
    registeredAt: optional(pick(agent, ["registeredAt"]), asUnixSeconds, `${path}.registeredAt`),
    updatedAt: optional(pick(agent, ["updatedAt"]), asUnixSeconds, `${path}.updatedAt`),
    feedbackCount: optional(pick(agent, ["feedbackCount"]), asNumber, `${path}.feedbackCount`),
    activeFeedbackCount: optional(pick(agent, ["activeFeedbackCount"]), asNumber, `${path}.activeFeedbackCount`),
    revokedFeedbackCount: optional(pick(agent, ["revokedFeedbackCount"]), asNumber, `${path}.revokedFeedbackCount`),
    averageScore: optional(pick(agent, ["averageScore"]), asNumber, `${path}.averageScore`),
    validationCount: optional(pick(agent, ["validationCount"]), asNumber, `${path}.validationCount`),
  };
}

interface VenueRead {
  readonly erc8004Id: string | undefined;
  readonly humanBacked: boolean | undefined;
  readonly marketsEntered: number | undefined;
  readonly offered: bigint | undefined;
  readonly acceptedStake: bigint | undefined;
  readonly claimed: bigint | undefined;
  readonly firstSeen: number | undefined;
}

async function readVenue(client: GraphQLClient, wallet: string): Promise<VenueRead> {
  const data = await client.query(VENUE_AGENT_QUERY, { wallet });
  const raw = data["agent"];
  if (raw === null || raw === undefined) {
    // The wallet has never touched the venue. Not an error — most wallets have not.
    return {
      erc8004Id: undefined,
      humanBacked: undefined,
      marketsEntered: 0,
      offered: 0n,
      acceptedStake: 0n,
      claimed: 0n,
      firstSeen: undefined,
    };
  }
  const path = "venue.agent";
  const agent = asObject(raw, path);
  return {
    erc8004Id: optional(pick(agent, ["erc8004Id"]), asIdString, `${path}.erc8004Id`),
    humanBacked: optional(pick(agent, ["agentBookVerified"]), asFlag, `${path}.agentBookVerified`),
    marketsEntered: optional(pick(agent, ["marketsEntered"]), asNumber, `${path}.marketsEntered`),
    offered: optional(pick(agent, ["totalOffered"]), asBigInt, `${path}.totalOffered`),
    acceptedStake: optional(pick(agent, ["totalAccepted"]), asBigInt, `${path}.totalAccepted`),
    claimed: optional(pick(agent, ["totalClaimed"]), asBigInt, `${path}.totalClaimed`),
    firstSeen: optional(pick(agent, ["firstSeenAt"]), asUnixSeconds, `${path}.firstSeenAt`),
  };
}
