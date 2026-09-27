import { AddressLink } from '@/components/market/AddressLink';
import { Badge } from '@/components/ui/primitives';
import type { ChainFacts } from '@/lib/chain';
import type { MarketDetail } from '@/lib/data/types';
import { formatDuration, formatUtc } from '@/lib/time';
import { formatPrice, shortHex } from '@/lib/units';

/**
 * How this market resolves, in full.
 *
 * Everything a stake is settled against is here: which feed, which strike,
 * which direction, how old a reading is allowed to be, and what happens when
 * it is older than that. The spec is hashed into its own id when it is
 * registered, so none of it can be edited after stake is down — which is the
 * reason it is worth printing rather than summarising.
 */
export function ResolutionPanel({ market, chain }: { market: MarketDetail; chain: ChainFacts }) {
  const spec = market.spec;

  if (spec === null) {
    return (
      <div className="px-4 py-5 text-sm text-muted sm:px-5">
        This market has no resolution spec registered against it. Its settler names a resolver, but nothing has
        told that resolver what to read, so the market can only end by voiding after its timeout.
      </div>
    );
  }

  // Only a market that actually ended this way gets the badge. An open market
  // whose freeze is days away has a "last reading" that is days older than its
  // freeze by construction, and reading that as staleness would put a red
  // warning on every healthy market on the venue.
  const voidedStale =
    market.status === 'Voided' &&
    spec.lastUpdatedAt !== null &&
    market.resolutionTime - spec.lastUpdatedAt > spec.maxStaleness;

  return (
    <div className="px-4 py-5 sm:px-5">
      <dl className="grid gap-x-8 gap-y-5 sm:grid-cols-2">
        <Row label="Feed">
          <span className="num">{spec.feedLabel}</span>
          <span className="num ml-2 text-xs text-faint" title={spec.feedKey}>
            {shortHex(spec.feedKey)}
          </span>
        </Row>

        <Row label="Oracle">
          <span className="text-sm">{spec.oracleName}</span>
          <div className="mt-1">
            <AddressLink address={spec.oracle} chain={chain} />
          </div>
        </Row>

        <Row label="Strike">
          <span className="num">{formatPrice(spec.strike)}</span>
          <span className="ml-2 text-xs text-muted">at 8 decimals, as the oracle reports it</span>
        </Row>

        <Row label="Direction">
          <span className="text-sm">
            {spec.direction === 'above' ? (
              <>
                <span className="text-lime">{market.outcomes[0]?.label ?? 'Outcome 0'}</span> wins at or above the
                strike.
              </>
            ) : (
              <>
                <span className="text-coral">{market.outcomes[0]?.label ?? 'Outcome 0'}</span> wins below the
                strike.
              </>
            )}
          </span>
          <p className="mt-1 text-xs text-muted">
            The boundary is inclusive on the &ldquo;above&rdquo; side: a reading exactly at the strike resolves
            above.
          </p>
        </Row>

        <Row label="Freeze">
          <span className="num">{formatUtc(market.resolutionTime)}</span>
          <p className="mt-1 text-xs text-muted">
            Entries at or after this instant are refused outright. Resolution can only happen from here on, and
            the accumulator is frozen at it either way, so a slow resolver costs nobody anything.
          </p>
        </Row>

        <Row label="Staleness bound">
          <span className="num">{formatDuration(spec.maxStaleness)}</span>
          <p className="mt-1 text-xs text-muted">
            A reading older than this is not trusted. The market voids and every position refunds at its accepted
            principal rather than settling on a number nobody should rely on.
          </p>
        </Row>

        <Row label="Last reading">
          {spec.lastPrice === null || spec.lastUpdatedAt === null ? (
            <span className="text-sm text-muted">The index has not recorded one.</span>
          ) : (
            <>
              <span className="num">{formatPrice(spec.lastPrice)}</span>
              <p className="num mt-1 text-xs text-muted">{formatUtc(spec.lastUpdatedAt)}</p>
            </>
          )}
        </Row>

        <Row label="Spec id">
          <span className="num text-sm" title={spec.specId}>
            {shortHex(spec.specId)}
          </span>
          <p className="mt-1 text-xs text-muted">
            keccak256 of the whole spec. Registering a different strike or bound produces a different id; it does
            not edit this one.
          </p>
        </Row>
      </dl>

      <div className="mt-6 border-t border-edge pt-5">
        <div className="flex flex-wrap items-center gap-3">
          <h3 className="text-sm font-semibold">If the feed goes quiet</h3>
          {voidedStale ? <Badge tone="down">This market voided on a stale feed</Badge> : null}
        </div>
        <p className="mt-2 max-w-prose text-sm leading-relaxed text-muted">
          Resolution is permissionless: anyone may call the resolver once the freeze has passed, and the caller
          has no say in the answer and earns nothing for making the call. If the last reading is older than{' '}
          <span className="num text-paper">{formatDuration(spec.maxStaleness)}</span>, resolution reverts rather
          than settling — so a keeper retrying through a brief outage cannot void a good market by accident.
          Voiding on a stale feed is a separate, deliberate call, and it refunds every position at its accepted
          principal. Failing that, anyone may void the market from{' '}
          <span className="num text-paper">{formatUtc(market.voidableFrom)}</span>.
        </p>
      </div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-[0.12em] text-faint">{label}</dt>
      <dd className="mt-1.5">{children}</dd>
    </div>
  );
}
