import { describe, expect, it } from 'bun:test'

import { buildUpdate, encodeUpdates, feedKeyOf, type RoundData } from './report'

const round = (answer: bigint, updatedAt: bigint): RoundData => [1n, answer, updatedAt, updatedAt, 1n]

describe('feedKeyOf', () => {
	it('is keccak256 of the feed description, as ChainlinkCreOracle keys it', () => {
		// cast keccak 'ETH / USD'
		expect(feedKeyOf('ETH / USD')).toBe('0x62ddc8c5ffbd077b5a28e92efd10abcc58e66fb2a326401f0efd02e173ac1777')
		expect(feedKeyOf('BTC / USD')).toBe('0x0e3e290fbc572c3c2d1656bd757b05413d2fc62474d95064641dcabee325eb93')
	})
})

describe('encodeUpdates', () => {
	it('matches Solidity abi.encode(Update[]) byte for byte', () => {
		const eth = buildUpdate('ETH / USD', 'ETH / USD', 8, round(252054000000n, 1789281168n))
		const btc = buildUpdate('BTC / USD', 'BTC / USD', 8, round(7727945200000n, 1789280544n))
		if (!eth.ok || !btc.ok) throw new Error('fixtures must build')

		// cast abi-encode "f((bytes32,int256,uint8,uint64)[])" "[(<eth key>,252054000000,8,1789281168),(<btc key>,7727945200000,8,1789280544)]"
		expect(encodeUpdates([eth.update, btc.update])).toBe(
			'0x0000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000000262ddc8c5ffbd077b5a28e92efd10abcc58e66fb2a326401f0efd02e173ac17770000000000000000000000000000000000000000000000000000003aaf96d1800000000000000000000000000000000000000000000000000000000000000008000000000000000000000000000000000000000000000000000000006aa643900e3e290fbc572c3c2d1656bd757b05413d2fc62474d95064641dcabee325eb93000000000000000000000000000000000000000000000000000007074d6db1800000000000000000000000000000000000000000000000000000000000000008000000000000000000000000000000000000000000000000000000006aa64120',
		)
	})
})

describe('buildUpdate', () => {
	it('refuses a source whose description is not the pair it was configured as', () => {
		const built = buildUpdate('ETH / USD', 'BTC / USD', 8, round(1n, 1n))
		expect(built.ok).toBe(false)
	})

	it('refuses the rounds the contract would ignore', () => {
		expect(buildUpdate('ETH / USD', 'ETH / USD', 8, round(0n, 1n)).ok).toBe(false)
		expect(buildUpdate('ETH / USD', 'ETH / USD', 8, round(-5n, 1n)).ok).toBe(false)
		expect(buildUpdate('ETH / USD', 'ETH / USD', 8, round(1n, 0n)).ok).toBe(false)
		expect(buildUpdate('ETH / USD', 'ETH / USD', 19, round(1n, 1n)).ok).toBe(false)
	})

	it('carries the source round timestamp, not the relay time', () => {
		const built = buildUpdate('ETH / USD', 'ETH / USD', 8, round(10n, 1789281168n))
		expect(built.ok && built.update.updatedAt).toBe(1789281168n)
	})
})
