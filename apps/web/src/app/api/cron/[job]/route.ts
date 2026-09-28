/**
 * GET /api/cron/[job] for `open`, `resolve` and `deliver`, scheduled by Vercel Cron (vercel.json).
 * Requires `Authorization: Bearer ${CRON_SECRET}`; anything else is 401, and so is every request
 * while `CRON_SECRET` is unset. Every job is idempotent: it reads the chain, decides, acts, and
 * can run twice without harm. The jobs share the keeper key, so one runs at a time: a job that
 * finds another holding the lock skips (200, `skipped`) and the next scheduled run picks up.
 * Returns the keeper's report.
 */

import { revalidateTag } from 'next/cache';
import { KEEPER_LOCK_KEY, KEEPER_LOCK_TTL_SEC, lockFromEnv, type LockHandle } from '@hunch-rh/keeper';

import { CRON_JOBS, cronAuthorized, isCronJob } from '@/lib/api/cron';
import { json, problem } from '@/lib/api/http';
import { TAG } from '@/lib/server/cache';
import { redactError } from '@/lib/server/client';
import { getKeeper } from '@/lib/server/keeper';

export const dynamic = 'force-dynamic';
/** A resolve or deliver pass waits for each receipt; give it room. */
export const maxDuration = 300;

export async function GET(request: Request, context: { params: Promise<{ job: string }> }): Promise<Response> {
  if (!cronAuthorized(request.headers.get('authorization'), process.env.CRON_SECRET)) {
    return problem(401, 'unauthorized', 'This endpoint is for the scheduler.');
  }
  const { job } = await context.params;
  if (!isCronJob(job)) return problem(404, 'not_found', `Unknown job. Jobs: ${CRON_JOBS.join(', ')}.`);

  let lock: LockHandle | null = null;
  let lockNote: string | null = null;
  try {
    lock = await lockFromEnv(process.env as Record<string, string | undefined>).acquire(KEEPER_LOCK_KEY, KEEPER_LOCK_TTL_SEC);
    if (lock === null) return json({ ok: true, job, skipped: 'another keeper run holds the lock; the next scheduled run picks up' }, { cache: 'none' });
  } catch (error) {
    // The lock store is down: run anyway (every job re-checks the chain before it sends).
    lockNote = `lock store unavailable (${redactError(error)}); ran unlocked`;
    console.warn(`[cron] ${job}: ${lockNote}`);
  }

  try {
    const reports = await getKeeper().run(job);
    if (reports.some((report) => report.actions.some((action) => action.status === 'confirmed'))) {
      // Settled, paid or listed: the next read of any market, the venue or /proof is fresh.
      revalidateTag(TAG.venue, { expire: 0 });
      revalidateTag(TAG.markets, { expire: 0 });
      revalidateTag(TAG.proof, { expire: 0 });
    }
    return json({ ok: true, job, reports, ...(lockNote === null ? {} : { note: lockNote }) }, { cache: 'none' });
  } catch (error) {
    const message = redactError(error);
    console.error(`[cron] ${job} failed: ${message}`);
    return json({ ok: false, job, error: 'job_failed', message }, { status: 500, cache: 'none' });
  } finally {
    await lock?.release().catch(() => undefined);
  }
}
