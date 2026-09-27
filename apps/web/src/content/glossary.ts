/**
 * "For the curious": the mechanism's own vocabulary, each term defined in plain words. These
 * are the only terms kept off the first screen and off every button (docs/spec/05-web-app.md).
 */

export interface GlossaryTerm {
  id: string;
  term: string;
  definition: string;
}

export const GLOSSARY: readonly GlossaryTerm[] = [
  {
    id: 'parimutuel',
    term: 'Parimutuel',
    definition:
      'A pool bet: everyone stakes into one pot and the winners share it. There is no bookmaker taking the other side. An ordinary parimutuel splits the pot at the end in proportion to stake, so it pays a last-second dollar the same as a first-minute one.',
  },
  {
    id: 'vested',
    term: 'Vested',
    definition:
      'Paid over, irrevocably. When a bet lands, its stake vests in the people already on the other side: it is theirs if they turn out right, and nothing that happens later can take it back. The design is called the Vested Parimutuel.',
  },
  {
    id: 'kappa',
    term: 'κ (kappa)',
    definition:
      'The capacity multiple: one side can take in at most κ times its own stake from the other side. It is why a huge late bet can be partly refused. This venue runs κ = 30, so the limit rarely binds at beta sizes.',
  },
  {
    id: 'vintage',
    term: 'Vintage',
    definition:
      'All the bets that land in the same block. They are matched together, against the state before any of them, and never pay each other, so the order of transactions inside a block buys nothing. On Robinhood Chain a vintage is about 12 seconds of bets.',
  },
  {
    id: 'accumulator',
    term: 'Accumulator',
    definition:
      "A running total, per side, of how much opposing money has arrived per dollar standing on that side. A bet records the total at the moment it lands; its winnings are its stake times how much the total grew after that. It lets the contract settle any number of bets with constant work.",
  },
  {
    id: 'seed',
    term: 'Seed',
    definition:
      'The opening stake Hunch places on both sides when it lists a market (10 USDG each). The two sides pay each other first, so the seed gets back at least what it put in whichever side wins.',
  },
  {
    id: 'strike-final',
    term: 'Strike and final',
    definition:
      "The two Chainlink prices that decide a market: the strike is the price in effect at the opening bell, the final is the price in effect at the closing bell. UP wins if final is higher, DOWN if lower, and everyone is refunded if they are equal.",
  },
  {
    id: 'accrued',
    term: 'Accrued',
    definition:
      'What a bet would be paid if its side won right now: its stake plus the opposing money that has arrived since. It never goes down while the market is open.',
  },
  {
    id: 'accepted',
    term: 'Accepted and refused',
    definition:
      'The part of a bet the other side can cover is accepted; the rest is refused and returned. Only the accepted part is at risk or earns anything.',
  },
  {
    id: 'price-in-effect',
    term: 'Price in effect at a time',
    definition:
      "The answer of the last Chainlink update at or before that time. Chainlink's stock prices update on 0.5% moves or once a day, so there is almost never an update exactly at the bell.",
  },
  {
    id: 'round',
    term: 'Round',
    definition:
      "One Chainlink price update, with an id, an answer and a timestamp. A settlement cites two round ids, and the contract checks each was the last update before its bell.",
  },
  {
    id: 'void',
    term: 'Refund (void)',
    definition:
      'A market that cannot be settled fairly refunds every bet in full with no fee: when the price did not move, when a price was too old, when the token was paused for a corporate action, or when nobody settled it within 72 hours.',
  },
];
