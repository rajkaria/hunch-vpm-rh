'use client';

import { useId, useMemo, useState } from 'react';

import type { OutcomeTone } from '@/lib/data/types';
import { formatUtcDate } from '@/lib/time';

export interface CurvePoint {
  /** Unix seconds. */
  t: number;
  /** What one unit of this outcome's opening stake is worth under the vested rule. */
  vpm: number;
  /** What the same unit would be worth under the classic pool rule. */
  classic: number;
}

export interface CurveSeries {
  outcome: number;
  label: string;
  tone: OutcomeTone;
  points: CurvePoint[];
}

export interface CurveMarker {
  outcome: number;
  t: number;
  label: string;
}

const STROKE: Record<OutcomeTone, string> = {
  up: 'var(--color-lime)',
  down: 'var(--color-coral)',
  neutral: 'var(--color-paper)',
};

const WIDTH = 760;
const HEIGHT = 260;
const PAD = { top: 16, right: 18, bottom: 28, left: 54 };

/**
 * What a unit staked at the open is worth over the market's life, under each
 * rule.
 *
 * Both lines start at the same number on purpose. At creation the seed legs
 * are each other's counterparties, so a unit of seed is already worth the
 * whole pool divided by its own book under either rule; everything after that
 * is the rules diverging rather than a difference in where they were measured
 * from.
 *
 * The lines are drawn as steps, not curves. Vesting happens when a vintage is
 * finalized and not in between, and a smooth line through those points would
 * be a drawing of something that did not happen.
 */
