import { Badge } from '@/components/ui/primitives';

/**
 * The five states a bettor cares about (docs/spec/05-web-app.md §/m/[id]).
 *
 * - `opens`: listed, before the opening bell sets the strike. Bets are taken.
 * - `live`: the strike is set, bets are taken until the closing bell.
 * - `frozen`: past the bell, waiting for the two Chainlink rounds to settle it.
 * - `resolved`: settled UP or DOWN (the word is always printed).
 * - `void`: refunded in full (flat price, stale price, or a paused token).
 */
export type MarketPhase = 'opens' | 'live' | 'frozen' | 'resolved' | 'void';

export function StatusBadge({ phase, winner }: { phase: MarketPhase; winner?: 'UP' | 'DOWN' | undefined }) {
  switch (phase) {
    case 'opens':
      return <Badge tone="note">Opens</Badge>;
    case 'live':
      return (
        <Badge tone="up">
          <span aria-hidden className="h-1.5 w-1.5 rounded-pill bg-lime motion-safe:animate-pulse" />
          Live
        </Badge>
      );
    case 'frozen':
      return <Badge tone="neutral">Frozen</Badge>;
    case 'resolved':
      return <Badge tone={winner === 'DOWN' ? 'down' : 'up'}>Resolved {winner ?? ''}</Badge>;
    case 'void':
      return <Badge tone="quiet">Void · refunded</Badge>;
  }
}
