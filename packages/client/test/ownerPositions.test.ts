import { getAddress } from 'viem';
import { describe, expect, it } from 'vitest';
import { DecodeError } from '../src/decode.js';
import ownerPositions from './fixtures/owner-positions.json';
import { CREATOR, testClient } from './support/client.js';
import type { Responder } from './support/transport.js';

const responses = { ownerPositions };

describe('positions', () => {
  it('lists every position the wallet holds, claimed ones included, newest first', async () => {
    const { client } = testClient(responses);
    const held = await client.positions(CREATOR);

    expect(held.positions.map((position) => position.positionId)).toEqual([14n, 13n, 12n, 11n, 10n]);
    // Position 10 has been claimed. It is not a holding any more for `claimable`, but a
    // portfolio that dropped it would make a settled win vanish from the only page listing it.
    expect(held.positions.find((position) => position.positionId === 10n)?.claimed).toBe(true);
  });

  it('breaks a same-block tie by the settler’s own position order', async () => {
    const { client } = testClient(responses);
    const [first, second] = (await client.positions(CREATOR)).positions;

    expect(first?.createdAt).toBe(second?.createdAt);
    expect(first?.positionId).toBe(14n);
    expect(second?.positionId).toBe(13n);
  });

  it('carries when each entry landed and the whole market it sits in', async () => {
    const { client } = testClient(responses);
    const voided = (await client.positions(CREATOR)).positions.find((position) => position.positionId === 11n);

    expect(voided?.createdAt).toBe(1_699_400_600n);
    expect(voided?.market.status).toBe('Voided');
    expect(voided?.market.books.length).toBeGreaterThan(0);
  });

  it('asks the index by lowercase owner and answers with the checksummed wallet', async () => {
    const { client, transport } = testClient(responses);
    const wallet = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd';
    const held = await client.positions(wallet);

    expect(transport.calls[0]?.operation).toBe('ownerPositions');
    expect(transport.calls[0]?.variables?.['owner']).toBe(wallet);
    expect(held.wallet).toBe(getAddress(wallet));
  });

  it('reports the index head the answer was read at', async () => {
    const { client } = testClient(responses);
    const held = await client.positions(CREATOR);

    expect(held.index).toEqual({ block: 2100n, hasIndexingErrors: false });
  });

  it('walks every page rather than stopping at the first', async () => {
    const rows = ownerPositions.positions;
    const paged: Responder = (variables) => {
      const first = Number(variables['first']);
      const skip = Number(variables['skip']);
      return { _meta: ownerPositions._meta, positions: rows.slice(skip, skip + first) };
    };
    const { client, transport } = testClient({ ownerPositions: paged }, { pageSize: 2 });
    const held = await client.positions(CREATOR);

    expect(held.positions).toHaveLength(rows.length);
    // 2 + 2 + 1: the short page ends the walk.
    expect(transport.calls).toHaveLength(3);
  });

  it('holds nothing for a wallet the index has never seen', async () => {
    const { client } = testClient({ ownerPositions: { _meta: ownerPositions._meta, positions: [] } });
    expect((await client.positions(CREATOR)).positions).toEqual([]);
  });

  it('refuses a row with no entry time rather than inventing one', async () => {
    const [row] = ownerPositions.positions;
    const { createdAt: _dropped, ...withoutTime } = row!;
    const { client } = testClient({ ownerPositions: { _meta: ownerPositions._meta, positions: [withoutTime] } });

    await expect(client.positions(CREATOR)).rejects.toBeInstanceOf(DecodeError);
  });
});
