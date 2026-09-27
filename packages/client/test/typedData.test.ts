import { encodeAbiParameters, hashTypedData, keccak256, toBytes, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';
import {
  ENTER_TYPEHASH,
  UP,
  USDG_ADDRESS,
  USDG_DOMAIN_SEPARATOR,
  USDG_EIP712_DOMAIN,
  buildEnterAuthorization,
  enterNonce,
  randomSalt,
  recoverEnterSigner,
  usdgDomainSeparator,
  validityWindow,
} from '../src/index.js';

const VPM = '0x1111111111111111111111111111111111111111' as const;

describe('USDG EIP-712 domain (hardcoded; USDG has no eip712Domain())', () => {
  it('hashes to the on-chain DOMAIN_SEPARATOR 0x7a3d…2036', () => {
    expect(USDG_DOMAIN_SEPARATOR).toBe('0x7a3d7400b27830f4f91c2c16a082486d67c1befecaec2f53b33f1f35d5b62036');
    expect(usdgDomainSeparator()).toBe(USDG_DOMAIN_SEPARATOR);
    expect(USDG_EIP712_DOMAIN).toEqual({ name: 'Global Dollar', version: '1', chainId: 4663, verifyingContract: USDG_ADDRESS });
  });

  it('uses the canonical ReceiveWithAuthorization type (matches USDG.RECEIVE_WITH_AUTHORIZATION_TYPEHASH 0xd099cc98…413de8)', () => {
    const h = keccak256(
      toBytes('ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)'),
    );
    expect(h.startsWith('0xd099cc98')).toBe(true);
    expect(h.endsWith('413de8')).toBe(true);
  });
});

describe('enterNonce', () => {
  it('is keccak256(abi.encode(ENTER_TYPEHASH, chainId, hunchVpm, marketId, outcome, amount, salt))', () => {
    const salt = `0x${'ab'.repeat(32)}` as Hex;
    const expected = keccak256(
      encodeAbiParameters(
        [{ type: 'bytes32' }, { type: 'uint256' }, { type: 'address' }, { type: 'uint256' }, { type: 'uint8' }, { type: 'uint256' }, { type: 'bytes32' }],
        [ENTER_TYPEHASH, 4663n, VPM, 7n, 1, 25_000_000n, salt],
      ),
    );
    expect(enterNonce({ hunchVpm: VPM, marketId: 7n, outcome: 1, amount: 25_000_000n, salt })).toBe(expected);
    expect(ENTER_TYPEHASH).toBe(keccak256(toBytes('HunchEnter(uint256 marketId,uint8 outcome,uint256 amount,bytes32 salt)')));
  });

  it('binds market, side, amount, salt, contract and chain', () => {
    const base = { hunchVpm: VPM, marketId: 1n, outcome: 0, amount: 5n, salt: randomSalt() };
    const n = enterNonce(base);
    expect(enterNonce({ ...base, marketId: 2n })).not.toBe(n);
    expect(enterNonce({ ...base, outcome: 1 })).not.toBe(n);
    expect(enterNonce({ ...base, amount: 6n })).not.toBe(n);
    expect(enterNonce({ ...base, salt: randomSalt() })).not.toBe(n);
    expect(enterNonce({ ...base, hunchVpm: '0x2222222222222222222222222222222222222222' })).not.toBe(n);
    expect(enterNonce({ ...base, chainId: 1 })).not.toBe(n);
  });
});

describe('buildEnterAuthorization', () => {
  it('produces USDG typed data with to = HunchVPM that a wallet signature recovers to from', async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const salt = randomSalt();
    const { validAfter, validBefore } = validityWindow(1_790_000_000, 1800);
    const auth = buildEnterAuthorization({
      from: account.address,
      hunchVpm: VPM,
      marketId: 3n,
      outcome: UP,
      amount: 2_000_000n,
      validAfter,
      validBefore,
      salt,
    });
    expect(auth.primaryType).toBe('ReceiveWithAuthorization');
    expect(auth.message).toMatchObject({ from: account.address, to: VPM, value: 2_000_000n, validAfter: 0n, validBefore: 1_790_001_800n });
    expect(auth.message.nonce).toBe(enterNonce({ hunchVpm: VPM, marketId: 3n, outcome: UP, amount: 2_000_000n, salt }));
    const signature = await account.signTypedData(auth);
    expect(await recoverEnterSigner(auth, signature)).toBe(account.address);
    // The digest is built on USDG's separator.
    expect(hashTypedData(auth)).toMatch(/^0x[0-9a-f]{64}$/);
    // A tampered amount recovers someone else.
    const tampered = { ...auth, message: { ...auth.message, value: 3_000_000n } };
    expect(await recoverEnterSigner(tampered, signature)).not.toBe(account.address);
  });

  it('randomSalt returns 32 fresh bytes', () => {
    const a = randomSalt();
    expect(a).toMatch(/^0x[0-9a-f]{64}$/);
    expect(randomSalt()).not.toBe(a);
  });
});
