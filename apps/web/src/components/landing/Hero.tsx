import { ButtonLink } from '@/components/ui/primitives';
import { HERO_SUB } from '@/lib/site';

/**
 * The first screen's words (docs/spec/05-web-app.md): the headline, the sub, one primary action.
 * Plain words only; the copy lint test holds this component to it.
 */
export function Hero({ live }: { live: boolean }) {
  return (
    <div className="max-w-xl">
      <div className="flex flex-wrap items-center gap-2">
        {live ? (
          <span className="inline-flex items-center gap-1.5 rounded-tag border border-lime/35 bg-lime/10 px-2 py-1 text-[11px] leading-none font-semibold tracking-[0.05em] text-lime uppercase">
            <span aria-hidden className="h-1.5 w-1.5 rounded-pill bg-lime motion-safe:animate-pulse" />
            Live on Robinhood Chain
          </span>
        ) : (
          <span className="inline-flex items-center rounded-tag border border-edge-strong bg-paper/4 px-2 py-1 text-[11px] leading-none font-semibold tracking-[0.05em] text-paper uppercase">
            Launching on Robinhood Chain
          </span>
        )}
        <span className="inline-flex items-center rounded-tag border border-edge bg-paper/4 px-2 py-1 text-[11px] leading-none font-semibold tracking-[0.05em] text-muted uppercase">
          USDG · no ETH needed
        </span>
      </div>

      <h1 className="display-xl mt-6 text-[48px] min-[400px]:text-[54px] sm:text-[68px] lg:text-[60px] xl:text-[74px]">
        <span className="block">Call it early.</span>
        <span className="block">
          Get paid more<span className="text-lime">.</span>
        </span>
      </h1>

      <p className="mt-6 max-w-[34rem] text-base leading-relaxed text-muted sm:text-[17px]">{HERO_SUB}</p>

      <div className="mt-8 flex flex-col gap-3 min-[420px]:flex-row min-[420px]:flex-wrap">
        {live ? (
          <ButtonLink href="#markets">See live markets</ButtonLink>
        ) : (
          <ButtonLink href="/start">Get set up in 2 minutes</ButtonLink>
        )}
        <ButtonLink href="/how-it-works" variant="secondary">
          How it works
        </ButtonLink>
      </div>

      <ul className="mt-8 hidden gap-4 text-sm text-muted sm:grid sm:grid-cols-3">
        {['Open until the bell', 'One signature per bet', 'No one types in a price'].map((fact) => (
          <li key={fact} className="flex items-center gap-2">
            <span aria-hidden className="h-1 w-1 shrink-0 rounded-pill bg-paper/40" />
            {fact}
          </li>
        ))}
      </ul>
    </div>
  );
}
