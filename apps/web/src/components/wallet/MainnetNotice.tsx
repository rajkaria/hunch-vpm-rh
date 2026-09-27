'use client';

import { isDeployed } from '@/lib/chain';
import { useNetwork } from '@/lib/wallet/network';

/**
 * What the mainnet side of the toggle needs to say, and only on mainnet.
 *
 * **Before our contracts are on Arc mainnet**, the honest message is that the venue is not there
 * yet: it goes live when Arc mainnet launches, the markets on this side are a sample, and the
 * real venue is on Arc Testnet today. A real-money warning over a sample board would be noise,
 * and a board of sample markets under a "live" banner would be a lie.
 *
 * **Once they are**, it is the unaudited warning. `FeedResolver`, `MarketFactory`,
 * `ClassicParimutuel` and the oracle adapters are new code written for this repository and have
 * never been audited, and they hold user funds. `VestedParimutuel` is vendored from the paper with
 * 118 conformance vectors, which is evidence and not an audit either. That warning is
 * deliberately not dismissible: a warning someone can close stops existing for the person most
 * likely to need it, and the risk does not go away when the banner does.
 *
 * Which one shows follows the address book, so wiring the mainnet deployment (`pnpm
 * wire:mainnet`) is what flips it — nobody has to remember to edit this banner on launch day.
 */
export function MainnetNotice({ deployed }: { deployed?: boolean }) {
  const { network, hydrated, addresses, setNetwork } = useNetwork();

  if (!hydrated || network !== 'mainnet') return null;

  const live = deployed ?? isDeployed(addresses.vestedParimutuel);

  if (!live) {
    return (
      <div role="status" className="mb-6 rounded-card border border-lime/35 bg-lime/10 px-4 py-3.5">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="inline-flex items-center rounded-tag border border-lime/40 bg-lime/15 px-2.5 py-1 text-[11px] leading-none font-semibold tracking-[0.05em] text-lime uppercase">
            Coming to Arc mainnet
          </span>
          <span className="text-sm font-semibold text-paper">
            Hunch VPM goes live on Arc mainnet when Arc mainnet launches.
          </span>
        </div>
        <div className="mt-2 flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
          <p className="max-w-3xl text-sm leading-relaxed text-muted">
            Nothing is deployed on Arc mainnet yet, so the markets on this side are a sample. Every book
            is replayed through the settler&rsquo;s own rules, so the arithmetic is real even though the
            markets are not. The venue is live today on{' '}
            <strong className="font-semibold text-paper">Arc Testnet</strong>, with real markets priced
            by Chainlink.
          </p>
          <button
            type="button"
            onClick={() => setNetwork('testnet')}
            className="shrink-0 rounded-pill bg-lime px-3.5 py-1.5 text-[13px] font-semibold text-ink transition-opacity hover:opacity-90"
          >
            Go to Arc Testnet
          </button>
        </div>
      </div>
    );
  }

  return (
    <div role="alert" className="mb-6 rounded-card border border-coral/40 bg-coral/10 px-4 py-3.5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="inline-flex items-center rounded-tag border border-coral/40 bg-coral/15 px-2.5 py-1 text-[11px] leading-none font-semibold tracking-[0.05em] text-coral uppercase">
          Unaudited
        </span>
        <span className="text-sm font-semibold text-paper">These contracts have not been audited.</span>
      </div>
      <p className="mt-2 max-w-3xl text-sm leading-relaxed text-muted">
        You are on Arc mainnet, where stake is real USDC. The settlement layer here is new code
        that has never been through a security review — a bug in it could lose everything staked,
        and there is no recourse and no operator who can reverse a settlement. The venue holds no
        key and cannot move your funds, but that is a property of the code, and the code is what
        has not been reviewed. Stake nothing you are not prepared to lose outright, and prefer
        <strong className="font-semibold text-paper"> Arc Testnet</strong> if you only want to see
        how it works.
      </p>
    </div>
  );
}
