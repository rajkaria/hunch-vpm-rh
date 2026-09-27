import { describe, expect, it } from 'vitest';
import { normalizeHeaders } from '../src/headers.js';
import { encodeProofHeader } from '../src/proof.js';
import { formatSiweMessage } from '../src/siwe.js';
import { InMemoryTierStorage } from '../src/storage.js';
import { AgentTierConfigurationError, createAgentTierVerifier } from '../src/verify.js';
import type { Address, AnonymousVerification, HeaderSource, VerificationResult } from '../src/types.js';
import {
  CHAIN_ID,
  Clock,
  DOMAIN,
  HUMAN_ID,
  PATH,
  URI,
  createHarness,
  defaultAgentBook,
  failingAgentBook,
  headerFor,
  impostor,
  makeProof,
  nonceStoreDown,
  registeredAgent,
  requestFor,
  revokedAgent,
  unregisteredAgent,
} from './support/harness.js';

function asAnonymous(result: VerificationResult): AnonymousVerification {
  if (result.tier !== 'anonymous') {
    throw new Error(`expected anonymous, got human-backed for ${result.identity.wallet}`);
  }
  return result;
}

describe('createAgentTierVerifier configuration', () => {
  const base = {
    agentBook: defaultAgentBook(),
    storage: new InMemoryTierStorage(),
    domain: DOMAIN,
  } as const;

  it('refuses an empty domain', () => {
    expect(() => createAgentTierVerifier({ ...base, domain: '   ' })).toThrow(AgentTierConfigurationError);
  });

  it('refuses a chain AgentKit does not sign on', () => {
    // 5042002 is Arc testnet, where the venue lives. Agents do not sign proofs there.
    expect(() => createAgentTierVerifier({ ...base, acceptedChainIds: [5042002] })).toThrow(
      AgentTierConfigurationError,
    );
  });

  it('refuses an empty chain list, which would refuse every proof silently', () => {
    expect(() => createAgentTierVerifier({ ...base, acceptedChainIds: [] })).toThrow(
      AgentTierConfigurationError,
    );
  });

  it.each([
    ['maxProofLifetimeSeconds', { maxProofLifetimeSeconds: 0 }],
    ['maxProofAgeSeconds', { maxProofAgeSeconds: -1 }],
    ['clockSkewSeconds', { clockSkewSeconds: -1 }],
    ['proofHeader', { proofHeader: '' }],
  ])('refuses a nonsensical %s', (_label, patch) => {
    expect(() => createAgentTierVerifier({ ...base, ...patch })).toThrow(AgentTierConfigurationError);
  });
});

describe('a proof that holds up', () => {
  it('establishes a human-backed identity', async () => {
    const { verifier, clock } = createHarness();
    const proof = await makeProof(clock);

    const result = await verifier.verify(requestFor(proof.headers));

    expect(result.tier).toBe('human-backed');
    if (result.tier !== 'human-backed') throw new Error('unreachable');
    expect(result.identity.wallet).toBe(registeredAgent.address.toLowerCase());
    expect(result.identity.humanId).toBe(HUMAN_ID);
    expect(result.identity.chainId).toBe(CHAIN_ID);
    expect(result.presented).toBe(true);
    expect(result.proof.fields.domain).toBe(DOMAIN);
    expect(result.proof.fields.statement).toBe('Verify your agent is backed by a real human');
  });

  it.each([
    ['a fetch Headers', (h: Record<string, string>): HeaderSource => new Headers(h)],
    ['a Map', (h: Record<string, string>): HeaderSource => new Map(Object.entries(h))],
    [
      'a Node record with upper-case names and array values',
      (h: Record<string, string>): HeaderSource =>
        Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toUpperCase(), [v]])),
    ],
  ])('reads the proof out of %s', async (_label, shape) => {
    const { verifier, clock } = createHarness();
    const proof = await makeProof(clock);

    const result = await verifier.verify({
      headers: shape(proof.headers as Record<string, string>),
      path: PATH,
    });

    expect(result.tier).toBe('human-backed');
  });

  it('reads a bare integer Chain ID as well as the CAIP-2 form', async () => {
    const { verifier, clock } = createHarness();
    const proof = await makeProof(clock, { caip2ChainId: false });

    expect(proof.message).toContain('Chain ID: 480');
    expect((await verifier.verify(requestFor(proof.headers))).tier).toBe('human-backed');
  });

  it('accepts a Base-signed proof, because AgentBook is read on World Chain either way', async () => {
    const { verifier, clock } = createHarness();
    const proof = await makeProof(clock, { chainId: 8453 });

    const result = await verifier.verify(requestFor(proof.headers));

    expect(result.tier).toBe('human-backed');
    if (result.tier !== 'human-backed') throw new Error('unreachable');
    expect(result.identity.chainId).toBe(8453);
  });

  it('accepts a raw JSON envelope, so a proof can be hand-edited with curl', async () => {
    const { verifier, clock } = createHarness();
    const proof = await makeProof(clock);

    const result = await verifier.verify({
      headers: { agentkit: JSON.stringify({ message: proof.message, signature: proof.signature }) },
      path: PATH,
    });

    expect(result.tier).toBe('human-backed');
  });

  it('reads the proof from a renamed header when one is configured', async () => {
    const { verifier, clock } = createHarness({ proofHeader: 'x-world-agentkit' });
    const proof = await makeProof(clock, { headerName: 'x-world-agentkit' });

    expect((await verifier.verify(requestFor(proof.headers))).tier).toBe('human-backed');
  });
});

