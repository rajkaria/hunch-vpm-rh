import { describe, expect, it } from 'vitest';

import { ARC_MAINNET_ADDRESSES, ARC_TESTNET_ADDRESSES } from '../src/lib/chain';
import { oracleNameFor } from '../src/lib/data/live';

describe('oracleNameFor', () => {
  it('names the Chainlink CRE relay that Arc testnet markets resolve through', () => {
    expect(oracleNameFor(ARC_TESTNET_ADDRESSES.chainlinkCreOracle.toLowerCase(), ARC_TESTNET_ADDRESSES)).toBe(
      'Chainlink Data Feed, relayed by Chainlink CRE',
    );
  });

  it('still names the Stork adapter from the original deploy', () => {
    expect(oracleNameFor(ARC_TESTNET_ADDRESSES.priceOracle, ARC_TESTNET_ADDRESSES)).toBe(
      'Stork, through the IPriceOracle adapter',
    );
  });

  it('never names a provider for an address the network did not deploy', () => {
    // Mainnet's adapters are all the zero placeholder; a spec pointing at zero is not "Chainlink".
    expect(oracleNameFor('0x0000000000000000000000000000000000000000', ARC_MAINNET_ADDRESSES)).toBe(
      'Oracle adapter at 0x0000000000000000000000000000000000000000',
    );
    expect(oracleNameFor('0x1111111111111111111111111111111111111111', ARC_TESTNET_ADDRESSES)).toBe(
      'Oracle adapter at 0x1111111111111111111111111111111111111111',
    );
  });
});
