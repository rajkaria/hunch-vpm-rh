import { UnknownSideError } from './errors.js';
import type { RailId, RailSide } from './types.js';

/**
 * Side labels.
 *
 * The settler knows outcomes only by index. An agent that has been sending
 * `side: "yes"` at a Postgres book for a year should not have to learn that,
 * so the rail is configured once with the labels the app already uses and
 * translates both ways. Labels are matched case-insensitively; a numeric string
 * is accepted as the index it spells, which is what an HTTP surface tends to
 * hand over.
 */
export class SideMap {
  private readonly byLabel: Map<string, number>;
  private readonly byOutcome: Map<number, string>;
  private readonly rail: RailId;

  constructor(rail: RailId, sides: Readonly<Record<string, number>> = {}) {
    this.rail = rail;
    this.byLabel = new Map();
    this.byOutcome = new Map();
    for (const [label, outcome] of Object.entries(sides)) {
      if (!Number.isInteger(outcome) || outcome < 0 || outcome > 254) {
        throw new RangeError(`side "${label}" maps to ${outcome}, which is not an outcome index in [0, 254]`);
      }
      this.byLabel.set(label.toLowerCase(), outcome);
      // Two labels for one outcome is legal — the first wins when labelling a
      // result, so the mapping back is deterministic.
      if (!this.byOutcome.has(outcome)) this.byOutcome.set(outcome, label);
    }
  }

  /** The labels this rail was configured with, in configuration order. */
  get labels(): readonly string[] {
    return [...this.byLabel.keys()];
  }

  /**
   * Resolve a side to an outcome index, checked against the market's own
   * outcome count so a label pointing off the end of a market fails here rather
   * than in a reverted transaction.
   */
  resolve(side: RailSide, outcomeCount: number): number {
    const outcome = this.toOutcome(side);
    if (outcome >= outcomeCount) {
      throw new RangeError(
        `outcome ${outcome} does not exist on this market: it has ${outcomeCount} outcomes, ` +
          `so the indices are 0..${outcomeCount - 1}`,
      );
    }
    return outcome;
  }

  /** The label configured for an outcome, or `null` when none is. */
  label(outcome: number): string | null {
    return this.byOutcome.get(outcome) ?? null;
  }

  private toOutcome(side: RailSide): number {
    if (typeof side === 'number') {
      if (!Number.isInteger(side) || side < 0 || side > 254) {
        throw new RangeError(`side must be an outcome index in [0, 254], got ${side}`);
      }
      return side;
    }
    const labelled = this.byLabel.get(side.trim().toLowerCase());
    if (labelled !== undefined) return labelled;
    if (/^\d+$/.test(side.trim())) return this.toOutcome(Number(side.trim()));
    throw new UnknownSideError(this.rail, side, this.labels);
  }
}