describe('absent and malformed headers', () => {
  it('treats no header at all as an ordinary anonymous caller, not as a failure', async () => {
    const { verifier } = createHarness();

    const result = asAnonymous(await verifier.verify({ headers: {} }));

    expect(result.reason).toBe('no_proof_presented');
    expect(result.presented).toBe(false);
  });

  it('treats a whitespace-only header as no header at all', async () => {
    const { verifier } = createHarness();

    const result = asAnonymous(await verifier.verify({ headers: { agentkit: '   ' } }));

    expect(result.reason).toBe('no_proof_presented');
  });

  it('rejects the proof header supplied twice with conflicting values', async () => {
    const { verifier, clock } = createHarness();
    const proof = await makeProof(clock);

    const result = asAnonymous(
      await verifier.verify({ headers: { agentkit: [proof.headers.agentkit as string, 'other'] } }),
    );

    expect(result.reason).toBe('headers_malformed');
    expect(result.presented).toBe(true);
  });

  // `presented` is what `onInvalidProof: 'reject'` turns into a 401, so it has to mean
  // "this caller tried" and nothing else.
  it('says nothing was presented when some unrelated header arrived twice', async () => {
    const { verifier } = createHarness();

    const result = asAnonymous(
      await verifier.verify({ headers: { accept: ['application/json', 'text/html'] } }),
    );

    expect(result.reason).toBe('no_proof_presented');
    expect(result.presented).toBe(false);
  });

  it('verifies from a map somebody else already normalised', async () => {
    const { verifier, clock } = createHarness();
    const proof = await makeProof(clock);

    const result = await verifier.verifyNormalized(normalizeHeaders(proof.headers), {
      headers: {},
      path: PATH,
    });

    expect(result.tier).toBe('human-backed');
  });

  it.each([
    ['not base64 at all', '!!!!not base64!!!!'],
    ['base64 of something that is not JSON', Buffer.from('hello').toString('base64url')],
    ['base64 of a JSON array', Buffer.from('[1,2,3]').toString('base64url')],
    ['an envelope with no message', Buffer.from('{"signature":"0x00"}').toString('base64url')],
  ])('reports %s as a malformed proof', async (_label, value) => {
    const { verifier } = createHarness();

    const result = asAnonymous(await verifier.verify({ headers: { agentkit: value }, path: PATH }));

    expect(result.reason).toBe('proof_malformed');
  });

  it.each([
    ['not hex', 'deadbeef'],
    ['too short', '0xdeadbeef'],
    ['64 bytes rather than 65', `0x${'11'.repeat(64)}`],
  ])('rejects a signature that is %s', async (_label, signature) => {
    const { verifier, clock } = createHarness();
    const proof = await makeProof(clock);
    const header = encodeProofHeader({ message: proof.message, signature: signature as `0x${string}` });

    const result = asAnonymous(await verifier.verify({ headers: { agentkit: header }, path: PATH }));

    expect(result.reason).toBe('signature_malformed');
  });

  it.each([
    ['no preamble line', 'hello world'],
    ['no address line', `${DOMAIN} wants you to sign in with your Ethereum account:\nnot-an-address\n\nURI: ${URI}`],
    [
      'no blank line after the address',
      `${DOMAIN} wants you to sign in with your Ethereum account:\n${registeredAgent.address}\nURI: ${URI}`,
    ],
    ['no URI field', `${DOMAIN} wants you to sign in with your Ethereum account:\n${registeredAgent.address}\n\n`],
  ])('rejects a signed message with %s', async (_label, message) => {
    const { verifier } = createHarness();

    const result = asAnonymous(
      await verifier.verify({ headers: await headerFor(message, registeredAgent), path: PATH }),
    );

    expect(result.reason).toBe('proof_malformed');
  });

  it.each([
    ['a Chain ID that is not a chain id', { chainId: 'mainnet' }],
    ['an Issued At that is not a timestamp', { issuedAt: 'yesterday' }],
    ['an Expiration Time that is not a timestamp', { expirationTime: 'soon' }],
    ['a Not Before that is not a timestamp', { notBefore: 'later' }],
    ['no Expiration Time at all', { expirationTime: null }],
  ])('rejects a message with %s', async (_label, patch) => {
    const { verifier, clock } = createHarness();
    const message = formatSiweMessage({
      domain: DOMAIN,
      address: registeredAgent.address.toLowerCase() as Address,
      uri: URI,
      chainId: 'eip155:480',
      nonce: 'nonce-0123456789abcdef',
      issuedAt: new Date(clock.nowMs).toISOString(),
      expirationTime: new Date(clock.nowMs + 120_000).toISOString(),
      ...patch,
    });

    const result = asAnonymous(
      await verifier.verify({ headers: await headerFor(message, registeredAgent), path: PATH }),
    );

    expect(result.reason).toBe('proof_malformed');
  });

  it('rejects a message whose expiry precedes its issuance', async () => {
    const { verifier, clock } = createHarness();
    const message = formatSiweMessage({
      domain: DOMAIN,
      address: registeredAgent.address.toLowerCase() as Address,
      uri: URI,
      chainId: 'eip155:480',
      nonce: 'nonce-0123456789abcdef',
      issuedAt: new Date(clock.nowMs).toISOString(),
      expirationTime: new Date(clock.nowMs - 1_000).toISOString(),
    });

    const result = asAnonymous(
      await verifier.verify({ headers: await headerFor(message, registeredAgent), path: PATH }),
    );

    expect(result.reason).toBe('proof_malformed');
  });

  it('rejects a message from a version it does not read', async () => {
    const { verifier, clock } = createHarness();
    const message = formatSiweMessage({
      domain: DOMAIN,
      address: registeredAgent.address.toLowerCase() as Address,
      uri: URI,
      version: '2',
      chainId: 'eip155:480',
      nonce: 'nonce-0123456789abcdef',
      issuedAt: new Date(clock.nowMs).toISOString(),
      expirationTime: new Date(clock.nowMs + 120_000).toISOString(),
    });

    const result = asAnonymous(
      await verifier.verify({ headers: await headerFor(message, registeredAgent), path: PATH }),
    );

    expect(result.reason).toBe('proof_unsupported_version');
  });
});

