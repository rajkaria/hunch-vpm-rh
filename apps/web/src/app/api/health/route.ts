/**
 * GET /api/health: 200 only when every keeper check holds (docs/spec/06-keeper-and-ops.md
 * §Health), else 503 with the failing checks. For an uptime monitor. Never cached, and no secret
 * in the body: balances and ages only.
 */

import { json } from '@/lib/api/http';
import { readDeployment } from '@/lib/deployment';
import { getKeeper } from '@/lib/server/keeper';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET(): Promise<Response> {
  try {
    const report = await getKeeper().health();
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
