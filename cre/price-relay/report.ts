import { encodeAbiParameters, type Hex, keccak256, toBytes } from 'viem'

/**
 * The report payload `ChainlinkCreOracle.onReport` decodes: `abi.encode(Update[])`.
 *
 * Kept free of the CRE SDK so it can be tested with plain `bun test`, and so the one thing that
 * must agree byte for byte with the Solidity side lives in one small file.
 */

/** Mirrors `ChainlinkCreOracle.Update`. Field order is the ABI. */
export interface Update {
	feedKey: Hex
	answer: bigint
	decimals: number
	updatedAt: bigint
}

/** `latestRoundData()` as viem decodes it. */
export type RoundData = readonly [roundId: bigint, answer: bigint, startedAt: bigint, updatedAt: bigint, answeredInRound: bigint]

const UPDATE_TUPLE_ARRAY = [
	{
		type: 'tuple[]',
		components: [
			{ name: 'feedKey', type: 'bytes32' },
			{ name: 'answer', type: 'int256' },
			{ name: 'decimals', type: 'uint8' },
			{ name: 'updatedAt', type: 'uint64' },
		],
	},
] as const

/**
 * A feed's key is the hash of its own `description()` — `"ETH / USD"` — so the key on Arc names
 * the Chainlink feed the price came from, and a misconfigured source address cannot quietly write
 * one pair's price under another pair's key.
 */
export function feedKeyOf(description: string): Hex {
	return keccak256(toBytes(description))
}

export type Built = { ok: true; update: Update } | { ok: false; feed: string; reason: string }

/**
 * One feed's round, checked the way the contract will check it, so a bad round is reported by
 * the workflow instead of being silently ignored on chain.
 */
export function buildUpdate(expected: string, description: string, decimals: number, round: RoundData): Built {
	if (description !== expected) {
		return { ok: false, feed: expected, reason: `source feed describes itself as "${description}"` }
	}
	const [, answer, , updatedAt] = round
	if (answer <= 0n) return { ok: false, feed: expected, reason: `non-positive answer ${answer}` }
	if (updatedAt === 0n) return { ok: false, feed: expected, reason: 'round has never been written' }
	if (decimals > 18) return { ok: false, feed: expected, reason: `${decimals} decimals` }
	return { ok: true, update: { feedKey: feedKeyOf(description), answer, decimals, updatedAt } }
}

export function encodeUpdates(updates: readonly Update[]): Hex {
	return encodeAbiParameters(UPDATE_TUPLE_ARRAY, [updates.map((u) => ({ ...u }))])
}