describe('proof scope', () => {
  it('rejects a proof minted for a different server', async () => {
    const { verifier, clock } = createHarness();
    const proof = await makeProof(clock, { domain: 'someone-else.test', uri: 'https://someone-else.test/v1/markets' });

    const result = asAnonymous(await verifier.verify(requestFor(proof.headers)));

    expect(result.reason).toBe('proof_domain_mismatch');
  });

  it('rejects a proof signed on a chain this server does not accept', async () => {
    const { verifier, clock } = createHarness({ acceptedChainIds: [480] });
    const proof = await makeProof(clock, { chainId: 8453 });

    const result = asAnonymous(await verifier.verify(requestFor(proof.headers)));

    expect(result.reason).toBe('proof_chain_unsupported');
  });

  it('rejects a proof for a different resource', async () => {
    const { verifier, clock } = createHarness();
    const proof = await makeProof(clock, { uri: `https://${DOMAIN}/v1/markets/42` });

    const result = asAnonymous(await verifier.verify({ headers: proof.headers, path: PATH }));

    expect(result.reason).toBe('proof_uri_mismatch');
  });

  it('ignores a query string when comparing the resource', async () => {
    const { verifier, clock } = createHarness();
    const proof = await makeProof(clock, { uri: `https://${DOMAIN}${PATH}?limit=10` });

    expect((await verifier.verify({ headers: proof.headers, path: PATH })).tier).toBe('human-backed');
  });

  it('skips the resource check when the caller supplies no path', async () => {
    const { verifier, clock } = createHarness();
    const proof = await makeProof(clock);

    expect((await verifier.verify({ headers: proof.headers })).tier).toBe('human-backed');
  });

  it('refuses to skip the resource check when told to require it', async () => {
    const { verifier, clock } = createHarness({ requireUriMatch: true });
    const proof = await makeProof(clock);

    const result = asAnonymous(await verifier.verify({ headers: proof.headers }));

    expect(result.reason).toBe('proof_uri_mismatch');
  });
});

