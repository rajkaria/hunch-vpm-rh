import { describe, expect, it } from 'vitest';
import agentsByOwner from './fixtures/agents-by-owner.json';
import agentsByWallet from './fixtures/agents-by-wallet.json';
import agentsUnrated from './fixtures/agents-registered-unrated.json';
import marketOpen from './fixtures/market-open.json';
import marketOpenVintage from './fixtures/market-open-vintage.json';
import marketLean from './fixtures/market-lean.json';
import marketUnbounded from './fixtures/market-unbounded.json';
import marketVoided from './fixtures/market-voided.json';
import positionEarning from './fixtures/position-earning.json';
import { DecodeError, decodeAgent, decodeMarket, decodeMeta, decodePosition, sameAddress } from '../src/decode.js';

describe('decodeMarket', () => {
  it('turns every amount into a bigint and checksums every address', () => {
    const market = decodeMarket(marketOpen.market);

    expect(market.acceptedPool).toBe(107_000000n);
    expect(market.books[0]?.acc).toBe(17_666666666666666666n);
    expect(market.settler).toBe('0x1111111111111111111111111111111111111111');
    expect(market.spec?.oracle).toBe('0xacC0a0cF13571d30B4b8637996F5D6D774d4fd62');
  });

  it('reads the outcome count from the schema field it is actually called', () => {
    // The schema spells it `n`; this package spells it `outcomeCount`.
    expect(decodeMarket(marketOpen.market).outcomeCount).toBe(2);
    expect(decodeMarket(marketUnbounded.market).outcomeCount).toBe(3);
  });

  it('flattens the resolution spec the schema keeps on the market itself', () => {
    const spec = decodeMarket(marketOpen.market).spec;
    expect(spec?.direction).toBe('above');
    expect(spec?.strike).toBe(300_000000000n);
    expect(spec?.maxStaleness).toBe(300n);
    expect(decodeMarket(marketVoided.market).spec?.direction).toBe('below');
  });

  it('has no spec for a market opened straight on a settler', () => {
    const bare = { ...marketOpen.market, specId: null };
    expect(decodeMarket(bare).spec).toBeNull();
  });

  it('separates the factory that created a market from the wallet that opened it', () => {
    const market = decodeMarket(marketOpen.market);
    expect(market.creator).toBe('0x9999999999999999999999999999999999999999');
    expect(market.opener).toBe('0x2222222222222222222222222222222222222222');
    // A market created directly on the settler has no opener.
    expect(decodeMarket(marketVoided.market).opener).toBeNull();
  });

  it('reads the unbounded sentinel off the boolean, not off the number', () => {
    const market = decodeMarket(marketUnbounded.market);
    expect(market.kappa).toBeNull();
    expect(market.books.every((book) => book.capacity === null)).toBe(true);
  });

  it('refuses a negative capacity that is not flagged as unbounded', () => {
    // -1 without the flag is the sentinel arriving with its meaning stripped.
    // Passing it through to `capacity - vested` would report zero headroom on a
    // market that in fact refuses nothing, so it fails instead.
    const lying = {
      ...marketUnbounded.market,
      kappaIsUnbounded: false,
      books: marketUnbounded.market.books.map((book) => ({ ...book, capacityIsUnbounded: false })),
    };
    expect(() => decodeMarket(lying)).toThrow(DecodeError);
  });

  it('does not mistake an unset winner slot for outcome 0', () => {
    expect(decodeMarket(marketOpen.market).winner).toBeNull();
    expect(decodeMarket(marketVoided.market).winner).toBeNull();
  });

  it('sorts books by outcome so index and outcome agree', () => {
    const shuffled = { ...marketOpen.market, books: [...marketOpen.market.books].reverse() };
    expect(decodeMarket(shuffled).books.map((book) => book.outcome)).toEqual([0, 1]);
  });

  it('maps the schema enums onto this package spelling, and nothing else', () => {
    expect(decodeMarket(marketOpen.market).status).toBe('Open');
    expect(decodeMarket(marketVoided.market).status).toBe('Voided');
    expect(decodeMarket(marketOpen.market).settlerKind).toBe('vested');
    expect(() => decodeMarket({ ...marketOpen.market, status: 'Open' })).toThrow(DecodeError);
    expect(() => decodeMarket({ ...marketOpen.market, status: 'SETTLED' })).toThrow(DecodeError);
    expect(() => decodeMarket({ ...marketOpen.market, settlerKind: 'vested' })).toThrow(DecodeError);
  });

  it('rejects a malformed amount instead of producing NaN', () => {
    expect(() => decodeMarket({ ...marketOpen.market, acceptedPool: '12.5' })).toThrow(DecodeError);
  });

  it('accepts a count typed as either Int or BigInt', () => {
    expect(decodeMarket({ ...marketOpen.market, n: '2' }).outcomeCount).toBe(2);
  });

  it('carries what a settled market settled on', () => {
    const voided = decodeMarket(marketVoided.market);
    expect(voided.voidedStaleAge).toBe(900n);
    expect(voided.resolvedPrice).toBeNull();
    expect(decodeMarket(marketOpen.market).priceUpdatedAt).toBeNull();
  });
});

