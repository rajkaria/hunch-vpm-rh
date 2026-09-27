/**
 * The powers table, verbatim from docs/spec/03-contracts.md §"Powers, stated once" (the README
 * carries the same table). `**bold**` in the spec is kept as `strong` segments.
 */

export interface PowerRow {
  who: string;
  /** Segments: plain strings, or `{ strong }` for the spec's bold. */
  can: (string | { strong: string })[];
  cannot: string;
}

export const POWERS: readonly PowerRow[] = [
  {
    who: 'Safe (guardian of HunchVPM)',
    can: ['pause ', { strong: 'new entries' }],
    cannot: 'pause or block claims, refunds, resolution; move any stake; set any price',
  },
  {
    who: 'Safe (owner of factory)',
    can: ['allow-list a feed, its Stock Token and its staleness bounds; add/remove an opener'],
    cannot: "change a listed market's feed, times, bounds, seed, fee or caps",
  },
  {
    who: 'Opener (keeper hot wallet)',
    can: ['list a new market, paying the seed itself; owns the seed legs it paid for'],
    cannot: "change or close an existing market; touch anyone else's position",
  },
  {
    who: 'Anyone',
    can: [
      "resolve with the two proven rounds; void on proven staleness or a 24 h oracle pause; relay a bettor's signed entry; deliver claims and refunds to owners; sweep fees to the treasury",
    ],
    cannot: "choose the outcome; send anyone's funds anywhere but to their owner",
  },
  {
    who: 'StockRoundResolver',
    can: ['settle its registered markets per the spec'],
    cannot: 'anything else (it has no owner)',
  },
];
