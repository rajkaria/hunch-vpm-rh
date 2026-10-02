import { ButtonLink, FactStrip } from '@/components/ui/primitives';
import { readDeployment } from '@/lib/deployment';
import { HERO_SUB } from '@/lib/site';
import { formatAmount } from '@/lib/units';

/**
 * The first screen's words (docs/spec/05-web-app.md): the headline, the sub, one primary action,
 * then three facts in the strip the Hunch landing page uses. Plain words only; the copy lint
 * test holds this component to it.
 *
 * `liveCount` is the number of markets taking bets right now, from the same chain read as the
 * grid below. It shows, and the primary action says "live", only while at least one is taking
 * bets: between markets the strip says when bets close instead of counting zero. Bet limits come
 * from the deployment.
 */
export function Hero({ live, liveCount = 0 }: { live: boolean; liveCount?: number }) {
  const { params, feeds } = readDeployment();
  const tickers = feeds.filter((feed) => feed.families.length > 0).map((feed) => feed.ticker);
  const min = formatAmount(BigInt(params.minEntry), { fractionDigits: 0 });
  const max = formatAmount(BigInt(params.maxEntry), { fractionDigits: 0 });

  return (
    <div className="min-w-0 max-w-xl">
      <p className="inline-flex max-w-full items-center gap-2.5 rounded-control border border-lime/30 bg-lime/[0.06] py-1.5 pr-3.5 pl-1.5 text-sm text-paper/80">
        {live ? (
          <span className="inline-flex shrink-0 items-center gap-1.5 rounded-tag border border-lime/30 px-2 py-0.5 text-[11px] font-semibold tracking-[0.06em] text-lime uppercase">
            <span aria-hidden className="h-1.5 w-1.5 rounded-pill bg-lime motion-safe:animate-pulse" />
            Live on Robinhood Chain
          </span>
        ) : (
          <span className="shrink-0 rounded-tag border border-lime/30 px-2 py-0.5 text-[11px] font-semibold tracking-[0.06em] text-lime uppercase">
            Launching on Robinhood Chain
          </span>
        )}
        <span className="hidden min-w-0 truncate sm:inline">{tickers.join(' · ')}</span>
      </p>

      <h1 className="display-xl mt-7 text-[48px] min-[400px]:text-[54px] sm:text-[68px] lg:text-[60px] xl:text-[72px]">
        <span className="block">Call it early.</span>
        <span className="block">
          Get paid more<span className="text-lime">.</span>
        </span>
      </h1>

      <p className="mt-5 max-w-[34rem] text-base leading-relaxed text-muted sm:text-[17px]">{HERO_SUB}</p>

      <div className="mt-7 flex flex-col gap-3 min-[420px]:flex-row min-[420px]:flex-wrap">
        {live ? (
          <ButtonLink href="#markets">{liveCount > 0 ? 'See live markets' : 'See the markets'}</ButtonLink>
        ) : (
          <ButtonLink href="/start">Get set up in 2 minutes</ButtonLink>
        )}
        <ButtonLink href="/how-it-works" variant="secondary">
          How it works
        </ButtonLink>
      </div>

      <FactStrip
        className="mt-8"
        label="Hunch on Robinhood Chain in three facts"
        facts={[
          live && liveCount > 0
            ? { label: 'Live now', live: true, value: <span className="num font-normal text-lime">{liveCount}</span> }
            : { label: 'Bets close', value: 'At the bell' },
          {
            label: 'Per bet',
            value: (
              <>
                <span className="num font-normal">
                  {min}–{max}
                </span>{' '}
                <span className="text-xs font-normal text-faint">USDG</span>
              </>
            ),
          },
          { label: 'ETH needed', value: 'None' },
        ]}
      />
    </div>
  );
}
