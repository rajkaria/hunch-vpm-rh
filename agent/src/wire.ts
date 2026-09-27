/**
 * Building the agent from configuration.
 *
 * The two modes differ only in which implementations get plugged into the same four
 * ports. Dry-run is the default and needs no key, no network and no deployment.
 */

import type { AgentConfig } from "./config.js";
import { PLACEHOLDER_ADDRESS } from "./config.js";
import { DryRunNanopayments, DryRunWallet } from "./circle/dry-run.js";
import { CircleAgentWallet, GatewayNanopayments } from "./circle/live.js";
import type { AgentWallet, NanopaymentChannel } from "./circle/types.js";
import { FixtureIntelProvider, HttpIntelProvider, MeteredIntelProvider } from "./intel/providers.js";
import type { IntelProvider } from "./intel/types.js";
import type { Logger } from "./log.js";
import type { LoopDeps } from "./loop.js";
import { loadHunchClient } from "./research/client-binding.js";
import { FixtureResearchSource, FixtureVenue } from "./research/fixture-source.js";
import { loadFixtureWorld } from "./research/fixtures.js";
import { GraphResearchSource, GraphVenue } from "./research/graph-source.js";
import { SimulatedClock, systemClock } from "./research/source.js";
import type { Clock, ResearchSource, Venue } from "./research/source.js";

export class WiringError extends Error {}

export interface Wiring {
  readonly deps: LoopDeps;
  /** Simulated seconds between rounds. Zero in live mode. */
  readonly advanceSeconds: number;
  readonly onAdvance: ((seconds: number) => void) | undefined;
}

export interface WireOptions {
  readonly logger: Logger;
  readonly fixturePath: string | undefined;
  readonly fetchImpl: typeof fetch;
  readonly sleep: (ms: number) => Promise<void>;
  /** Unix seconds the simulated clock starts at. Real time by default. */
  readonly startAt: number;
}

export async function wire(config: AgentConfig, options: WireOptions): Promise<Wiring> {
  return config.mode === "live" ? wireLive(config, options) : Promise.resolve(wireDryRun(config, options));
}

function wireDryRun(config: AgentConfig, options: WireOptions): Wiring {
  const clock: Clock = new SimulatedClock(options.startAt);
  const world =
    options.fixturePath === undefined
      ? loadFixtureWorld(options.startAt)
      : loadFixtureWorld(options.startAt, options.fixturePath);

  const wallet = new DryRunWallet({
    seed: config.dryRunSeed,
    startingBalance: config.dryRunBankroll,
    now: () => clock.now(),
  });
  const channel = new DryRunNanopayments({ seed: config.dryRunSeed, now: () => clock.now() });
  const intel: IntelProvider = new MeteredIntelProvider(
    new FixtureIntelProvider(world, config.intelPriceMicroUsdc, () => clock.now()),
    channel,
  );
  const source: ResearchSource = new FixtureResearchSource(world, clock);
  const venue: Venue = new FixtureVenue(world, wallet, {
    onProceeds: (amount) => {
      wallet.credit(amount);
    },
  });

  return {
    deps: { source, venue, wallet, channel, intel, policy: config.policy, clock, logger: options.logger },
    advanceSeconds: config.demoTickSeconds,
    // Time passing in the simulation means everybody else's stake arriving.
    onAdvance: () => {
      world.tick();
    },
  };
}

async function wireLive(config: AgentConfig, options: WireOptions): Promise<Wiring> {
  if (config.settler === PLACEHOLDER_ADDRESS) {
    throw new WiringError(
      "live mode needs HUNCH_SETTLER set to a deployed VestedParimutuel. Nothing is deployed yet, " +
        "so the configured address is still the placeholder.",
    );
  }
  if (config.marketIds.length === 0) {
    throw new WiringError("live mode needs HUNCH_MARKET_IDS: a comma-separated list of markets to watch");
  }
  if (config.intelUrl === undefined) {
    throw new WiringError("live mode needs HUNCH_INTEL_URL: the paid quote endpoint");
  }

  const client = await loadHunchClient({
    subgraphUrl: config.subgraphUrl,
    settler: config.settler,
    chainId: config.chain.chainId,
  });

  const deps = { fetchImpl: options.fetchImpl, sleep: options.sleep };
  const wallet: AgentWallet = new CircleAgentWallet(
    {
      apiBase: config.circle.apiBase,
      apiKey: config.circle.apiKey,
      walletId: config.circle.walletId,
      entitySecretCiphertext: config.circle.entitySecretCiphertext,
      usdcAddress: config.chain.usdc,
      explorerBase: config.explorerBase ?? "",
      feeLevel: config.circle.feeLevel,
      pollIntervalMs: 2_000,
      pollAttempts: 30,
    },
    deps,
  );
  const channel: NanopaymentChannel = new GatewayNanopayments(config.gateway, deps);
  const intel: IntelProvider = new MeteredIntelProvider(
    new HttpIntelProvider({
      baseUrl: config.intelUrl,
      apiKey: config.gateway.apiKey,
      pricePerCallMicroUsdc: config.intelPriceMicroUsdc,
      fetchImpl: options.fetchImpl,
      sleep: options.sleep,
    }),
    channel,
  );

  return {
    deps: {
      source: new GraphResearchSource(client, { marketIds: config.marketIds, logger: options.logger }),
      venue: new GraphVenue(client, wallet, config.settler),
      wallet,
      channel,
      intel,
      policy: config.policy,
      clock: systemClock,
      logger: options.logger,
    },
    advanceSeconds: 0,
    onAdvance: undefined,
  };
}
