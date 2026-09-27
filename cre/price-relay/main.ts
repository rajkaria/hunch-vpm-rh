import {
	bytesToHex,
	CronCapability,
	EVMClient,
	encodeCallMsg,
	getNetwork,
	handler,
	LAST_FINALIZED_BLOCK_NUMBER,
	prepareReportRequest,
	Runner,
	type Runtime,
	TxStatus,
} from '@chainlink/cre-sdk'
import { type Address, decodeFunctionResult, encodeFunctionData, zeroAddress } from 'viem'
import { z } from 'zod'

import { buildUpdate, encodeUpdates, type RoundData, type Update } from './report'

/**
 * hunch-price-relay — Chainlink Data Feeds onto Arc testnet, through CRE.
 *
 * Chainlink publishes Data Feeds on Arc mainnet but not on Arc testnet. Every run this workflow
 * reads the configured feeds where they do live (Ethereum Sepolia), at the last finalized block,
 * and the DON signs one report carrying all of them. Chainlink's KeystoneForwarder on Arc verifies
 * the signatures and hands the report to `ChainlinkCreOracle`, which the venue's FeedResolver
 * reads like any other IPriceOracle.
 *
 * The workflow computes nothing: it copies each round's answer, decimals and SOURCE timestamp.
 * Staleness is judged on Arc against that timestamp, so a relay that runs often over a feed that
 * moves rarely still reports the feed's real age.
 */

const configSchema = z.object({
	schedule: z.string(),
	source: z.object({
		chainSelectorName: z.string(),
		feeds: z.array(z.object({ description: z.string(), address: z.string() })).min(1),
	}),
	target: z.object({
		chainSelectorName: z.string(),
		oracleAddress: z.string(),
		gasLimit: z.string(),
	}),
})

type Config = z.infer<typeof configSchema>

const AGGREGATOR_V3 = [
	{ type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
	{ type: 'function', name: 'description', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
	{
		type: 'function',
		name: 'latestRoundData',
		stateMutability: 'view',
		inputs: [],
		outputs: [
			{ name: 'roundId', type: 'uint80' },
			{ name: 'answer', type: 'int256' },
			{ name: 'startedAt', type: 'uint256' },
			{ name: 'updatedAt', type: 'uint256' },
			{ name: 'answeredInRound', type: 'uint80' },
		],
	},
] as const

type AggregatorRead = 'decimals' | 'description' | 'latestRoundData'

function clientFor(chainSelectorName: string): EVMClient {
	const network = getNetwork({ chainFamily: 'evm', chainSelectorName, isTestnet: true })
	if (!network) throw new Error(`CRE has no network named ${chainSelectorName}`)
	return new EVMClient(network.chainSelector.selector)
}

function readAggregator(runtime: Runtime<Config>, evm: EVMClient, address: string, functionName: AggregatorRead) {
	const reply = evm
		.callContract(runtime, {
			call: encodeCallMsg({
				from: zeroAddress,
				to: address as Address,
				data: encodeFunctionData({ abi: AGGREGATOR_V3, functionName }),
			}),
			blockNumber: LAST_FINALIZED_BLOCK_NUMBER,
		})
		.result()
	return decodeFunctionResult({ abi: AGGREGATOR_V3, functionName, data: bytesToHex(reply.data) })
}

const onCron = (runtime: Runtime<Config>): string => {
	const { source, target } = runtime.config
	const sourceEvm = clientFor(source.chainSelectorName)

	const updates: Update[] = []
	for (const feed of source.feeds) {
		const description = readAggregator(runtime, sourceEvm, feed.address, 'description') as string
		const decimals = Number(readAggregator(runtime, sourceEvm, feed.address, 'decimals'))
		const round = readAggregator(runtime, sourceEvm, feed.address, 'latestRoundData') as RoundData

		const built = buildUpdate(feed.description, description, decimals, round)
		if (built.ok) {
			updates.push(built.update)
			runtime.log(`${feed.description}: ${built.update.answer} (${decimals} dp) at ${built.update.updatedAt}`)
		} else {
			// One bad feed is reported and skipped; the rest still relay.
			runtime.log(`${feed.description}: skipped — ${built.reason}`)
		}
	}

	if (updates.length === 0) throw new Error('no feed produced a usable round; nothing to relay')

	const report = runtime.report(prepareReportRequest(encodeUpdates(updates))).result()
	const reply = clientFor(target.chainSelectorName)
		.writeReport(runtime, {
			receiver: target.oracleAddress,
			report,
			gasConfig: { gasLimit: target.gasLimit },
		})
		.result()

	if (reply.txStatus !== TxStatus.SUCCESS) {
		throw new Error(`report not delivered: ${reply.errorMessage || reply.txStatus}`)
	}
	const hash = bytesToHex(reply.txHash ?? new Uint8Array(32))
	runtime.log(`relayed ${updates.length} feed(s) to ${target.oracleAddress} in ${hash}`)
	return hash
}

const initWorkflow = (config: Config) => [handler(new CronCapability().trigger({ schedule: config.schedule }), onCron)]

export async function main() {
	const runner = await Runner.newRunner<Config>({ configSchema })
	await runner.run(initWorkflow)
}
