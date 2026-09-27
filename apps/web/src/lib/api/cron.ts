import { timingSafeEqual } from 'node:crypto';

/** The cron jobs a scheduler may trigger. */
export const CRON_JOBS = ['open', 'resolve', 'deliver'] as const;
export type CronJob = (typeof CRON_JOBS)[number];

export function isCronJob(value: string): value is CronJob {
  return (CRON_JOBS as readonly string[]).includes(value);
}

/**
 * `Authorization: Bearer ${CRON_SECRET}`, compared in constant time. False while the secret is
 * unset, so an unconfigured deployment never runs a job for an anonymous caller.
 */
export function cronAuthorized(header: string | null, secret: string | undefined): boolean {
  if (secret === undefined || secret.trim() === '' || header === null) return false;
  const expected = Buffer.from(`Bearer ${secret.trim()}`);
  const given = Buffer.from(header.trim());
  return given.length === expected.length && timingSafeEqual(given, expected);
}
