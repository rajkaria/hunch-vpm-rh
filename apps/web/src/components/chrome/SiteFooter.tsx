import Link from 'next/link';

import { HunchMark } from '@/components/brand/HunchLockup';
import { BETA_NOTICE, COUNTRY_NOTICE, LINKS, ROBINHOOD_CHAIN } from '@/lib/site';

const VENUE = [
  { href: '/#markets', label: 'Markets' },
  { href: '/how-it-works', label: 'How it works' },
  { href: '/proof', label: 'Proof' },
  { href: '/start', label: 'Get set up' },
  { href: '/docs', label: 'Docs' },
  { href: '/docs/faq', label: 'FAQ' },
];

const FAMILY = [
  { href: LINKS.hunch, label: 'Hunch', note: 'playhunch.xyz' },
  { href: LINKS.vpm, label: 'Hunch VPM', note: 'vpm.playhunch.xyz' },
  { href: LINKS.paper, label: 'The paper', note: 'Hunch Research' },
  { href: LINKS.github, label: 'GitHub', note: 'Source' },
];

export function SiteFooter() {
  return (
    <footer className="border-t border-edge">
      <div className="mx-auto w-full max-w-[1180px] px-4 py-12 sm:px-6">
        <div className="grid gap-10 md:grid-cols-[1.3fr_1fr_1fr]">
          <div className="max-w-sm">
            <HunchMark className="h-7 w-7" />
            <p className="mt-4 font-display text-xl leading-tight">Call it early. Get paid more.</p>
            <p className="mt-2 text-sm leading-relaxed text-muted">
              Prediction markets on Robinhood Stock Tokens, in USDG on Robinhood Chain. Part of the Hunch family.
            </p>
          </div>

          <nav aria-label="Venue">
            <h2 className="eyebrow">Venue</h2>
            <ul className="mt-2 grid">
              {VENUE.map((item) => (
                <li key={item.href}>
                  <Link href={item.href} className="inline-flex min-h-11 items-center text-sm text-muted transition-colors hover:text-paper">
                    {item.label}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>

          <nav aria-label="Hunch family">
            <h2 className="eyebrow">Hunch family</h2>
            <ul className="mt-2 grid">
              {FAMILY.map((item) => (
                <li key={item.href}>
                  <a
                    href={item.href}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="group inline-flex min-h-11 items-center gap-2 text-sm text-muted transition-colors hover:text-paper"
                  >
                    {item.label}
                    <span className="text-xs text-faint group-hover:text-muted">{item.note}</span>
                  </a>
                </li>
              ))}
            </ul>
          </nav>
        </div>

        <div className="mt-10 grid gap-3 border-t border-edge pt-6 text-xs leading-relaxed text-faint md:grid-cols-2">
          <p>{COUNTRY_NOTICE}</p>
          <p className="md:text-right">{BETA_NOTICE}</p>
          <p>
            Robinhood Chain mainnet · chain id <span className="num">{ROBINHOOD_CHAIN.id}</span> · prices by Chainlink ·
            stakes in USDG
          </p>
          <p className="md:text-right">
            Hunch is not affiliated with Robinhood, Chainlink or Paxos. Stock Tokens are issued by Robinhood; this site
            only reads their prices.
          </p>
        </div>
      </div>
    </footer>
  );
}
