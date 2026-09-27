import { Badge } from '@/components/ui/primitives';
import type { MarketStatus, SettlerKind } from '@/lib/data/types';

/**
 * A market is in one of four states a reader cares about, and "Open" is two of
 * them: taking stake, or past its freeze and waiting for someone to resolve it.
 */
export function StatusBadge({ status, frozen }: { status: MarketStatus; frozen: boolean }) {
  if (status === 'Resolved') return <Badge tone="neutral">Resolved</Badge>;
  if (status === 'Voided') return <Badge tone="down">Voided</Badge>;
  if (frozen) return <Badge tone="neutral">Awaiting resolution</Badge>;
  return <Badge tone="up">Open</Badge>;
}

export function SettlerBadge({ kind }: { kind: SettlerKind }) {
  return (
    <Badge
      tone="quiet"
      className={kind === 'vested' ? '' : 'text-faint'}
      // Spelled out rather than abbreviated: which rule a market settles under
      // is the whole difference between the two, and "VPM" means nothing to
      // someone reading their first market page.
    >
      {kind === 'vested' ? 'Vested' : 'Classic pool'}
    </Badge>
  );
}
