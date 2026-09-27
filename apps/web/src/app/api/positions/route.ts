import { NextResponse } from 'next/server';

import { dataSourceFor } from '@/lib/data';
import { encodePositionEntry, type ApiPositions } from '@/lib/data/position-wire';
import { requestNetwork } from '@/lib/data/request-network';

/*
 * Positions for one address. Same shape of decision as /api/claimable: the
 * browser knows the address, the server holds the endpoint and its key, and
 * every bigint crosses as a decimal string. `network` picks the Arc. The wire
 * format is `lib/data/position-wire.ts`, shared with the pages that read it.
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
    const source = dataSourceFor(network);
    const entries = await source.getPositions(address);
    const body: ApiPositions = { source: source.kind, network, entries: entries.map(encodePositionEntry) };
    return NextResponse.json(body, { headers: { 'cache-control': 'private, max-age=5' } });
  } catch (error) {
    console.error('positions lookup failed', error);
    return NextResponse.json({ error: 'The index could not be reached.' }, { status: 502 });
  }
}
