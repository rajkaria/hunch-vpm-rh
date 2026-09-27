/**
 * The commands, as functions that return an exit code.
 *
 * Nothing here touches `process` directly, so the whole CLI is exercisable from a test
 * with a memory logger and a fake clock.
 */

import type { Env } from "../config.js";
import { describeConfig, loadConfig } from "../config.js";
import { formatUsdc, parseUsdc, usdc } from "../domain/units.js";
import type { Logger } from "../log.js";
import { claimAll, decideAll, research, runLoop } from "../loop.js";
import type { LoopDeps } from "../loop.js";
import { renderClaims, renderDecision, renderResearch, renderRound, renderSettlement } from "../render.js";
import { wire } from "../wire.js";
import { ArgError, USAGE, parseArgs } from "./args.js";

export interface CliDeps {
  readonly logger: Logger;
  readonly env: Env;
  readonly fetchImpl: typeof fetch;
  readonly sleep: (ms: number) => Promise<void>;
  /** Unix seconds. Injected so a test run is reproducible. */
  readonly now: () => number;
}

export async function runCli(argv: readonly string[], deps: CliDeps): Promise<number> {
  let args;
  try {
    args = parseArgs(argv);
  } catch (cause) {
    if (cause instanceof ArgError) {
      deps.logger.error(cause.message);
      return 2;
    }
    throw cause;
  }

  if (args.command === "help") {
    deps.logger.info(USAGE);
    return 0;
  }

  // Flags win over the environment, so a reader of the command line sees what happened.
  const env: Env = {
    ...deps.env,
    ...(args.live ? { HUNCH_MODE: "live" } : { HUNCH_MODE: deps.env["HUNCH_MODE"] ?? "dry-run" }),
    ...(args.bankroll === undefined ? {} : { HUNCH_DRY_RUN_BANKROLL: args.bankroll }),
    ...(args.rounds === undefined ? {} : { HUNCH_ROUNDS: String(args.rounds) }),
    ...(args.markets.length === 0 ? {} : { HUNCH_MARKET_IDS: args.markets.join(",") }),
  };
  if (args.bankroll !== undefined) {
    try {
      parseUsdc(args.bankroll);
    } catch {
      deps.logger.error(`--bankroll ${args.bankroll} is not a USDC amount`);
      return 2;
    }
  }

  const config = loadConfig(env);
  const startAt = deps.now();

  // Warned separately from the banner because `--json` suppresses the banner, and an
  // override that was thrown away is the one thing an operator must not miss.
  for (const name of config.ignoredEnv) {
    deps.logger.warn(`${name} was set to something unreadable and was ignored; the default is in effect`);
  }

  try {
    const wiring = await wire(config, {
      logger: deps.logger,
      fixturePath: args.fixtures,
      fetchImpl: deps.fetchImpl,
      sleep: deps.sleep,
      startAt,
    });

    if (!args.json) {
      deps.logger.info("hunch-agent");
      for (const line of describeConfig(config)) deps.logger.info(`  ${line}`);
      deps.logger.info(`  wallet          ${wiring.deps.wallet.description}`);
      deps.logger.info(`  nanopayments    ${wiring.deps.channel.description}`);
      deps.logger.info(`  research        ${wiring.deps.source.name}`);
    }

    switch (args.command) {
      case "research":
        return await commandResearch(wiring.deps, args.json);
      case "decide":
        return await commandDecide(wiring.deps, args.json);
      case "claim":
        return await commandClaim(wiring.deps);
      case "run":
        return await commandRun(wiring.deps, {
          rounds: config.rounds,
          advanceSeconds: wiring.advanceSeconds,
          onAdvance: wiring.onAdvance,
          sleep: deps.sleep,
          intervalMs: config.roundIntervalMs,
          readOnly: false,
        });
    }
  } catch (cause) {
    deps.logger.error(cause instanceof Error ? cause.message : String(cause));
    return 1;
  }
}

async function commandResearch(deps: LoopDeps, json: boolean): Promise<number> {
  const report = await research(deps);
  if (json) {
    deps.logger.info(toJson({ at: report.at, markets: report.markets.map((m) => m.market) }));
    return 0;
  }
  for (const line of renderResearch(report)) deps.logger.info(line);
  const settlement = await deps.channel.settle();
  for (const line of renderSettlement(settlement, report.quotesBought)) deps.logger.info(line);
  return 0;
}

async function commandDecide(deps: LoopDeps, json: boolean): Promise<number> {
  const report = await research(deps);
  const bankroll = await deps.wallet.balance();
  const decisions = decideAll(report, bankroll, deps.policy);

  if (json) {
    deps.logger.info(toJson({ at: report.at, bankroll, decisions }));
    return 0;
  }
  for (const line of renderResearch(report)) deps.logger.info(line);
  deps.logger.info("");
  deps.logger.info(`bankroll  ${usdc(bankroll)}`);
  for (const decision of decisions) {
    const market = report.markets.find((r) => r.market.marketId === decision.marketId)?.market;
    for (const line of renderDecision(decision, market)) deps.logger.info(line);
  }
  const settlement = await deps.channel.settle();
  for (const line of renderSettlement(settlement, report.quotesBought)) deps.logger.info(line);
  return 0;
}

async function commandClaim(deps: LoopDeps): Promise<number> {
  const claims = await claimAll(deps);
  for (const line of renderClaims(claims)) deps.logger.info(line);
  return 0;
}

async function commandRun(deps: LoopDeps, options: Parameters<typeof runLoop>[1]): Promise<number> {
  const result = await runLoop(deps, options);
  for (const round of result.rounds) {
    deps.logger.info("");
    deps.logger.info(`--- round ${String(round.round)} -----------------------------------------------`);
    for (const line of renderResearch(round.report)) deps.logger.info(line);
    for (const decision of round.decisions) {
      const market = round.report.markets.find((r) => r.market.marketId === decision.marketId)?.market;
      for (const line of renderDecision(decision, market)) deps.logger.info(line);
    }
    for (const line of renderRound(round)) deps.logger.info(line);
  }
  for (const line of renderSettlement(result.settlement, result.quotesBought)) deps.logger.info(line);
  for (const line of renderClaims(result.claims)) deps.logger.info(line);
  deps.logger.info("");
  deps.logger.info(
    `balance   ${formatUsdc(result.openingBalance)} -> ${formatUsdc(result.closingBalance)} USDC`,
  );
  return 0;
}

/** JSON.stringify refuses bigint; every amount goes out as a decimal string of base units. */
function toJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => (typeof v === "bigint" ? v.toString() : v), 2);
}

export { USAGE };
