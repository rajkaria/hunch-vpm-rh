import { NextResponse } from 'next/server';

import { dataSourceFor } from '@/lib/data';
import { requestNetwork } from '@/lib/data/request-network';
import type { ClaimableView } from '@/lib/data/types';

/*
 * Claimables for one address.
 *
 * The claim page has to read whatever address is connected, which is a fact
 * only the browser knows — but the read itself must NOT move into the browser.
 * The live source talks to The Graph, and a gateway URL carries its API key as
 * a path segment; fetching from client code would either publish that key or
 * force the surface onto a keyless endpoint forever. So the browser sends an
 * address and the server does the lookup.
 *
 * `network` picks the Arc (default: the deployment's), because each reads its
 * own index and a wallet's claims on one are nothing on the other.
 *
 * bigint does not survive JSON, so every amount crosses as a decimal string and
 * the client parses it straight back. Losing precision on a claimable balance
 * would be a bug report.
 */

export const dynamic = 'force-dynamic';

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export async function GET(request: Request) {
  const address = new URL(request.url).searchParams.get('address');

  if (address === null || !ADDRESS.test(address)) {
    return NextResponse.json({ error: 'A 20-byte hex address is required.' }, { status: 400 });
  }

  const network = requestNetwork(request);
  if (network === null) {
    return NextResponse.json({ error: 'network must be testnet or mainnet.' }, { status: 400 });
  }

  try {
    const view = await dataSourceFor(network).getClaimable(address);
    return NextResponse.json({ ...encode(view), network }, {
      // Per-address and short-lived. Never shared: two visitors must not see
      // each other's positions out of a cache.
      headers: { 'cache-control': 'private, max-age=5' },
    });
  } catch (error) {
    // The message may name an endpoint. Log it, do not return it.
    console.error('claimable lookup failed', error);
    return NextResponse.json({ error: 'The index could not be reached.' }, { status: 502 });
  }
}

/** Every bigint to a decimal string, in place, so nothing is rounded on the way out. */
function encode(view: ClaimableView) {
  return {
    wallet: view.wallet,
    totals: Object.fromEntries(
      Object.entries(view.totals).map(([key, value]) => [key, value.toString()]),
    ),
    blockedResidue: view.blockedResidue.map((entry) => ({
      ...entry,
      amount: entry.amount.toString(),
    })),
    index: { ...view.index, block: view.index.block.toString() },
    items: view.items.map((item) => ({
      ...item,
      amount: item.amount.toString(),
      argument: item.argument.toString(),
      breakdown: Object.fromEntries(
        Object.entries(item.breakdown).map(([key, value]) => [key, value.toString()]),
      ),
    })),
  };
}
