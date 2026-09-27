import { cookies } from 'next/headers';

import type { NetworkId } from './chain';
import { NETWORK_COOKIE, parseNetwork } from './network';
import { DEFAULT_NETWORK } from './wallet/chains';

/**
 * The network this request renders for: the viewer's stored choice, or the
 * deployment's default when there is none or it is junk.
 *
 * Reading a cookie makes the page render per request. That is the point — the
 * same URL shows a different board on each Arc — and it is cheap: the fixture
 * source is local, and the live one is a subgraph read either way.
 */
export async function selectedNetwork(): Promise<NetworkId> {
  const jar = await cookies();
  return parseNetwork(jar.get(NETWORK_COOKIE)?.value) ?? DEFAULT_NETWORK;
}
