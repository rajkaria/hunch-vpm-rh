import Link from 'next/link';

import { ARC_USDC, NETWORKS, type NetworkId } from '@/lib/chain';
import { WHITEPAPER_URL } from '@/lib/links';

export function SiteFooter({ network }: { network: NetworkId }) {
  const facts = NETWORKS[network].facts;

  return (
    <footer className="border-t border-edge bg-raised">
      <div className="mx-auto flex w-full max-w-[1180px] flex-col gap-6 px-4 py-10 sm:px-6 md:flex-row md:items-start md:justify-between">
        <div className="max-w-sm">
          <img src="/brand/hunch-mark.svg" alt="" aria-hidden width={28} height={28} className="h-7 w-7" />
          <p className="mt-4 font-display text-lg leading-tight">Back your hunch.</p>
          <p className="mt-2 text-sm text-muted">
            A parimutuel that pays for being early instead of pretending timing never happened.
          </p>
        </div>

        <div className="grid grid-cols-2 gap-x-10 gap-y-6 text-sm sm:grid-cols-3">
          <nav aria-label="Surface">
            <h2 className="mb-3 text-xs uppercase tracking-[0.14em] text-faint">Surface</h2>
            <ul className="space-y-2">
              <li>
                <Link href="/" className="text-muted hover:text-paper">
                  Markets
                </Link>
              </li>
              <li>
                <Link href="/agents" className="text-muted hover:text-paper">
                  Agents
                </Link>
              </li>
              <li>
                <Link href="/claim" className="text-muted hover:text-paper">
                  Claim
                </Link>
              </li>
              <li>
                <Link href="/docs" className="text-muted hover:text-paper">
                  How it works
                </Link>
              </li>
            </ul>
          </nav>

          <nav aria-label="Reading">
            <h2 className="mb-3 text-xs uppercase tracking-[0.14em] text-faint">Reading</h2>
            <ul className="space-y-2">
              <li>
                <a
                  href={WHITEPAPER_URL}
                  className="text-muted hover:text-paper"
                  target="_blank"
                  rel="noreferrer noopener"
                >
                  The Vested Parimutuel
                </a>
              </li>
              {/* No link to an explorer this repo has not verified: mainnet's is unpublished. */}
              {facts.explorerUrl === '' ? null : (
                <li>
                  <a
                    href={facts.explorerUrl}
                    className="text-muted hover:text-paper"
                    target="_blank"
                    rel="noreferrer noopener"
                  >
                    Arcscan
                  </a>
                </li>
              )}
            </ul>
          </nav>

          <div>
            <h2 className="mb-3 text-xs uppercase tracking-[0.14em] text-faint">Network</h2>
            <dl className="space-y-2 text-muted">
              <div className="flex gap-2">
                <dt className="sr-only">Chain</dt>
                <dd className="num">{facts.name}</dd>
              </div>
              <div className="flex gap-2">
                <dt className="sr-only">Chain id</dt>
                <dd className="num">{facts.id}</dd>
              </div>
              <div className="flex gap-2">
                <dt className="sr-only">Settlement asset</dt>
                <dd className="num" title={ARC_USDC}>
                  USDC, the native gas token
                </dd>
              </div>
            </dl>
          </div>
        </div>
      </div>
    </footer>
  );
}
