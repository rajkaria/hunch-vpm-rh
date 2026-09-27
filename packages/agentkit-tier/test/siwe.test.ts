import { describe, expect, it } from 'vitest';
import { encodeBase64Url, encodeProofHeader, parseProofHeader } from '../src/proof.js';
import {
  AGENTKIT_STATEMENT,
  formatSiweMessage,
  isAddressLike,
  isSignatureLike,
  parseChainId,
  parseSiweMessage,
  parseTimestamp,
} from '../src/siwe.js';
import type { Address } from '../src/types.js';

const ADDRESS = '0x70997970c51812dc3a010c7d01b50e0d17dc79c8' as Address;
const SIGNATURE = `0x${'ab'.repeat(65)}` as const;

const base = {
  domain: 'api.hunch.test',
  address: ADDRESS,
  statement: AGENTKIT_STATEMENT,
  uri: 'https://api.hunch.test/v1/markets',
  chainId: 'eip155:480',
  nonce: 'nonce-0123456789abcdef',
  issuedAt: '2023-11-14T22:13:20.000Z',
  expirationTime: '2023-11-14T22:15:20.000Z',
} as const;

describe('formatSiweMessage', () => {
  it('renders the EIP-4361 layout', () => {
    expect(formatSiweMessage(base)).toBe(
      [
        'api.hunch.test wants you to sign in with your Ethereum account:',
        '0x70997970c51812dc3a010c7d01b50e0d17dc79c8',
        '',
        'Verify your agent is backed by a real human',
        '',
        'URI: https://api.hunch.test/v1/markets',
        'Version: 1',
        'Chain ID: eip155:480',
        'Nonce: nonce-0123456789abcdef',
        'Issued At: 2023-11-14T22:13:20.000Z',
        'Expiration Time: 2023-11-14T22:15:20.000Z',
      ].join('\n'),
    );
  });

  it('omits the statement block when there is no statement', () => {
    const message = formatSiweMessage({ ...base, statement: null });
    expect(message.split('\n')[3]).toBe('URI: https://api.hunch.test/v1/markets');
  });

  it('renders the optional fields when given', () => {
    const message = formatSiweMessage({
      ...base,
      notBefore: '2023-11-14T22:14:00.000Z',
      requestId: 'req-1',
      resources: ['https://api.hunch.test/v1/markets/42', 'ipfs://cid'],
    });
    expect(message).toContain('Not Before: 2023-11-14T22:14:00.000Z');
    expect(message).toContain('Request ID: req-1');
    expect(message).toContain('Resources:\n- https://api.hunch.test/v1/markets/42\n- ipfs://cid');
  });
});

