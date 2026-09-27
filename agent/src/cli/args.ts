/** Argument parsing, small enough not to need a library. */

export type Command = "research" | "decide" | "run" | "claim" | "help";

export interface Args {
  readonly command: Command;
  readonly rounds: number | undefined;
  readonly bankroll: string | undefined;
  readonly fixtures: string | undefined;
  readonly markets: readonly string[];
  readonly live: boolean;
  readonly json: boolean;
}

export class ArgError extends Error {}

const COMMANDS: readonly Command[] = ["research", "decide", "run", "claim", "help"];

export function parseArgs(argv: readonly string[]): Args {
  const [first, ...rest] = argv;
  const command = first === undefined || first === "--help" || first === "-h" ? "help" : first;
  if (!isCommand(command)) throw new ArgError(`unknown command ${command}. Try: ${COMMANDS.join(", ")}`);

  let rounds: number | undefined;
  let bankroll: string | undefined;
  let fixtures: string | undefined;
  const markets: string[] = [];
  let live = false;
  let json = false;

  for (let i = 0; i < rest.length; i += 1) {
    const flag = rest[i];
    const next = (): string => {
      const value = rest[i + 1];
      if (value === undefined) throw new ArgError(`${String(flag)} needs a value`);
      i += 1;
      return value;
    };
    switch (flag) {
      case "--rounds": {
        const value = Number(next());
        if (!Number.isFinite(value) || value < 1) throw new ArgError("--rounds must be a positive integer");
        rounds = Math.trunc(value);
        break;
      }
      case "--bankroll":
        bankroll = next();
        break;
      case "--fixtures":
        fixtures = next();
        break;
      case "--market":
        markets.push(next());
        break;
      case "--live":
        live = true;
        break;
      case "--dry-run":
        live = false;
        break;
      case "--json":
        json = true;
        break;
      case "--help":
      case "-h":
        return { command: "help", rounds, bankroll, fixtures, markets, live, json };
      default:
        throw new ArgError(`unknown flag ${String(flag)}`);
    }
  }

  return { command, rounds, bankroll, fixtures, markets, live, json };
}

function isCommand(value: string): value is Command {
  return (COMMANDS as readonly string[]).includes(value);
}

export const USAGE = `hunch-agent — the demo agent for the Vested Parimutuel

  hunch-agent research        read every market, buy one quote per feed, print the book
  hunch-agent decide          the same, plus the decision table for each market
  hunch-agent run             research -> decide -> enter -> monitor -> claim
  hunch-agent claim           settle whatever the resolved markets owe this wallet

Flags
  --rounds N        research/monitor rounds for \`run\` (default 3)
  --bankroll USDC   starting balance for the dry-run wallet (default 1000)
  --fixtures PATH   fixture file for dry-run mode (default agent/fixtures/markets.json)
  --market ID       market to watch in live mode; repeatable
  --live            use Circle custody, Gateway nanopayments and the subgraph
  --dry-run         the default: no key, no network, no deployment
  --json            print the decisions as JSON instead of a table

Dry-run is the default. Nothing in this tool needs a private key in any mode: live custody
is a Circle developer-controlled wallet, and the entity secret is supplied already
encrypted.`;
