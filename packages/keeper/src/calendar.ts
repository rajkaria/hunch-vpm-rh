import corporateActionsFile from '../calendar/corporate-actions.json' with { type: 'json' };

/**
 * The keeper's calendar. NYSE sessions come from `@hunch-rh/client` (its
 * `src/calendar/nyse.json`, read from nyse.com, 2026 + 2027); the keeper does not keep a
 * second copy that could drift. Corporate actions live in
 * `packages/keeper/calendar/corporate-actions.json` (schema in its `_comment`).
 */
export {
  NYSE_CALENDAR,
  isTradingDay,
  openingBell,
  closingBell,
  nextSession,
  currentOrNextSession,
  sessionOn,
  sessionsOfWeek,
  weeklyWindow,
  etDateOf,
  isCovered,
  addDays,
} from '@hunch-rh/client';

export type CorporateActionKind = 'split' | 'reverse-split' | 'special-dividend' | 'spin-off' | 'merger' | 'other';

export interface CorporateAction {
  ticker: string;
  /** ET date (YYYY-MM-DD) of the ex/effective date. */
  date: string;
  /** Last ET date affected, inclusive (defaults to `date`). */
  until?: string;
  kind: CorporateActionKind;
  source: string;
  note?: string;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Validate the corporate-actions file; returns problems (empty when valid). */
export function validateCorporateActions(file: unknown): string[] {
  const problems: string[] = [];
  const f = file as { actions?: unknown };
  if (typeof f !== 'object' || f === null || !Array.isArray(f.actions)) return ['actions: array required'];
  f.actions.forEach((a: unknown, i: number) => {
    const x = a as Partial<CorporateAction>;
    if (typeof x.ticker !== 'string' || x.ticker === '') problems.push(`actions[${i}].ticker: required`);
    if (typeof x.date !== 'string' || !DATE.test(x.date)) problems.push(`actions[${i}].date: YYYY-MM-DD`);
    if (x.until !== undefined && (typeof x.until !== 'string' || !DATE.test(x.until) || x.until < (x.date ?? ''))) {
      problems.push(`actions[${i}].until: YYYY-MM-DD on or after date`);
    }
    if (typeof x.source !== 'string' || !/^https?:\/\//.test(x.source)) problems.push(`actions[${i}].source: URL required`);
  });
  return problems;
}

/** The committed corporate actions (validated). */
export function loadCorporateActions(): CorporateAction[] {
  const problems = validateCorporateActions(corporateActionsFile);
  if (problems.length > 0) throw new Error(`calendar/corporate-actions.json: ${problems.join('; ')}`);
  return (corporateActionsFile as { actions: CorporateAction[] }).actions;
}

/** The first action on `ticker` overlapping the ET date range [from, to], or null. */
export function corporateActionIn(actions: readonly CorporateAction[], ticker: string, from: string, to: string): CorporateAction | null {
  const t = ticker.toUpperCase();
  for (const a of actions) {
    if (a.ticker.toUpperCase() !== t) continue;
    const end = a.until ?? a.date;
    if (a.date <= to && end >= from) return a;
  }
  return null;
}
