import type { Metadata } from 'next';

import { ClaimList } from '@/components/claim/ClaimList';

/*
 * The page is a shell. Everything below the header depends on which address is
 * connected, which is a fact only the browser has — so the body is a client
 * island that asks `/api/claimable` for whoever that turns out to be.
 *
 * The lookup stays on the server for one reason: the live source reads The
 * Graph, and a gateway URL carries its API key as a path segment. Fetching from
 * client code would either publish the key or pin this surface to a keyless
 * endpoint forever.
 */

export const metadata: Metadata = {
  title: 'Claim',
  description:
    'Pull settlements, void refunds, refused remainders and residue. One transaction per row.',
};

export default function ClaimPage() {
  return (
    <div>
      <header className="mb-6">
        <h1 className="display-xl text-3xl sm:text-4xl">Claim</h1>
        <p className="mt-3 max-w-2xl text-sm leading-relaxed text-muted">
          Every payout here is pull-based: the settler never pushes money at anyone, so nothing
          depends on a transfer succeeding in a transaction you did not send.
        </p>
      </header>

      <ClaimList />
    </div>
  );
}