export function VestingCurve({
  series,
  freezeAt,
  nowSeconds,
  defaultOutcome,
  markers = [],
}: {
  series: CurveSeries[];
  freezeAt: number;
  nowSeconds: number;
  defaultOutcome: number;
  markers?: CurveMarker[];
}) {
  const [selected, setSelected] = useState(defaultOutcome);
  const gradientId = useId();
  const active = series.find((entry) => entry.outcome === selected) ?? series[0];

  const geometry = useMemo(() => (active === undefined ? null : layout(active, freezeAt, nowSeconds)), [
    active,
    freezeAt,
    nowSeconds,
  ]);

  if (active === undefined || geometry === null) {
    return (
      <p className="px-4 py-8 text-sm text-muted sm:px-5">
        No history is available for this market yet. The curve needs the entries the market has taken; once one
        lands it is drawn here.
      </p>
    );
  }

  const last = active.points[active.points.length - 1];
  const stroke = STROKE[active.tone];

  return (
    <div>
      {/* A group of toggles, not a tablist: there is one chart and it changes,
          rather than several panels to switch between, and claiming the tab
          pattern would promise a screen reader panels that are not there. */}
      {series.length > 1 ? (
        <div className="scroll-x flex gap-1 border-b border-edge px-4 py-2 sm:px-5" role="group" aria-label="Outcome">
          {series.map((entry) => (
            <button
              key={entry.outcome}
              type="button"
              aria-pressed={entry.outcome === selected}
              onClick={() => setSelected(entry.outcome)}
              className={`shrink-0 px-3 py-1.5 text-sm transition-colors ${
                entry.outcome === selected ? 'bg-paper/10 font-semibold text-paper' : 'text-muted hover:text-paper'
              }`}
            >
              {entry.label}
            </button>
          ))}
        </div>
      ) : null}

      <div className="px-2 pb-2 pt-4 sm:px-3">
        <svg
          viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
          className="h-auto w-full"
          role="img"
          aria-label={`One unit staked on ${active.label} at the open is worth ${format(
            last?.vpm ?? 1,
          )} times its stake under the vested rule and ${format(last?.classic ?? 1)} times under the classic rule.`}
        >
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              {/* A flat 8% wash under the vested line. Not a glow and not a
                  gradient in the brand sense — two stops of the same colour,
                  used only to say which side of the classic line it is on. */}
              <stop offset="0%" stopColor={stroke} stopOpacity="0.16" />
              <stop offset="100%" stopColor={stroke} stopOpacity="0.16" />
            </linearGradient>
          </defs>

          {geometry.ticks.map((tick) => (
            <g key={tick.value}>
              <line
                x1={PAD.left}
                x2={WIDTH - PAD.right}
                y1={tick.y}
                y2={tick.y}
                stroke="var(--color-edge)"
                strokeWidth="1"
                vectorEffect="non-scaling-stroke"
              />
              <text
                x={PAD.left - 8}
                y={tick.y + 4}
                textAnchor="end"
                className="num"
                fill="var(--color-faint)"
                fontSize="11"
              >
                {format(tick.value)}x
              </text>
            </g>
          ))}

          {/* The difference between the two rules, as an area. */}
          <path d={geometry.area} fill={`url(#${gradientId})`} />

          <path
            d={geometry.classicPath}
            fill="none"
            stroke="var(--color-muted)"
            strokeWidth="1.5"
            strokeDasharray="4 4"
            vectorEffect="non-scaling-stroke"
          />
          <path
            d={geometry.vpmPath}
            fill="none"
            stroke={stroke}
            strokeWidth="2"
            vectorEffect="non-scaling-stroke"
          />

          {markers
            .filter((marker) => marker.outcome === active.outcome)
            .map((marker) => {
              const x = geometry.scaleX(marker.t);
              return (
                <g key={`${marker.t}-${marker.label}`}>
                  <line
                    x1={x}
                    x2={x}
                    y1={PAD.top}
                    y2={HEIGHT - PAD.bottom}
                    stroke="var(--color-paper)"
                    strokeOpacity="0.35"
                    strokeWidth="1"
                    vectorEffect="non-scaling-stroke"
                  />
                  <text x={x + 5} y={PAD.top + 11} className="num" fill="var(--color-muted)" fontSize="10">
                    {marker.label}
                  </text>
                </g>
              );
            })}

          <line
            x1={PAD.left}
            x2={WIDTH - PAD.right}
            y1={HEIGHT - PAD.bottom}
            y2={HEIGHT - PAD.bottom}
            stroke="var(--color-edge)"
            strokeWidth="1"
            vectorEffect="non-scaling-stroke"
          />
          <text x={PAD.left} y={HEIGHT - 8} className="num" fill="var(--color-faint)" fontSize="11">
            {formatUtcDate(geometry.tMin)}
          </text>
          <text
            x={WIDTH - PAD.right}
            y={HEIGHT - 8}
            textAnchor="end"
            className="num"
            fill="var(--color-faint)"
            fontSize="11"
          >
            {formatUtcDate(geometry.tMax)}
          </text>
        </svg>
      </div>

      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 border-t border-edge px-4 py-3 text-xs sm:px-5">
        <span className="flex items-center gap-2">
          <span aria-hidden className="inline-block h-0.5 w-6" style={{ background: stroke }} />
          <span className="text-muted">Vested</span>
          <span className="num text-paper">{format(last?.vpm ?? 1)}x</span>
        </span>
        <span className="flex items-center gap-2">
          <span
            aria-hidden
            className="inline-block h-0 w-6 border-t-2 border-dashed"
            style={{ borderColor: 'var(--color-muted)' }}
          />
          <span className="text-muted">Classic pool</span>
          <span className="num text-paper">{format(last?.classic ?? 1)}x</span>
        </span>
        <span className="text-muted">
          {last === undefined || Math.abs(last.vpm - last.classic) < 0.005 ? (
            'The two rules currently pay an opening unit the same.'
          ) : last.vpm > last.classic ? (
            <>
              The vested rule pays an opening unit{' '}
              <span className="num text-paper">{format(last.vpm - last.classic)}x</span> more.
            </>
          ) : (
            <>
              The classic rule pays an opening unit{' '}
              <span className="num text-paper">{format(last.classic - last.vpm)}x</span> more.
            </>
          )}
        </span>
      </div>
    </div>
  );
}

interface Geometry {
  vpmPath: string;
  classicPath: string;
  area: string;
  ticks: { value: number; y: number }[];
  tMin: number;
  tMax: number;
  scaleX: (t: number) => number;
}

