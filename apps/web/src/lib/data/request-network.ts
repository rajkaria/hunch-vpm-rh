import type { NetworkId } from '../chain';
import { parseNetwork } from '../network';
import { DEFAULT_NETWORK } from '../wallet/chains';

/**
 * The `network` query parameter of a per-address route.
 *
 * Absent means the deployment's default. Present but not an Arc is `null`,
 * which the route turns into a 400: answering a typo with testnet data would
 * show someone the wrong chain's positions under the right chain's name.
 */
export function requestNetwork(request: Request): NetworkId | null {
  const raw = new URL(request.url).searchParams.get('network');
  return raw === null ? DEFAULT_NETWORK : parseNetwork(raw);
}