describe('proof lifetime', () => {
  it('rejects an expired proof', async () => {
    const { verifier, clock } = createHarness();
    const proof = await makeProof(clock, { lifetimeSeconds: 60 });

    clock.advanceSeconds(61);
    expect(asAnonymous(await verifier.verify(requestFor(proof.headers))).reason).toBe('proof_expired');
  });

  it('accepts a proof one second before it expires', async () => {
    const { verifier, clock } = createHarness();
    const proof = await makeProof(clock, { lifetimeSeconds: 60 });

    clock.advanceSeconds(59);
    expect((await verifier.verify(requestFor(proof.headers))).tier).toBe('human-backed');
  });

  it('rejects a proof issued further ahead than the allowed clock skew', async () => {
    const { verifier, clock } = createHarness({ clockSkewSeconds: 30 });
    const proof = await makeProof(clock, { issuedAtMs: clock.nowMs + 31_000 });

    expect(asAnonymous(await verifier.verify(requestFor(proof.headers))).reason).toBe('proof_not_yet_valid');
  });

  it('tolerates a client clock inside the skew allowance', async () => {
    const { verifier, clock } = createHarness({ clockSkewSeconds: 30 });
    const proof = await makeProof(clock, { issuedAtMs: clock.nowMs + 29_000 });

    expect((await verifier.verify(requestFor(proof.headers))).tier).toBe('human-backed');
  });

  it('rejects a message whose Not Before has not been reached', async () => {
    const { verifier, clock } = createHarness();
    const message = formatSiweMessage({
      domain: DOMAIN,
      address: registeredAgent.address.toLowerCase() as Address,
      uri: URI,
      chainId: 'eip155:480',
      nonce: 'nonce-0123456789abcdef',
      issuedAt: new Date(clock.nowMs).toISOString(),
      expirationTime: new Date(clock.nowMs + 120_000).toISOString(),
      notBefore: new Date(clock.nowMs + 90_000).toISOString(),
    });

    const result = asAnonymous(
      await verifier.verify({ headers: await headerFor(message, registeredAgent), path: PATH }),
    );

    expect(result.reason).toBe('proof_not_yet_valid');
  });

  it('rejects a proof that would sit in the nonce store for longer than we retain', async () => {
    const { verifier, clock } = createHarness({ maxProofLifetimeSeconds: 300 });
    const proof = await makeProof(clock, { lifetimeSeconds: 3600 });

    expect(asAnonymous(await verifier.verify(requestFor(proof.headers))).reason).toBe(
      'proof_lifetime_too_long',
    );
  });

  it('rejects a long-lived proof minted long ago, even before it expires', async () => {
    const { verifier, clock } = createHarness({ maxProofLifetimeSeconds: 1_800, maxProofAgeSeconds: 300 });
    const proof = await makeProof(clock, { lifetimeSeconds: 1_800 });

    clock.advanceSeconds(600);

    expect(asAnonymous(await verifier.verify(requestFor(proof.headers))).reason).toBe('proof_stale');
  });
});

describe('signatures', () => {
  it('rejects a well-formed signature that recovers to nobody useful', async () => {
    const { verifier, clock } = createHarness();
    const proof = await makeProof(clock);
    const header = encodeProofHeader({ message: proof.message, signature: `0x${'00'.repeat(65)}` });

    const result = asAnonymous(await verifier.verify({ headers: { agentkit: header }, path: PATH }));

    expect(['signature_malformed', 'signature_mismatch']).toContain(result.reason);
  });

  it('rejects a message signed by a key that is not the address it names', async () => {
    const { verifier, clock } = createHarness();
    const proof = await makeProof(clock, { signAs: impostor });

    const result = asAnonymous(await verifier.verify(requestFor(proof.headers)));

    expect(result.reason).toBe('signature_mismatch');
    expect(result.detail).toContain(impostor.address.toLowerCase());
  });

  it('rejects a message edited after signing', async () => {
    const { verifier, clock } = createHarness();
    const proof = await makeProof(clock);
    const tampered = proof.message.replace(/Nonce: .*/, 'Nonce: swapped-nonce-value');
    const header = encodeProofHeader({ message: tampered, signature: proof.signature });

    const result = asAnonymous(await verifier.verify({ headers: { agentkit: header }, path: PATH }));

    expect(result.reason).toBe('signature_mismatch');
  });

  it('verifies against the bytes as received, so a message with odd spacing still passes', async () => {
    const { verifier, clock } = createHarness();
    // A trailing blank line is something a client may emit and a re-rendering verifier
    // would reject. Recovery runs on what arrived, so it verifies.
    const proof = await makeProof(clock);
    const withTrailingNewline = `${proof.message}\n`;

    const result = await verifier.verify({
      headers: await headerFor(withTrailingNewline, registeredAgent),
      path: PATH,
    });

    expect(result.tier).toBe('human-backed');
  });
});