describe('parseSiweMessage', () => {
  it('round-trips every field', () => {
    const result = parseSiweMessage(
      formatSiweMessage({
        ...base,
        notBefore: '2023-11-14T22:14:00.000Z',
        requestId: 'req-1',
        resources: ['https://api.hunch.test/v1/markets/42'],
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.fields).toEqual({
      domain: 'api.hunch.test',
      address: ADDRESS,
      statement: AGENTKIT_STATEMENT,
      uri: 'https://api.hunch.test/v1/markets',
      version: '1',
      chainId: 'eip155:480',
      nonce: 'nonce-0123456789abcdef',
      issuedAt: '2023-11-14T22:13:20.000Z',
      expirationTime: '2023-11-14T22:15:20.000Z',
      notBefore: '2023-11-14T22:14:00.000Z',
      requestId: 'req-1',
      resources: ['https://api.hunch.test/v1/markets/42'],
    });
  });

  it('reads a message that carries no statement', () => {
    const result = parseSiweMessage(formatSiweMessage({ ...base, statement: null }));
    if (!result.ok) throw new Error('unreachable');
    expect(result.fields.statement).toBeNull();
    expect(result.fields.uri).toBe(base.uri);
  });

  it('tolerates CRLF line endings, which a proxy or an editor can introduce', () => {
    const result = parseSiweMessage(formatSiweMessage(base).replace(/\n/g, '\r\n'));
    expect(result.ok).toBe(true);
  });

  it('tolerates a trailing newline', () => {
    expect(parseSiweMessage(`${formatSiweMessage(base)}\n`).ok).toBe(true);
  });

  it.each([
    ['an empty string', ''],
    ['prose', 'please sign this'],
    ['a preamble with no domain', ' wants you to sign in with your Ethereum account:\n0x1\n\nURI: x'],
    ['a bad address', 'a.test wants you to sign in with your Ethereum account:\nnope\n\nURI: x'],
    [
      'no blank line after the address',
      `a.test wants you to sign in with your Ethereum account:\n${ADDRESS}\nURI: x`,
    ],
    ['no URI', `a.test wants you to sign in with your Ethereum account:\n${ADDRESS}\n\nVersion: 1`],
  ])('refuses %s', (_label, message) => {
    expect(parseSiweMessage(message).ok).toBe(false);
  });

  it('refuses a field line it cannot split', () => {
    const broken = `${formatSiweMessage(base)}\nDangling`;
    const result = parseSiweMessage(broken);
    expect(result.ok).toBe(false);
  });

  it('refuses a duplicated field rather than picking one', () => {
    const duplicated = `${formatSiweMessage(base)}\nNonce: second-nonce-value`;
    const result = parseSiweMessage(duplicated);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.detail).toContain('twice');
  });
});

describe('parseChainId', () => {
  it.each([
    ['480', 480],
    ['eip155:480', 480],
    ['eip155:8453', 8453],
    [' 480 ', 480],
  ])('reads %s as %s', (raw, expected) => {
    expect(parseChainId(raw)).toBe(expected);
  });

  it.each(['mainnet', 'solana:mainnet', 'eip155:', '', 'eip155:abc'])('refuses %s', (raw) => {
    expect(parseChainId(raw)).toBeNull();
  });
});

describe('parseTimestamp', () => {
  it('reads ISO 8601', () => {
    expect(parseTimestamp('2023-11-14T22:13:20.000Z')).toBe(1_700_000_000_000);
  });

  it('is null for anything it cannot read', () => {
    expect(parseTimestamp('yesterday')).toBeNull();
  });
});

describe('the proof envelope', () => {
  it('round-trips through the header encoding', () => {
    const message = formatSiweMessage(base);
    const result = parseProofHeader(encodeProofHeader({ message, signature: SIGNATURE }));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.envelope).toEqual({ message, signature: SIGNATURE });
  });

  it('reads standard base64 as well as base64url', () => {
    const message = formatSiweMessage(base);
    const json = JSON.stringify({ message, signature: SIGNATURE });
    const standard = Buffer.from(json, 'utf8').toString('base64');

    expect(parseProofHeader(standard).ok).toBe(true);
  });

  it('reports a bad signature as a signature problem, not a malformed envelope', () => {
    const result = parseProofHeader(
      encodeBase64Url(JSON.stringify({ message: formatSiweMessage(base), signature: '0xshort' })),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.code).toBe('signature_malformed');
  });

  it('refuses an envelope whose message is not a readable challenge', () => {
    const result = parseProofHeader(encodeProofHeader({ message: 'hello', signature: SIGNATURE }));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.code).toBe('proof_malformed');
  });

  it('survives non-ASCII text in the message', () => {
    const message = formatSiweMessage({ ...base, statement: 'Проверьте агента' });
    const result = parseProofHeader(encodeProofHeader({ message, signature: SIGNATURE }));
    if (!result.ok) throw new Error('unreachable');
    expect(result.envelope.message).toBe(message);
  });

  it('encodes base64url without padding or url-unsafe characters', () => {
    const encoded = encodeBase64Url('???>>>~~~');
    expect(encoded).not.toContain('=');
    expect(encoded).not.toContain('+');
    expect(encoded).not.toContain('/');
  });
});

describe('shape guards', () => {
  it.each([
    ['0x70997970c51812dc3a010c7d01b50e0d17dc79c8', true],
    ['0x70997970C51812dc3A010C7d01b50e0d17dc79C8', true],
    ['70997970c51812dc3a010c7d01b50e0d17dc79c8', false],
    ['0x709979', false],
    ['', false],
  ])('isAddressLike(%s) is %s', (value, expected) => {
    expect(isAddressLike(value)).toBe(expected);
  });

  it.each([
    [`0x${'ab'.repeat(65)}`, true],
    [`0x${'ab'.repeat(64)}`, false],
    ['0x', false],
  ])('isSignatureLike(...) is %s', (value, expected) => {
    expect(isSignatureLike(value)).toBe(expected);
  });
});
