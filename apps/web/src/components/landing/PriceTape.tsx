'use client';

// TODO(S7): the tape polls /api/prices; S7 re-points that route at @hunch-rh/client readPrices.

import { useEffect, useRef, useState } from 'react';

import { TickerMark } from '@/components/market/TickerMark';
import { formatEtAsOf, formatEtTime, marketClock } from '@/lib/et';
import type { PriceReading, PriceSnapshot } from '@/lib/live/types';
import { formatPrice } from '@/lib/units';

const POLL_MS = 15_000;

function statusLine(now: number): { live: boolean; text: string } {
  const clock = marketClock(now);
  if (clock.sessionOpen) return { live: true, text: `US market open · bell at ${formatEtTime(clock.session.close)}` };
  if (clock.feedsUpdating) return { live: true, text: 'US market closed · updates overnight' };
  return { live: false, text: 'Weekend · resumes Sun 8:00 pm ET' };
}

function Cell({
  reading,
  now,
  flash,
  hidden = false,
}: {
  reading: PriceReading;
  now: number;
  /** Set to the new round id right after an update changed this price; the digits flash once. */
  flash: string | undefined;
  hidden?: boolean;
}) {
  const answer = reading.answer === null ? null : BigInt(reading.answer);
  return (
    <li
      aria-hidden={hidden || undefined}
      className={`flex shrink-0 items-center gap-2.5 whitespace-nowrap border-r border-edge-soft px-4 py-2.5 sm:px-5 ${
        hidden ? 'motion-reduce:hidden' : ''
      }`}
    >
      <TickerMark ticker={reading.ticker} size="sm" />
      <span className="text-[13px] font-semibold text-paper">{reading.ticker}</span>
      {answer === null ? (
        <span className="text-xs text-faint">Price unavailable, retrying</span>
      ) : (
        <>
          <span
            // Keyed by round: a new Chainlink round re-mounts the figure and runs the flash once.
            key={flash ?? 'steady'}
            className={`num rounded-[4px] px-1 text-[14px] text-paper ${flash === undefined ? '' : 'motion-safe:animate-flash'}`}
          >
            <span className="sr-only">{reading.name} Stock Token, </span>
            {formatPrice(answer)}
          </span>
          {reading.updatedAt === null ? null : (
            <span className="num whitespace-nowrap text-[11px] text-faint">
              <span className="sr-only">updated </span>
              {formatEtAsOf(reading.updatedAt, now)}
            </span>
          )}
        </>
      )}
    </li>
  );
}

/**
 * The live Chainlink price tape under the header.
 *
 * Server-rendered with the readings the page was built with, then polled every 15 s while the
 * tab is visible. A failed poll keeps the last values on screen and says "retrying". The strip
 * drifts sideways like a ticker (paused on hover); with reduced motion it is a plain scrollable
 * row instead.
 */
export function PriceTape({ initial, now: serverNow }: { initial: PriceSnapshot; now: number }) {
  const [snapshot, setSnapshot] = useState(initial);
  const [now, setNow] = useState(serverNow);
  const [failed, setFailed] = useState(initial.status !== 'live');
  const [changed, setChanged] = useState<Record<string, string>>({});
  const inflight = useRef(false);
  const latest = useRef(initial);

  useEffect(() => {
    let cancelled = false;
    const poll = async (): Promise<void> => {
      if (document.visibilityState !== 'visible' || inflight.current) return;
      inflight.current = true;
      try {
        const response = await fetch('/api/prices', { cache: 'no-store' });
        if (!response.ok) throw new Error(String(response.status));
        const next = (await response.json()) as PriceSnapshot;
        if (cancelled) return;
        if (next.readings.some((reading) => reading.answer !== null)) {
          const moved: Record<string, string> = {};
          for (const reading of next.readings) {
            const before = latest.current.readings.find((candidate) => candidate.ticker === reading.ticker);
            if (reading.roundId !== null && before?.roundId !== reading.roundId) moved[reading.ticker] = reading.roundId;
          }
          latest.current = next;
          setSnapshot(next);
          setChanged(moved);
        }
        setFailed(next.status !== 'live');
      } catch {
        if (!cancelled) setFailed(true);
      } finally {
        inflight.current = false;
      }
    };
    const clock = window.setInterval(() => setNow(Math.floor(Date.now() / 1000)), 30_000);
    const timer = window.setInterval(() => void poll(), POLL_MS);
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') void poll();
    };
    document.addEventListener('visibilitychange', onVisible);
    setNow(Math.floor(Date.now() / 1000));
    return () => {
      cancelled = true;
      window.clearInterval(clock);
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  const status = statusLine(now);
  const readings = snapshot.readings;

  return (
    <section aria-label="Chainlink prices on Robinhood Chain" className="border-b border-edge bg-ghost">
      <div className="mx-auto flex w-full max-w-[1180px] flex-col lg:flex-row lg:items-stretch lg:px-6">
        <div className="flex min-h-9 items-center gap-2 border-b border-edge-soft px-4 text-[11px] text-faint sm:px-6 lg:shrink-0 lg:border-b-0 lg:border-r lg:px-0 lg:pr-5">
          <span
            aria-hidden
            className={`h-1.5 w-1.5 shrink-0 rounded-pill ${status.live && !failed ? 'bg-lime motion-safe:animate-pulse' : 'bg-paper/30'}`}
          />
          <span className="min-w-0 truncate lg:overflow-visible lg:whitespace-nowrap">
            <span className="font-semibold text-muted">Chainlink prices</span> ·{' '}
            {failed ? 'Price unavailable, retrying' : status.text}
          </span>
        </div>
        <div className="relative min-w-0 flex-1 overflow-hidden motion-reduce:overflow-x-auto">
          <ul className="flex w-max motion-safe:animate-tape motion-safe:hover:[animation-play-state:paused]">
            {readings.map((reading) => (
              <Cell key={reading.ticker} reading={reading} now={now} flash={changed[reading.ticker]} />
            ))}
            {/* The second copy makes the loop seamless; it is decoration, hidden from assistive tech. */}
            {readings.map((reading) => (
              <Cell key={`${reading.ticker}-copy`} reading={reading} now={now} flash={changed[reading.ticker]} hidden />
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}