describe('decodeMarket, open vintage', () => {
  it('derives each book demand from the entries queued against it', () => {
    const market = decodeMarket(marketOpenVintage.market);

    expect(market.vintageOpen).toBe(true);
    expect(market.vintageBlock).toBe(1000n);
    // The one queued entry offers 50 on outcome 1, which is demand against
    // book 0 and against no other book.
    expect(market.books[0]?.demand).toBe(50_000000n);
    expect(market.books[1]?.demand).toBe(0n);
  });

  it('counts an entry as demand against every book but its own', () => {
    const threeWay = {
      ...marketOpenVintage.market,
      n: 3,
      books: [
        ...marketOpenVintage.market.books,
        { outcome: 2, principal: '1000000', vested: '0', capacity: '30000000', capacityIsUnbounded: false, acc: '0' },
      ],
      openVintage: {
        block: '1000',
        offered: '30',
        entryCount: '2',
        entries: [
          { outcome: 0, offered: '10' },
          { outcome: 1, offered: '20' },
        ],
      },
    };
    const books = decodeMarket(threeWay).books;
    expect(books[0]?.demand).toBe(20n);
    expect(books[1]?.demand).toBe(10n);
    expect(books[2]?.demand).toBe(30n);
  });

  it('reports demand as unknown rather than understated when the vintage is truncated', () => {
    const truncated = {
      ...marketOpenVintage.market,
      openVintage: { ...marketOpenVintage.market.openVintage, entryCount: '9' },
    };
    expect(decodeMarket(truncated).books.every((book) => book.demand === null)).toBe(true);
  });

  it('is zero demand, not unknown demand, when no vintage is open', () => {
    expect(decodeMarket(marketOpen.market).vintageOpen).toBe(false);
    expect(decodeMarket(marketOpen.market).books.every((book) => book.demand === 0n)).toBe(true);
  });

  it('is unknown when the query did not ask for the vintage at all', () => {
    const market = decodeMarket(marketLean.market);
    expect(market.vintageOpen).toBeNull();
    expect(market.books.every((book) => book.demand === null)).toBe(true);
  });
});

describe('decodePosition', () => {
  it('follows the owner and vintage relations instead of reading them as scalars', () => {
    const position = decodePosition(positionEarning.position);
    expect(position.owner).toBe('0x4444444444444444444444444444444444444444');
    expect(position.vintage).toBe(101n);
    expect(position.refused).toBe(0n);
    expect(position.previewPayout).toBe(88_333333n);
  });

  it('has no vintage on a classic position, which is not batched by block', () => {
    const classic = { ...positionEarning.position, vintage: null };
    expect(decodePosition(classic).vintage).toBeNull();
  });
});

describe('decodeMeta', () => {
  it('degrades to block zero when the index does not report one', () => {
    expect(decodeMeta(null)).toEqual({ block: 0n, hasIndexingErrors: false });
  });

  it('carries the indexing-error flag through', () => {
    expect(decodeMeta({ block: { number: 42 }, hasIndexingErrors: true })).toEqual({
      block: 42n,
      hasIndexingErrors: true,
    });
  });
});

describe('decodeAgent', () => {
  it('files reputation under the address that did the staking', () => {
    const agent = decodeAgent(agentsByWallet.agents[0], 'agentWallet');
    expect(agent.address).toBe('0x4444444444444444444444444444444444444444');
    expect(agent.owner).toBe('0x7777777777777777777777777777777777777777');
    expect(agent.meanScore).toBe(50);
    expect(agent.agentId).toBe(17n);
  });

  it('files an identity that holds its own NFT under the owner address', () => {
    const agent = decodeAgent(agentsByOwner.agents[0], 'owner');
    expect(agent.address).toBe('0x5555555555555555555555555555555555555555');
    expect(agent.agentWallet).toBeNull();
    // Five entries, one revoked: the mean is over the four that are live.
    expect(agent.feedbackCount).toBe(4);
    expect(agent.meanScore).toBe(90);
  });

  it('reports an agent whose feedback was all revoked as unrated, not as a zero', () => {
    const agent = decodeAgent(agentsUnrated.agents[0], 'agentWallet');
    expect(agent.feedbackCount).toBe(0);
    expect(agent.meanScore).toBeNull();
  });

  it('reads the registry BigDecimal aggregates without forcing them to integers', () => {
    const fractional = { ...agentsByWallet.agents[0], activeFeedbackCount: '3', scoreSum: '13.8', averageScore: '4.6' };
    const agent = decodeAgent(fractional, 'agentWallet');
    expect(agent.meanScore).toBe(4.6);
    expect(agent.scoreSum).toBe('13.8');
  });

  it('rejects a score that is not a number at all', () => {
    const broken = { ...agentsByWallet.agents[0], averageScore: 'n/a' };
    expect(() => decodeAgent(broken, 'agentWallet')).toThrow(DecodeError);
  });
});

describe('sameAddress', () => {
  it('compares regardless of checksum casing', () => {
    expect(sameAddress('0xacC0a0cF13571d30B4b8637996F5D6D774d4fd62', '0xacc0a0cf13571d30b4b8637996f5d6d774d4fd62')).toBe(
      true,
    );
  });
});