describe('AgentBook', () => {
  it('grades an unregistered wallet anonymous', async () => {
    const { verifier, clock } = createHarness();
    const proof = await makeProof(clock, { account: unregisteredAgent });

    expect(asAnonymous(await verifier.verify(requestFor(proof.headers))).reason).toBe(
      'agentbook_unregistered',
    );
  });

  it('grades a revoked registration anonymous', async () => {
    const { verifier, clock } = createHarness();
    const proof = await makeProof(clock, { account: revokedAgent });

    expect(asAnonymous(await verifier.verify(requestFor(proof.headers))).reason).toBe('agentbook_revoked');
  });

  it('reports a registry outage distinctly, and does not spend the nonce on it', async () => {
    const harness = createHarness({ agentBook: failingAgentBook() });
    const proof = await makeProof(harness.clock);

    expect(asAnonymous(await harness.verifier.verify(requestFor(proof.headers))).reason).toBe(
      'agentbook_unavailable',
    );

    // Same proof, same nonce, registry now healthy: the retry must succeed.
    const recovered = createAgentTierVerifier({
      agentBook: defaultAgentBook(),
      storage: harness.storage,
      domain: DOMAIN,
      clock: harness.clock.now,
    });
    expect((await recovered.verify(requestFor(proof.headers))).tier).toBe('human-backed');
  });
});

describe('replay', () => {
  it('accepts a proof once and refuses the same proof again', async () => {
    const { verifier, clock } = createHarness();
    const proof = await makeProof(clock);

    expect((await verifier.verify(requestFor(proof.headers))).tier).toBe('human-backed');
    expect(asAnonymous(await verifier.verify(requestFor(proof.headers))).reason).toBe('nonce_replayed');
  });

  it('lets two agents pick the same nonce string', async () => {
    const { verifier, clock } = createHarness();
    const shared = 'shared-nonce-value-0001';
    const first = await makeProof(clock, { nonce: shared });
    const second = await makeProof(clock, { account: revokedAgent, nonce: shared });

    expect((await verifier.verify(requestFor(first.headers))).tier).toBe('human-backed');
    // The second agent is revoked, so it fails on the registry rather than on the nonce;
    // what matters is that it does not fail as a replay of the first agent's nonce.
    expect(asAnonymous(await verifier.verify(requestFor(second.headers))).reason).toBe('agentbook_revoked');
  });

  it('does not spend a nonce on a proof that failed its signature check', async () => {
    const { verifier, clock } = createHarness();
    const nonce = 'reusable-nonce-000001';
    const forged = await makeProof(clock, { nonce, signAs: impostor });
    expect(asAnonymous(await verifier.verify(requestFor(forged.headers))).reason).toBe('signature_mismatch');

    const genuine = await makeProof(clock, { nonce });
    expect((await verifier.verify(requestFor(genuine.headers))).tier).toBe('human-backed');
  });

  it('allows the nonce again once the proof it belonged to has expired', async () => {
    const { verifier, clock } = createHarness();
    const nonce = 'expiring-nonce-000001';
    const first = await makeProof(clock, { nonce, lifetimeSeconds: 60 });
    expect((await verifier.verify(requestFor(first.headers))).tier).toBe('human-backed');

    clock.advanceSeconds(61);
    const second = await makeProof(clock, { nonce, lifetimeSeconds: 60 });
    expect((await verifier.verify(requestFor(second.headers))).tier).toBe('human-backed');
  });

  it('drops to anonymous when the nonce store cannot guarantee replay protection', async () => {
    const clock = new Clock();
    const verifier = createAgentTierVerifier({
      agentBook: defaultAgentBook(),
      storage: nonceStoreDown(new InMemoryTierStorage({ clock: clock.now })),
      domain: DOMAIN,
      clock: clock.now,
    });
    const proof = await makeProof(clock);

    expect(asAnonymous(await verifier.verify(requestFor(proof.headers))).reason).toBe(
      'nonce_store_unavailable',
    );
  });
});
