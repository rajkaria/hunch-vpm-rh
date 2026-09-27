import { callFor, decide, type DecideOptions, type KeeperAction, type SpecSnapshot } from './decide.js';

/**
 * One pass over a set of specs.
 *
 * One shot per invocation, on purpose: this is meant to run under cron, and a
 * long-lived daemon holding a key is a bigger thing to operate than a process
 * that wakes, does at most one useful call per spec, and exits.
 */

export interface SpecReader {
  /** Everything `decide` needs, read off `preview`, `specs` and `settled`. */
  read(specId: string): Promise<SpecSnapshot>;
}

export interface SpecWriter {
  /** Send the call. Returns a transaction hash. */
  send(specId: string, call: 'resolve' | 'voidStale'): Promise<string>;
}

export interface KeeperOptions extends DecideOptions {
  /**
   * Dry run: decide and report, send nothing.
   *
   * **The default is true**, and it is the default so that a misconfigured
   * keeper is inert rather than wrong. Sending requires both `dryRun: false`
   * and a writer.
   */
  dryRun?: boolean;
  now?: bigint;
}

export interface SpecOutcome {
  specId: string;
  action: KeeperAction;
  /** The transaction hash, when one was actually sent. */
  hash?: string;
  /** Set when the call was attempted and reverted. */
  error?: string;
}

export interface KeeperReport {
  dryRun: boolean;
  checked: number;
  /** Specs where a call was sent, or would have been in a live run. */
  actionable: number;
  sent: number;
  failed: number;
  outcomes: SpecOutcome[];
}

export async function runKeeper(
  specIds: readonly string[],
  reader: SpecReader,
  writer: SpecWriter | null,
  options: KeeperOptions = {},
): Promise<KeeperReport> {
  const dryRun = options.dryRun ?? true;
  const now = options.now ?? BigInt(Math.floor(Date.now() / 1000));
  const outcomes: SpecOutcome[] = [];

  for (const specId of specIds) {
    let snapshot: SpecSnapshot;
    try {
      snapshot = await reader.read(specId);
    } catch (error) {
      // One unreadable spec must not stop the pass. The others may be ready,
      // and a keeper that gives up on the first RPC hiccup is a keeper that
      // silently stops settling markets.
      outcomes.push({
        specId,
        action: { kind: 'unknown', why: 'Could not be read.' },
        error: message(error),
      });
      continue;
    }

    const action = decide(snapshot, now, options);
    const call = callFor(action);

    if (call === null || dryRun || writer === null) {
      outcomes.push({ specId, action });
      continue;
    }

    try {
      outcomes.push({ specId, action, hash: await writer.send(specId, call) });
    } catch (error) {
      outcomes.push({ specId, action, error: message(error) });
    }
  }

  const actionable = outcomes.filter((outcome) => callFor(outcome.action) !== null).length;

  return {
    dryRun,
    checked: outcomes.length,
    actionable,
    sent: outcomes.filter((outcome) => outcome.hash !== undefined).length,
    failed: outcomes.filter((outcome) => outcome.error !== undefined).length,
    outcomes,
  };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message.split('\n')[0] ?? error.message : String(error);
}

/** One line per spec, for a cron log that a human reads at 3am. */
export function formatReport(report: KeeperReport): string {
  const lines = report.outcomes.map((outcome) => {
    const id = `${outcome.specId.slice(0, 10)}…`;
    const tail =
      outcome.error !== undefined
        ? `FAILED ${outcome.error}`
        : outcome.hash !== undefined
          ? `sent ${outcome.hash}`
          : report.dryRun && callFor(outcome.action) !== null
            ? 'would send (dry run)'
            : '';
    return `${id} ${outcome.action.kind.padEnd(10)} ${outcome.action.why}${tail === '' ? '' : ` — ${tail}`}`;
  });

  const mode = report.dryRun ? 'dry run' : 'live';
  lines.push(
    `${report.checked} checked · ${report.actionable} actionable · ${report.sent} sent · ${report.failed} failed · ${mode}`,
  );
  return lines.join('\n');
}
