import { describe, expect, it } from 'vitest';

import { GET } from '@/app/api/claimable/route';

function get(url: string) {
  return GET(new Request(url));
}

describe('/api/claimable', () => {
  it('refuses a missing address rather than guessing one', async () => {
    const response = await get('http://x/api/claimable');
    expect(response.status).toBe(400);
  });

  it('refuses anything that is not a 20-byte hex address', async () => {
    for (const bad of ['0x123', 'vitalik.eth', '0xZZZZ4c1b9E0f3A8d5C7b2E1f4A9c8B3d6E5f0a42', '']) {
      expect((await get(`http://x/api/claimable?address=${bad}`)).status).toBe(400);
    }
  });

  it('answers for a well-formed address, with every amount as a decimal string', async () => {
    const response = await get('http://x/api/claimable?address=0x6D2a4c1b9E0f3A8d5C7b2E1f4A9c8B3d6E5f0a42');
    expect(response.status).toBe(200);

    const body = await response.json();
    // bigint does not survive JSON. Strings, not numbers: a claimable balance
    // through a float is a rounding bug waiting to be reported.
    expect(typeof body.totals.total).toBe('string');
    expect(body.index.block).toEqual(expect.any(String));
    for (const item of body.items) {
      expect(typeof item.amount).toBe('string');
      expect(typeof item.argument).toBe('string');
    }
  });

  it('never lets one visitor cache another visitor’s positions', async () => {
    const response = await get('http://x/api/claimable?address=0x6D2a4c1b9E0f3A8d5C7b2E1f4A9c8B3d6E5f0a42');
    expect(response.headers.get('cache-control')).toMatch(/private/);
  });

  it('round-trips through BigInt without loss', async () => {
    const response = await get('http://x/api/claimable?address=0x6D2a4c1b9E0f3A8d5C7b2E1f4A9c8B3d6E5f0a42');
    const body = await response.json();
    for (const item of body.items) {
      expect(BigInt(item.amount).toString()).toBe(item.amount);
    }
  });
});
