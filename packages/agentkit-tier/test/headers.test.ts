import { describe, expect, it } from 'vitest';
import {
  ConflictingHeaderError,
  DEFAULT_PROOF_HEADER,
  forwardedClientAddress,
  normalizeHeaders,
  readProofHeader,
  tryNormalizeHeaders,
} from '../src/headers.js';

describe('normalizeHeaders', () => {
  it('lowercases names from a record', () => {
    expect(normalizeHeaders({ AgentKit: 'value' }).get('agentkit')).toBe('value');
  });

  it('takes a single value out of a Node array-valued header', () => {
    expect(normalizeHeaders({ agentkit: ['value', 'value'] }).get('agentkit')).toBe('value');
  });

  it('throws when the proof header carries two different values', () => {
    expect(() => normalizeHeaders({ agentkit: ['one', 'two'] })).toThrow(ConflictingHeaderError);
  });

  it('follows the proof header when it has been renamed, and leaves the old name alone', () => {
    expect(() => normalizeHeaders({ 'x-world-agentkit': ['one', 'two'] }, 'X-World-AgentKit')).toThrow(
      ConflictingHeaderError,
    );
    expect(normalizeHeaders({ agentkit: ['one', 'two'] }, 'x-world-agentkit').get('agentkit')).toBe(
      'one, two',
    );
  });

  // A browser or a proxy sending two `accept` values has nothing to do with the proof,
  // and refusing it is how a caller that presented nothing ends up answered with a 401.
  it('merges duplicates of any other header the way a fetch Headers does', () => {
    expect(normalizeHeaders({ accept: ['application/json', 'text/html'] }).get('accept')).toBe(
      'application/json, text/html',
    );
  });

  it('keeps an x-forwarded-for chain in order when Node splits it into an array', () => {
    const headers = normalizeHeaders({ 'x-forwarded-for': ['203.0.113.7', '10.0.0.1'] });
    expect(forwardedClientAddress(headers)).toBe('203.0.113.7');
  });

  it('drops whitespace-only values, which are the same as absent', () => {
    expect(normalizeHeaders({ agentkit: '   ' }).has('agentkit')).toBe(false);
  });

  it('skips keys explicitly set to undefined', () => {
    expect(normalizeHeaders({ agentkit: undefined }).size).toBe(0);
  });

  it('reads a fetch Headers', () => {
    expect(normalizeHeaders(new Headers({ AgentKit: 'abc' })).get('agentkit')).toBe('abc');
  });

  it('reads a Map', () => {
    expect(normalizeHeaders(new Map([['AgentKit', 'abc']])).get('agentkit')).toBe('abc');
  });
});

describe('tryNormalizeHeaders', () => {
  it('reports a conflicting proof header instead of throwing, and drops it', () => {
    const { headers, conflictingHeader } = tryNormalizeHeaders({
      AgentKit: ['one', 'two'],
      'x-forwarded-for': '203.0.113.7',
    });

    expect(conflictingHeader).toBe('AgentKit');
    expect(headers.has('agentkit')).toBe(false);
    // The rest survives, so a caller can still attribute the request to a bucket.
    expect(headers.get('x-forwarded-for')).toBe('203.0.113.7');
  });

  it('reports nothing for a repeat of the proof header with one consistent value', () => {
    expect(tryNormalizeHeaders({ agentkit: ['same', 'same'] }).conflictingHeader).toBeNull();
  });
});

describe('readProofHeader', () => {
  it('finds the default header regardless of the casing it arrived in', () => {
    const headers = normalizeHeaders({ AGENTKIT: 'p', authorization: 'Bearer nope' });
    expect(readProofHeader(headers, DEFAULT_PROOF_HEADER)).toBe('p');
  });

  it('honours a renamed header, which is how a proxy that namespaces headers is accommodated', () => {
    const headers = normalizeHeaders({ 'x-world-agentkit': 'p' });
    expect(readProofHeader(headers, 'X-World-AgentKit')).toBe('p');
    expect(readProofHeader(headers, DEFAULT_PROOF_HEADER)).toBeUndefined();
  });
});

describe('forwardedClientAddress', () => {
  it('takes the first hop of x-forwarded-for', () => {
    const headers = normalizeHeaders({ 'x-forwarded-for': '203.0.113.7, 10.0.0.1, 10.0.0.2' });
    expect(forwardedClientAddress(headers)).toBe('203.0.113.7');
  });

  it('falls back to x-real-ip', () => {
    expect(forwardedClientAddress(normalizeHeaders({ 'x-real-ip': '203.0.113.9' }))).toBe('203.0.113.9');
  });

  it('is undefined when neither is present', () => {
    expect(forwardedClientAddress(normalizeHeaders({}))).toBeUndefined();
  });
});