function layout(series: CurveSeries, freezeAt: number, nowSeconds: number): Geometry | null {
  const points = series.points;
  const first = points[0];
  if (first === undefined) return null;

  const tMin = first.t;
  // The x axis runs to whichever is later: the freeze, or now. A market that
  // has already frozen should not draw its last day off the end of the chart.
  const tMax = Math.max(freezeAt, nowSeconds, points[points.length - 1]?.t ?? first.t);
  const span = Math.max(1, tMax - tMin);

  let high = 1;
  let low = Number.POSITIVE_INFINITY;
  for (const point of points) {
    high = Math.max(high, point.vpm, point.classic);
    low = Math.min(low, point.vpm, point.classic);
  }
  if (!Number.isFinite(low)) low = 1;
  // Always include 1x — the line "you got your stake back and nothing else"
  // is the one a reader measures everything else against.
  low = Math.min(low, 1);
  const range = high - low;
  const padded = range < 0.02 ? 0.5 : range * 0.12;
  const yMin = Math.max(0, low - padded);
  const yMax = high + padded;

  const scaleX = (t: number): number =>
    PAD.left + ((t - tMin) / span) * (WIDTH - PAD.left - PAD.right);
  const scaleY = (value: number): number =>
    HEIGHT - PAD.bottom - ((value - yMin) / Math.max(1e-9, yMax - yMin)) * (HEIGHT - PAD.top - PAD.bottom);

  // Extend the last sample forward to the right edge: nothing has vested since
  // the last vintage, and the flat run is the truthful shape of that.
  const extended = [...points, { t: tMax, vpm: points[points.length - 1]?.vpm ?? 1, classic: points[points.length - 1]?.classic ?? 1 }];

  const step = (pick: (point: CurvePoint) => number): string => {
    let path = '';
    let previous: number | null = null;
    for (const point of extended) {
      const x = scaleX(point.t);
      const y = scaleY(pick(point));
      if (previous === null) {
        path += `M ${x.toFixed(2)} ${y.toFixed(2)}`;
      } else {
        path += ` L ${x.toFixed(2)} ${previous.toFixed(2)} L ${x.toFixed(2)} ${y.toFixed(2)}`;
      }
      previous = y;
    }
    return path;
  };

  const vpmPath = step((point) => point.vpm);
  const classicPath = step((point) => point.classic);
  // The area between the two step lines: forward along one, back along the other.
  const area = `${vpmPath} ${reverseStep(extended, scaleX, scaleY)} Z`;

  const ticks = niceTicks(yMin, yMax).map((value) => ({ value, y: scaleY(value) }));

  return { vpmPath, classicPath, area, ticks, tMin, tMax, scaleX };
}

function reverseStep(
  points: CurvePoint[],
  scaleX: (t: number) => number,
  scaleY: (value: number) => number,
): string {
  let path = '';
  let previous: number | null = null;
  for (let i = points.length - 1; i >= 0; i--) {
    const point = points[i];
    if (point === undefined) continue;
    const x = scaleX(point.t);
    const y = scaleY(point.classic);
    if (previous === null) {
      path += ` L ${x.toFixed(2)} ${y.toFixed(2)}`;
    } else {
      path += ` L ${x.toFixed(2)} ${previous.toFixed(2)} L ${x.toFixed(2)} ${y.toFixed(2)}`;
    }
    previous = y;
  }
  return path;
}

/** Four or five round numbers across the range, so the axis reads at a glance. */
function niceTicks(min: number, max: number): number[] {
  const span = max - min;
  if (span <= 0) return [min];
  const raw = span / 4;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((factor) => factor * magnitude).find((candidate) => candidate >= raw) ?? magnitude * 10;
  const ticks: number[] = [];
  for (let value = Math.ceil(min / step) * step; value <= max + 1e-9; value += step) {
    ticks.push(Number(value.toFixed(6)));
  }
  return ticks;
}

/**
 * Multiples are display-only, so they are the one place a ratio becomes a
 * float. Nothing downstream of this number is money.
 */
function format(value: number): string {
  if (!Number.isFinite(value)) return '—';
  if (Math.abs(value) >= 100) return value.toFixed(0);
  if (Math.abs(value) >= 10) return value.toFixed(1);
  return value.toFixed(2);
}
