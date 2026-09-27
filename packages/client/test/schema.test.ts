import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  agentsQuery,
  marketPositionsQuery,
  marketQuery,
  ownerPositionsQuery,
  positionQuery,
  unclaimedWinnersQuery,
  walletPositionsQuery,
  walletResidueQuery,
} from '../src/queries.js';
import { loadSchema, validateQuery } from './support/schema.js';

/**
 * Every query this package sends, checked against the schema it will be sent
 * to. Both schemas are in this repository, so there is no excuse for a
 * selection that cannot run — and when the subgraph changes a field, this is
 * what says so.
 */

const VENUE_SCHEMA = fileURLToPath(new URL('../../../subgraph/schema.graphql', import.meta.url));
const ERC8004_SCHEMA = fileURLToPath(new URL('../../../subgraph-erc8004-arc/schema.graphql', import.meta.url));

describe('the venue queries', () => {
  const schema = loadSchema(VENUE_SCHEMA);

  const documents: [string, string][] = [
    ['market, with the open vintage', marketQuery(true)],
    ['market, without it', marketQuery(false)],
    ['position', positionQuery()],
    ['market positions', marketPositionsQuery()],
    ['unclaimed winners', unclaimedWinnersQuery()],
    ['wallet positions', walletPositionsQuery()],
    ['owner positions', ownerPositionsQuery()],
    ['wallet residue', walletResidueQuery()],
  ];

  it.each(documents)('%s runs against subgraph/schema.graphql', (_name, document) => {
    expect(validateQuery(schema, document)).toEqual([]);
  });

  it('catches the mistakes it is here to catch', () => {
    // A field that does not exist.
    expect(validateQuery(schema, 'query { market(id: "x") { outcomeCount } }')).toEqual([
      'query.market.outcomeCount: Market has no field `outcomeCount`',
    ]);
    // An entity reference selected as if it were a scalar.
    expect(validateQuery(schema, 'query { position(id: "x") { owner } }')).toEqual([
      'query.position.owner: Agent is an entity reference and needs a selection set',
    ]);
    // A reference filtered with the referenced entity's own type.
    expect(
      validateQuery(schema, 'query Q($owner: Bytes!) { positions(where: { owner: $owner }) { id } }'),
    ).toEqual(['query.positions: `owner` takes String (Position.owner is Agent), but $owner is declared Bytes']);
  });
});

describe('the reputation query', () => {
  const schema = loadSchema(ERC8004_SCHEMA);

  it('runs against subgraph-erc8004-arc/schema.graphql, by signing wallet', () => {
    expect(validateQuery(schema, agentsQuery('agentWallet'))).toEqual([]);
  });

  it('runs against it by identity owner too', () => {
    expect(validateQuery(schema, agentsQuery('owner'))).toEqual([]);
  });

  it('knows the ERC-8004 Agent has no `address` field to filter on', () => {
    const wrong = `query Agents($addresses: [Bytes!]!) {
      agents(where: { address_in: $addresses }) { id address }
    }`;
    expect(validateQuery(schema, wrong)).toEqual([
      'query.agents: `address_in` filters Agent.address, which does not exist',
      'query.agents.address: Agent has no field `address`',
    ]);
  });
});

describe('the schema files themselves', () => {
  it('are where this package says they are', () => {
    // A moved schema must fail loudly rather than quietly skipping every check
    // above, which is how the queries drifted from the schema in the first
    // place.
    expect(existsSync(VENUE_SCHEMA)).toBe(true);
    expect(existsSync(ERC8004_SCHEMA)).toBe(true);
  });
});
