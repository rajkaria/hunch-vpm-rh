import type { NetworkId } from './chain';

/**
 * Which Arc a visitor reads, as the server sees it.
 *
 * The toggle stores the choice in localStorage for the browser and mirrors it
 * into this cookie for the server, because the board, the market pages and the
 * per-address routes are rendered there — and a server that cannot see the
 * choice would render testnet markets under a mainnet toggle. Not a secret and
 * not a session: one word, readable by both sides.
 */
export const NETWORK_COOKIE = 'hunch-vpm.network';

/** A network id, or `null` for anything else — never a guess. */
export function parseNetwork(value: string | null | undefined): NetworkId | null {
  return value === 'testnet' || value === 'mainnet' ? value : null;
}
