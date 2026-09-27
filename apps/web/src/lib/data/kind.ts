import type { NetworkId } from '@/lib/chain';
import { dataSourceFor } from '@/lib/data';

/**
 * Each network's source kind, importable from client code.
 *
 * A client component that has to say whether it is looking at fixtures reads
 * this with the network from `useNetwork()`: one network can be live while the
 * other still serves the sample dataset.
 */
export const dataSourceKinds: Record<NetworkId, 'fixture' | 'live'> = {
  testnet: dataSourceFor('testnet').kind,
  mainnet: dataSourceFor('mainnet').kind,
};
