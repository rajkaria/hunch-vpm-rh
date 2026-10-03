/**
 * GET /api/health: 200 only when every keeper check holds (docs/spec/06-keeper-and-ops.md
 * §Health) and the venue's pages read current (`market-reads`, `market-logs`: see
 * `lib/server/health.ts`), else 503 with the failing checks. For an uptime monitor. No secret in
 * the body: balances, ages and redacted reasons only. The report is reused for 30 s per instance,
 * so polling it cannot turn into load on the keeper's RPC quota.
 */

import { json } from '@/lib/api/http';
import { readDeployment } from '@/lib/deployment';
import { marketHealthChecks } from '@/lib/server/health';
import { getKeeper } from '@/lib/server/keeper';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

type Keeper = ReturnType<typeof getKeeper>;
type Report = Awaited<ReturnType<Keeper['health']>>;

/** The keeper's report plus the web's market checks (skipped before deployment). */
async function fullReport(keeper: Keeper): Promise<Report> {
  const [report, web] = await Promise.all([keeper.health(), readDeployment().status === 'deployed' ? marketHealthChecks() : Promise.resolve([])]);
  return { ...report, ok: report.ok && web.every((c) => c.ok), checks: [...report.checks, ...web] };
}
const REUSE_MS = 30_000;
let last: { keeper: Keeper; at: number; report: Report } | null = null;
let inFlight: { keeper: Keeper; report: Promise<Report> } | null = null;

export async function GET(): Promise<Response> {
  try {
    const keeper = getKeeper();
    let report: Report;
    if (last !== null && last.keeper === keeper && Date.now() - last.at < REUSE_MS) report = last.report;
    else {
      if (inFlight === null || inFlight.keeper !== keeper) {
        const pending = fullReport(keeper).finally(() => {
          if (inFlight?.report === pending) inFlight = null;
        });
        inFlight = { keeper, report: pending };
      }
      report = await inFlight.report;
      last = { keeper, at: Date.now(), report };
    }
    return json(report, { status: report.ok ? 200 : 503, cache: 'none' });
  } catch {
    const deployment = readDeployment();
    return json(
      {
        ok: false,
        deployed: deployment.status === 'deployed',
        nowSec: Math.floor(Date.now() / 1000),
        checks: [{ name: 'keeper', ok: false, detail: 'the keeper could not start (check its environment)' }],
      },
      { status: 503, cache: 'none' },
    );
  }
}
