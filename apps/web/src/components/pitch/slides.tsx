import type { CSSProperties } from 'react';

import { HunchLockup, HunchMark } from '@/components/brand/HunchLockup';
import {
  EXAMPLE_FACTS,
  PAPER,
  FEED_TICKERS,
  FEE_SCENARIOS,
  LANDSCAPE,
  LIVE,
  MILESTONES,
  PITCH,
  PROBLEM,
  STOCK_TOKENS_ON_CHAIN,
  TAILWINDS,
  TEAM,
  TRACK_RECORD,
  USE_OF_FUNDS,
  VISION,
  WAVE,
  WHY_WE_WIN,
} from '@/content/pitch';
import { LINKS, addressUrl } from '@/lib/site';
import { shortAddress } from '@/lib/units';

import { Arrow, Atmosphere, Check, Cross, Dot, Lead, Shell, Source, Tag, Title, rv } from './parts';

/**
 * The thirteen slides, in the order an investor asks the questions: what is it, why now, what is
 * broken, why it stays broken, the fix, the research behind it, the product, the proof, the
 * money, the field, where it goes, who, and the ask. Every number comes from `@/content/pitch` (and through it from the
 * deployment file, the contract mirror, a dated production read or a named source); nothing is
 * typed here.
 */

export const SLIDE_LABELS = [
  'Hunch',
  'The opportunity',
  'The problem',
  'Why it stays broken',
  'Our insight',
  'The research',
  'The product',
  'Traction',
  'Business model',
  'Competition',
  'Where this goes',
  'Team',
  'The raise',
] as const;

const LIVE_TICKERS = new Set<string>(LIVE.tickers);
const tickerList = LIVE.tickers.join(', ').replace(/, (\w+)$/, ' and $1');

// ================================================================================================
// 01 · Cover

export function Cover() {
  return (
    <>
      <Atmosphere tone="lime" />
      <div className="absolute left-[120px] right-[120px] top-[84px] flex items-center justify-between">
        <HunchLockup className="h-[46px] w-auto" />
        <Tag>
          {PITCH.round} · {PITCH.dateline}
        </Tag>
      </div>

      <div className="absolute left-[120px] top-[244px] w-[1060px]">
        <p className="rv pitch-kicker flex items-center gap-4 text-lime" style={rv(0)}>
          <span className="pitch-live-dot" aria-hidden />
          Live on Robinhood Chain mainnet
        </p>
        <h1 className="rv pitch-title mt-9 text-[96px] text-paper" style={rv(1)}>
          The prediction market
          <br />
          for everything else<Dot />
        </h1>
        <p className="rv pitch-lead mt-9 max-w-[960px] text-[30px] leading-[1.45] text-muted" style={rv(2)}>
          Kalshi and Polymarket price the headlines. Hunch prices the long tail, starting with a daily market on every
          Robinhood Stock Token, on a payout rule that rewards whoever calls it first.
        </p>
        <p className="rv mt-10 flex items-center gap-5" style={rv(4)}>
          <span className="pitch-title text-[40px] text-lime">Call it early. Get paid more.</span>
        </p>
        <a
          href={LINKS.paper}
          target="_blank"
          rel="noreferrer"
          className="rv mt-7 inline-flex items-center gap-5 rounded-full border border-edge-strong bg-white/[0.03] py-3 pl-4 pr-7 hover:border-lime/40"
          style={rv(5)}
        >
          <span className="rounded-full bg-paper px-4 py-[6px] text-[15px] font-semibold text-ink">Published research</span>
          <span className="text-[19px] text-muted">
            <span className="text-paper">{PAPER.title}</span> · {PAPER.publisher}, {PAPER.edition}
          </span>
        </a>
      </div>

      <div className="rv absolute right-[120px] top-[232px] w-[600px]" style={rv(3)}>
        <TickerWall />
      </div>

      <div className="absolute bottom-[64px] left-[120px] right-[120px] flex items-center justify-between border-t border-edge pt-6 text-[19px] text-faint">
        <span>
          <span className="text-paper">Raj Karia</span>, CEO · <span className="text-paper">Prachi Sahani</span>, CTO
        </span>
        <span className="num">Robinhood Chain · USDG · Chainlink</span>
        <span className="text-paper">{PITCH.domain}</span>
      </div>
    </>
  );
}

/** Every Stock Token Hunch can list today, the live ones lit: the size of the first step. */
function TickerWall() {
  return (
    <figure className="pitch-card px-8 pb-7 pt-7">
      <figcaption className="flex items-center justify-between">
        <span className="text-[20px] font-semibold text-paper">Robinhood Stock Tokens with a Chainlink price</span>
        <span className="flex items-center gap-3 text-[16px] text-lime">
          <span className="h-[9px] w-[9px] rounded-full bg-lime" aria-hidden /> Live
        </span>
      </figcaption>
      <ul className="mt-6 grid grid-cols-6 gap-[9px]" aria-label="Tickers">
        {FEED_TICKERS.map((ticker) => {
          const live = LIVE_TICKERS.has(ticker);
          return (
            <li
              key={ticker}
              className={`num relative flex h-[54px] items-center justify-center rounded-[10px] border text-[17px] ${
                live ? 'border-lime/60 bg-lime/[0.12] text-lime' : 'border-edge bg-white/[0.02] text-faint'
              }`}
            >
              {ticker}
              {live ? <span className="absolute right-[7px] top-[7px] h-[6px] w-[6px] rounded-full bg-lime" aria-hidden /> : null}
            </li>
          );
        })}
      </ul>
      <dl className="mt-6 grid grid-cols-3 border-t border-edge pt-5">
        {[
          { value: String(LIVE.tickers.length), label: 'live today' },
          { value: String(FEED_TICKERS.length), label: 'priced by Chainlink' },
          { value: STOCK_TOKENS_ON_CHAIN, label: 'Stock Tokens on chain' },
        ].map((fact, i) => (
          <div key={fact.label} className={i > 0 ? 'border-l border-edge pl-6' : ''}>
            <dt className={`pitch-title text-[38px] ${i === 0 ? 'text-lime' : 'text-paper'}`}>{fact.value}</dt>
            <dd className="mt-1 text-[16px] text-faint">{fact.label}</dd>
          </div>
        ))}
      </dl>
    </figure>
  );
}

// ================================================================================================
// 02 · The opportunity

export function Opportunity() {
  return (
    <Shell n={2} section="The opportunity" tone="violet">
      <Title>
        Prediction markets grew {WAVE.growth} in {WAVE.span}
        <Dot />
      </Title>

      <div className="mt-10 grid flex-1 grid-cols-[1fr_560px] gap-8">
        <figure className="rv pitch-card flex flex-col px-9 pb-6 pt-7" style={rv(2)}>
          <figcaption className="text-[22px] font-semibold text-paper">
            Kalshi and Polymarket, combined volume a month
          </figcaption>
          <WaveChart />
          <Source>{WAVE.source}</Source>
        </figure>

        <div className="flex flex-col gap-5">
          {TAILWINDS.map((wind, i) => (
            <div key={wind.label} className="rv pitch-card flex flex-1 flex-col justify-center px-8 py-5" style={rv(3 + i)}>
              <p className="flex items-baseline gap-5">
                <span className={`pitch-title text-[52px] ${i === 0 ? 'text-lime' : 'text-violet'}`}>{wind.value}</span>
                <span className="text-[20px] font-semibold leading-[1.3] text-paper">{wind.label}</span>
              </p>
              <p className="mt-2 text-[17px] leading-[1.45] text-muted">{wind.detail}</p>
              <Source className="mt-1">{wind.source}</Source>
            </div>
          ))}
        </div>
      </div>
    </Shell>
  );
}

/** Monthly volume bars, with a visible break where the months are not published one by one. */
function WaveChart() {
  const W = 1000;
  const H = 470;
  const X0 = 20;
  const X1 = 990;
  const Y0 = 64;
  const Y1 = 410;
  const MAX = 60;
  const months = WAVE.months;
  const slot = (X1 - X0) / (months.length + 1);
  const barW = 90;
  const cx = (i: number): number => X0 + slot * ((i === 0 ? 0 : i + 1) + 0.5);
  const y = (v: number): number => Y1 - (v / MAX) * (Y1 - Y0);
  const peak = months.reduce((best, month, i) => (month.value > months[best]!.value ? i : best), 0);
  const first = months[0]!;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="my-3 block w-full flex-1" role="img" aria-label={`Combined monthly volume rose from ${first.display} in ${first.label} to ${months[peak]!.display} in ${months[peak]!.label}.`}>
      {[20, 40, 60].map((v) => (
        <line key={v} x1={X0} x2={X1} y1={y(v)} y2={y(v)} stroke="rgba(255,255,255,0.06)" />
      ))}
      <line x1={X0} x2={X1} y1={Y1} y2={Y1} stroke="rgba(255,255,255,0.16)" />

      {/* The unpublished months. */}
      <text x={X0 + slot * 1.5} y={Y1 - 18} textAnchor="middle" fill="rgba(244,244,242,0.35)" fontSize="26" letterSpacing="6">
        ···
      </text>
      <text x={X0 + slot * 1.5} y={Y1 + 38} textAnchor="middle" fill="rgba(244,244,242,0.3)" fontSize="15" fontFamily="var(--font-mono)">
        Oct–Mar
      </text>

      {months.map((month, i) => {
        const isPeak = i === peak;
        const fill = i === 0 ? 'rgba(244,244,242,0.28)' : isPeak ? '#C8F04F' : 'rgba(200,240,79,0.4)';
        return (
          <g key={month.label}>
            <rect x={cx(i) - barW / 2} y={y(month.value)} width={barW} height={Y1 - y(month.value)} rx="10" fill={fill} className="grow-y" style={{ '--d': 3 + i } as CSSProperties} />
            <text x={cx(i)} y={y(month.value) - 16} textAnchor="middle" fill={isPeak ? '#C8F04F' : '#F4F4F2'} fontSize={isPeak ? 30 : 22} fontFamily="var(--font-mono)" fontWeight="500">
              {month.display}
            </text>
            <text x={cx(i)} y={Y1 + 38} textAnchor="middle" fill="rgba(244,244,242,0.55)" fontSize="17" fontFamily="var(--font-mono)">
              {month.label}
            </text>
          </g>
        );
      })}

      {/* From the first bar to the peak. */}
      <path
        d={`M${cx(0)} ${y(first.value) - 54} C${cx(0) + 40} ${Y0 + 10}, ${cx(peak) - 260} ${Y0 - 30}, ${cx(peak) - 70} ${y(months[peak]!.value) - 24}`}
        fill="none"
        stroke="#C8F04F"
        strokeWidth="2.5"
        strokeDasharray="2 9"
        strokeLinecap="round"
        opacity="0.8"
      />
      <g transform={`translate(${cx(0) + 150} ${Y0 + 46})`}>
        <rect x="-62" y="-30" width="124" height="60" rx="30" fill="#08080A" stroke="rgba(200,240,79,0.6)" />
        <text x="0" y="12" textAnchor="middle" fill="#C8F04F" fontSize="34" fontFamily="var(--font-display)" fontWeight="800">
          {WAVE.growth}
        </text>
      </g>
    </svg>
  );
}

// ================================================================================================
// 03 · The problem

export function Problem() {
  return (
    <Shell n={3} section="The problem" tone="coral">
      <Title>
        Prediction markets price the headlines.
        <br />
        Everything else sits empty.
      </Title>

      <div className="rv mt-9 flex items-center gap-6" style={rv(1)}>
        <span className="text-[24px] text-muted">A trader asks</span>
        <span className="flex items-center gap-5 rounded-full border border-edge-strong bg-white/[0.04] py-4 pl-7 pr-9">
          <svg viewBox="0 0 24 24" className="h-[28px] w-[28px] text-faint" aria-hidden>
            <circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" strokeWidth="2" />
            <path d="M16.5 16.5L21 21" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
          <span className="text-[30px] font-semibold text-paper">{PROBLEM.question}</span>
        </span>
        <span className="text-[24px] text-muted">Today there are three answers, and none of them works.</span>
      </div>

      <div className="mt-8 grid flex-1 grid-cols-3 gap-7">
        {PROBLEM.answers.map((answer, i) => (
          <div key={answer.tool} className="rv pitch-card flex flex-col px-9 pb-6 pt-7" style={rv(2 + i)}>
            <p className="flex items-center gap-3">
              <Cross />
              <span className="text-[24px] font-semibold text-paper">{answer.tool}</span>
            </p>
            <p className="pitch-title mt-6 text-[92px] text-coral">{answer.value}</p>
            <p className="mt-3 text-[24px] font-semibold leading-[1.3] text-paper">{answer.stat}</p>
            <p className="mt-3 text-[20px] leading-[1.5] text-muted">{answer.body}</p>
            <Source className="mt-auto pt-4">{answer.source}</Source>
          </div>
        ))}
      </div>

      <p className="rv mt-7 text-[26px] leading-[1.4] text-paper" style={rv(6)}>
        The appetite for a quick call on a stock is proven. <span className="text-lime">Nobody serves it simply.</span>
      </p>
    </Shell>
  );
}

// ================================================================================================
// 04 · Why it stays broken

export function RootCause() {
  const panels = [
    {
      kind: 'Order books',
      who: 'Kalshi, Polymarket',
      verdict: 'No maker, no market',
      body: 'Someone has to quote both sides of every market. Market makers show up for the Super Bowl and the Fed, not for TSLA on a Thursday.',
      stat: undefined,
      visual: <EmptyBook />,
    },
    {
      kind: 'Pools',
      who: 'Tote, most on-chain pools',
      verdict: 'No first bettor, no market',
      body: 'Every winner is paid the same multiple, so the smart move is to wait, and nobody goes first. Operators close betting early to stop the snipers.',
      stat: {
        value: PAPER.results[0].value.split(' ')[0]!,
        text: 'of the losing pool went to winners who arrived in the last 10% of a market (median, replayed tape)',
      },
      visual: <SameTickets />,
    },
  ];
  return (
    <Shell n={4} section="Why it stays broken" tone="coral">
      <Title>
        The long tail is empty because
        <br />
        nobody is paid to go first.
      </Title>

      <div className="mt-10 grid flex-1 grid-cols-2 gap-8">
        {panels.map((panel, i) => (
          <div key={panel.kind} className="rv pitch-card flex flex-col px-10 py-8" style={rv(1 + i * 2)}>
            <p className="flex items-center gap-4">
              <Tag tone="coral">{panel.kind}</Tag>
              <span className="text-[19px] text-faint">{panel.who}</span>
            </p>
            <div className="mt-6">{panel.visual}</div>
            <h3 className="mt-7 font-body text-[32px] font-semibold tracking-[-0.01em] text-paper">{panel.verdict}</h3>
            <p className="mt-3 text-[21px] leading-[1.5] text-muted">{panel.body}</p>
            {panel.stat === undefined ? null : (
              <p className="mt-auto flex items-center gap-6 border-t border-edge pt-5">
                <span className="pitch-title text-[56px] text-coral">{panel.stat.value}</span>
                <span className="text-[18px] leading-[1.4] text-muted">{panel.stat.text}</span>
              </p>
            )}
          </div>
        ))}
      </div>

      <p className="rv mt-8 flex items-center gap-5 text-[27px] leading-[1.4] text-paper" style={rv(5)}>
        <Arrow className="text-lime" />
        <span>
          Both are cold-start problems. <span className="text-lime">Pay whoever goes first, and any market can open itself.</span>
        </span>
      </p>
    </Shell>
  );
}

/** An order book for a long-tail question: the ladder is there, the quotes are not. */
function EmptyBook() {
  const row = (side: 'ask' | 'bid', key: number) => (
    <div key={`${side}${key}`} className="grid grid-cols-[70px_1fr_90px] items-center gap-5">
      <span className={`num text-[15px] ${side === 'ask' ? 'text-coral/60' : 'text-lime/60'}`}>{side.toUpperCase()}</span>
      <span className="h-[22px] rounded-[6px] border border-dashed border-paper/15" />
      <span className="num text-right text-[17px] text-faint">0</span>
    </div>
  );
  return (
    <div className="rounded-[16px] border border-edge bg-white/[0.02] px-7 py-5">
      <p className="flex items-center justify-between text-[17px]">
        <span className="text-paper">Will TSLA close UP today?</span>
        <span className="num text-faint">0 quotes</span>
      </p>
      <div className="mt-4 space-y-[9px]">
        {[0, 1].map((k) => row('ask', k))}
        <p className="py-1 text-center text-[16px] text-faint">Waiting for a market maker</p>
        {[0, 1].map((k) => row('bid', k))}
      </div>
    </div>
  );
}

/** A pool pays the open and the last minute the same multiple. */
function SameTickets() {
  const ticket = (when: string, note: string) => (
    <div className="flex-1 rounded-[16px] border border-edge bg-white/[0.02] px-6 py-5">
      <p className="flex items-center justify-between">
        <span className="num text-[18px] text-paper">{when}</span>
        <Tag tone="lime">UP</Tag>
      </p>
      <p className="mt-1 text-[16px] text-faint">{note}</p>
      <p className="mt-3 flex items-baseline gap-3">
        <span className="pitch-title text-[52px] text-paper">{EXAMPLE_FACTS.classicMultiple}</span>
        <span className="text-[16px] text-muted">per dollar</span>
      </p>
    </div>
  );
  return (
    <div className="flex items-center gap-5">
      {ticket(EXAMPLE_FACTS.mei.when, 'Called it at the open')}
      <span className="pitch-title text-[64px] leading-none text-coral">=</span>
      {ticket(EXAMPLE_FACTS.ben.when, 'Five minutes before the bell')}
    </div>
  );
}

// ================================================================================================
// 05 · Our insight

export function Insight() {
  const { mei, ben } = EXAMPLE_FACTS;
  const outcomes = [
    {
      value: mei.multiple,
      title: 'The early call is paid the most',
      body: `${mei.name} called it ${mei.when.replace('Tue', 'Tuesday')}. An ordinary pool would pay her ${EXAMPLE_FACTS.classicMultiple}.`,
    },
    {
      value: ben.multiple,
      title: 'A late bet still wins, never dilutes',
      body: `${ben.name} bet five minutes before the bell: his stake back plus the ${ben.gain} that came after him.`,
    },
  ];
  return (
    <Shell n={5} section="Our insight" tone="lime">
      <Title>
        Pay whoever goes first.
        <br />
        The market fills itself<Dot />
      </Title>

      <div className="mt-9 grid flex-1 grid-cols-[820px_1fr] gap-14">
        <div className="rv" style={rv(2)}>
          <EntryCurve />
        </div>

        <div className="flex flex-col">
          <Lead d={1} className="text-[26px]">
            Our settlement rule, the <span className="text-paper">Vested Parimutuel</span>, pays every new stake straight to the
            bettors already on the other side.
          </Lead>

          <div className="mt-8 space-y-6">
            {outcomes.map((outcome, i) => (
              <div key={outcome.title} className="rv grid grid-cols-[150px_1fr] items-center gap-6 border-t border-edge pt-5" style={rv(3 + i)}>
                <span className="pitch-title text-[54px] text-lime">{outcome.value}</span>
                <span>
                  <span className="block text-[22px] font-semibold text-paper">{outcome.title}</span>
                  <span className="mt-1 block text-[18px] leading-[1.45] text-muted">{outcome.body}</span>
                </span>
              </div>
            ))}
            <div className="rv grid grid-cols-[150px_1fr] items-center gap-6 border-t border-edge pt-5" style={rv(5)}>
              <span className="flex h-[54px] items-center">
                <Check className="h-[44px] w-[44px] text-lime" />
              </span>
              <span>
                <span className="block text-[22px] font-semibold text-paper">No market maker, open until the bell</span>
                <span className="mt-1 block text-[18px] leading-[1.45] text-muted">
                  Our opening seed is floored in every outcome, so opening a market risks nothing.
                </span>
              </span>
            </div>
          </div>

          <a href={LINKS.paper} target="_blank" rel="noreferrer" className="rv mt-auto flex items-center gap-4 border-t border-edge pt-5 text-[19px] text-muted hover:text-paper" style={rv(6)}>
            <span className="rounded-full bg-paper px-3 py-[5px] text-[14px] font-semibold text-ink">Published</span>
            <span>
              Each one is proved in our paper, <span className="text-paper">{PAPER.title}</span>
            </span>
            <Arrow className="ml-auto h-[22px] w-[22px]" />
          </a>

        </div>
      </div>
    </Shell>
  );
}

/** Hours after Tuesday's opening bell (wall clock) to hours of trading (6.5 a session). */
function sessionHours(hoursIn: number): number {
  const day = Math.floor(hoursIn / 24);
  return day * 6.5 + Math.min(6.5, hoursIn - day * 24);
}

const ppmToNumber = (ppm: bigint): number => Number(ppm) / 1_000_000;

/** What a small UP bet is paid per dollar, by when it lands, against a pool's flat line. */
function EntryCurve() {
  const W = 600;
  const H = 300;
  const X0 = 46;
  const X1 = 588;
  const Y0 = 18;
  const Y1 = 256;
  const SESSION = 26;
  const x = (t: number): number => X0 + (t / SESSION) * (X1 - X0);
  const y = (m: number): number => Y1 - ((m - 0.5) / 3.25) * (Y1 - Y0);

  const steps = EXAMPLE_FACTS.curve.map((step) => ({ from: sessionHours(step.from), to: sessionHours(step.to), m: ppmToNumber(step.ppm) }));
  const path = steps
    .map((step, i) => `${i === 0 ? `M${x(step.from)} ${y(step.m)}` : `V${y(step.m)}`} H${x(step.to)}`)
    .join(' ');
  const area = `${path} V${Y1} H${x(0)} Z`;
  const classic = ppmToNumber(EXAMPLE_FACTS.classicPpm);
  const mei = { t: sessionHours(EXAMPLE_FACTS.mei.hoursIn), m: ppmToNumber(EXAMPLE_FACTS.mei.multiplePpm) };
  const ben = { t: sessionHours(EXAMPLE_FACTS.ben.hoursIn), m: ppmToNumber(EXAMPLE_FACTS.ben.multiplePpm) };
  const downs = EXAMPLE_FACTS.bets.filter((bet) => bet.side === 'DOWN');
  const firstDrop = sessionHours(downs[0]?.hoursIn ?? 0);

  return (
    <figure className="pitch-card px-9 pb-6 pt-6">
      <figcaption className="flex items-start justify-between gap-6">
        <span>
          <span className="block text-[22px] font-semibold text-paper">What a dollar on UP is paid, by when it lands</span>
          <span className="mt-2 block text-[17px] text-faint">{EXAMPLE_FACTS.question} The week, in trading hours.</span>
        </span>
        <Tag>Illustration</Tag>
      </figcaption>

      <svg viewBox={`0 0 ${W} ${H}`} className="mt-5 block w-full" role="img" aria-label={`A bet at Tuesday's open is paid ${EXAMPLE_FACTS.mei.multiple} per dollar; one at Friday's close, ${EXAMPLE_FACTS.ben.multiple}; an ordinary pool pays every winner ${EXAMPLE_FACTS.classicMultiple}.`}>
        <defs>
          <linearGradient id="pitch-curve-fill" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" stopColor="#C8F04F" stopOpacity="0.22" />
            <stop offset="1" stopColor="#C8F04F" stopOpacity="0" />
          </linearGradient>
        </defs>

        {/* The four sessions. */}
        {[1, 2, 3].map((d) => (
          <line key={d} x1={x(d * 6.5)} x2={x(d * 6.5)} y1={Y0} y2={Y1} stroke="rgba(255,255,255,0.07)" strokeDasharray="3 5" />
        ))}
        {['TUE', 'WED', 'THU', 'FRI'].map((day, d) => (
          <text key={day} x={x(d * 6.5 + 3.25)} y={H - 12} textAnchor="middle" fill="rgba(244,244,242,0.45)" fontSize="14" fontFamily="var(--font-mono)" letterSpacing="2">
            {day}
          </text>
        ))}
        {[1, 2, 3].map((m) => (
          <g key={m}>
            <line x1={X0} x2={X1} y1={y(m)} y2={y(m)} stroke="rgba(255,255,255,0.06)" />
            <text x={X0 - 12} y={y(m) + 5} textAnchor="end" fill="rgba(244,244,242,0.45)" fontSize="14" fontFamily="var(--font-mono)">
              {m}×
            </text>
          </g>
        ))}
        <line x1={X0} x2={X1} y1={Y1} y2={Y1} stroke="rgba(255,255,255,0.16)" />

        {/* The DOWN bets that step the curve down. */}
        {downs.map((bet) => (
          <rect key={bet.name} x={x(sessionHours(bet.hoursIn)) - 1.5} y={Y1 - 10} width="3" height="10" rx="1.5" fill="#FF6B7A" />
        ))}

        {/* An ordinary pool: one multiple for every winner. */}
        <line x1={X0} x2={X1} y1={y(classic)} y2={y(classic)} stroke="rgba(244,244,242,0.55)" strokeWidth="2" strokeDasharray="7 7" />
        <text x={X1} y={y(classic) - 12} textAnchor="end" fill="rgba(244,244,242,0.7)" fontSize="15">
          Ordinary pool: {EXAMPLE_FACTS.classicMultiple}
        </text>

        {/* Hunch: early pays more, the last second gets its stake back. */}
        <path d={area} fill="url(#pitch-curve-fill)" />
        <path d={path} fill="none" stroke="#C8F04F" strokeWidth="3.5" strokeLinejoin="round" pathLength={1} className="draw" style={{ '--len': 1 } as CSSProperties} />

        {/* Labels sit to the right of the first DOWN bet, clear of the curve's first drop. */}
        <circle cx={x(mei.t)} cy={y(mei.m)} r="7" fill="#08080A" stroke="#C8F04F" strokeWidth="3" />
        <text x={x(firstDrop) + 18} y={y(mei.m) + 2} fill="#F4F4F2" fontSize="16" fontWeight="600">
          {EXAMPLE_FACTS.mei.name}, {EXAMPLE_FACTS.mei.when}
        </text>
        <text x={x(firstDrop) + 18} y={y(mei.m) + 30} fill="#C8F04F" fontSize="22" fontFamily="var(--font-mono)" fontWeight="500">
          {EXAMPLE_FACTS.mei.multiple}
        </text>

        <circle cx={x(ben.t)} cy={y(ben.m)} r="7" fill="#08080A" stroke="#C8F04F" strokeWidth="3" />
        <text x={x(ben.t) - 16} y={y(ben.m) - 40} textAnchor="end" fill="#F4F4F2" fontSize="16" fontWeight="600">
          {EXAMPLE_FACTS.ben.name}, {EXAMPLE_FACTS.ben.when}
        </text>
        <text x={x(ben.t) - 16} y={y(ben.m) - 14} textAnchor="end" fill="#C8F04F" fontSize="22" fontFamily="var(--font-mono)" fontWeight="500">
          {EXAMPLE_FACTS.ben.multiple}
        </text>
      </svg>

      <div className="mt-4 flex items-center gap-7 text-[16px] text-faint">
        <span className="flex items-center gap-3">
          <span className="h-[3px] w-7 rounded-full bg-lime" aria-hidden /> Hunch
        </span>
        <span className="flex items-center gap-3">
          <span className="h-0 w-7 border-t-2 border-dashed border-paper/55" aria-hidden /> Ordinary pool
        </span>
        <span className="flex items-center gap-3">
          <span className="h-[10px] w-[3px] rounded-full bg-coral" aria-hidden /> A DOWN bet lands
        </span>
      </div>
      <p className="mt-3 text-[15px] text-faint">
        Made-up bettors, the contract&rsquo;s exact arithmetic: seed {EXAMPLE_FACTS.seed} / {EXAMPLE_FACTS.seed} USDG, five bets, NVDA closes up.
      </p>
    </figure>
  );
}

// ================================================================================================
// 06 · The research

export function Research() {
  return (
    <Shell n={6} section="The research" tone="violet">
      <Title>
        We published the rule, proved it,
        <br />
        and replayed it on {PAPER.tape.trades} trades<Dot />
      </Title>

      <div className="mt-9 grid flex-1 grid-cols-[560px_1fr] gap-10">
        <a href={LINKS.paper} target="_blank" rel="noreferrer" className="rv block" style={rv(1)}>
          <PaperCover />
        </a>

        <div className="flex flex-col">
          <div className="grid grid-cols-2 gap-6">
            {PAPER.results.map((result, i) => (
              <div key={result.value} className={`rv pitch-card px-8 py-7 ${i === 0 ? 'pitch-card-strong' : ''}`} style={rv(2 + i)}>
                <p className="pitch-title text-[56px] text-lime">{result.value}</p>
                <p className="mt-3 text-[21px] font-semibold leading-[1.35] text-paper">{result.label}</p>
                <p className="mt-2 text-[17px] leading-[1.45] text-muted">{result.detail}</p>
              </div>
            ))}
          </div>

          <div className="rv mt-6 flex flex-1 flex-col pitch-card px-8 py-6" style={rv(4)}>
            <p className="flex items-baseline justify-between">
              <span className="text-[22px] font-semibold text-paper">Seven properties, each proved</span>
              <span className="text-[16px] text-faint">
                Matched exactly by our mainnet settler on all {LIVE.conformanceVectors} conformance vectors
              </span>
            </p>
            <ol className="mt-4 grid flex-1 grid-cols-2 content-around gap-x-10 gap-y-3">
              {PAPER.properties.map((property, i) => (
                <li key={property} className="flex items-baseline gap-4 text-[19px] text-muted">
                  <span className="num w-[34px] shrink-0 text-[16px] text-lime">P{i + 1}</span>
                  <span>{property}</span>
                </li>
              ))}
            </ol>
          </div>

          <p className="rv mt-4 text-[15px] leading-[1.45] text-faint" style={rv(5)}>
            {PAPER.caveat}
          </p>
        </div>
      </div>
    </Shell>
  );
}

/** The paper's title page, drawn in paper and ink so it reads as the document it is. */
function PaperCover() {
  return (
    <div className="relative flex h-full flex-col overflow-hidden rounded-[20px] bg-paper px-11 py-9 text-ink shadow-[0_40px_90px_rgba(0,0,0,0.55)]">
      <p className="flex items-center justify-between">
        <span className="flex items-center gap-3">
          <HunchMark className="h-[30px] w-[30px]" />
          <span className="pitch-kicker text-[14px] text-ink/70">{PAPER.publisher}</span>
        </span>
        <span className="pitch-kicker text-[13px] text-ink/50">{PAPER.edition}</span>
      </p>
      <p className="pitch-title mt-10 text-[54px] leading-[1.02] text-ink">{PAPER.title}</p>
      <p className="mt-4 text-[21px] leading-[1.4] text-ink/70">{PAPER.subtitle}</p>
      <p className="mt-5 text-[19px] font-semibold text-ink">{PAPER.author}</p>
      <div className="mt-6 space-y-[9px]" aria-hidden>
        {[100, 94, 98, 58].map((w, i) => (
          <span key={i} className="block h-[9px] rounded-full bg-ink/[0.09]" style={{ width: `${w}%` }} />
        ))}
      </div>
      <dl className="mt-auto grid grid-cols-3 gap-4 border-t border-ink/15 pt-5">
        {[
          { value: String(PAPER.sections), label: 'sections' },
          { value: String(PAPER.properties.length), label: 'proved properties' },
          { value: String(LIVE.conformanceVectors), label: 'test vectors' },
        ].map((fact) => (
          <div key={fact.label}>
            <dt className="pitch-title text-[40px] text-ink">{fact.value}</dt>
            <dd className="mt-1 text-[15px] text-ink/60">{fact.label}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-4 font-mono text-[15px] text-ink/60">playhunch.xyz/vpm-whitepaper</p>
    </div>
  );
}

// ================================================================================================
// 07 · The product

export function Product() {
  const steps = [
    { title: 'Pick a stock and a side', body: `Will TSLA close UP today? Will NVDA finish the week UP? Daily and weekly markets on ${tickerList}.` },
    { title: 'One tap. No gas, no ETH', body: 'Fund with USDC from Arbitrum or Base and it lands as USDG. One signature; Hunch pays the gas.' },
    { title: 'Paid at the bell', body: 'Chainlink’s prices at the opening and closing bell decide it. Winners are paid automatically; a stale price refunds everyone.' },
  ];
  return (
    <Shell n={7} section="The product" tone="sky">
      <div className="grid flex-1 grid-cols-[1fr_620px] gap-20">
        <div className="flex flex-col">
          <Title>
            As simple as
            <br />
            UP or DOWN<Dot />
          </Title>
          <Lead className="mt-6">A same-day option, minus the options chain.</Lead>
          <div className="mt-10 flex flex-1 flex-col justify-between">
            {steps.map((step, i) => (
              <div key={step.title} className="rv grid grid-cols-[84px_1fr] gap-6 border-t border-edge pt-6" style={rv(2 + i)}>
                <span className="pitch-title text-[44px] text-lime">0{i + 1}</span>
                <div>
                  <h3 className="font-body text-[30px] font-semibold tracking-[-0.01em] text-paper">{step.title}</h3>
                  <p className="mt-2 text-[21px] leading-[1.5] text-muted">{step.body}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
        <div className="rv self-center" style={rv(3)}>
          <MarketCardMock />
        </div>
      </div>
    </Shell>
  );
}

/** The venue's bet panel, drawn for the slide (the live one is at vpm.playhunch.xyz/m/<id>). */
function MarketCardMock() {
  return (
    <div className="pitch-card overflow-hidden p-0 shadow-[0_40px_80px_rgba(0,0,0,0.5)]">
      <div className="flex items-center justify-between border-b border-edge px-9 py-6">
        <span className="flex items-center gap-4">
          <span className="flex h-[52px] w-[52px] items-center justify-center rounded-[12px] border border-edge-strong bg-white/[0.05] font-mono text-[22px] font-medium">N</span>
          <span>
            <span className="block text-[22px] font-semibold text-paper">NVDA</span>
            <span className="block text-[16px] text-faint">Daily · closes 4:00 pm ET</span>
          </span>
        </span>
        <Tag>Illustration</Tag>
      </div>
      <div className="px-9 pb-9 pt-7">
        <p className="text-[30px] font-semibold leading-tight tracking-[-0.01em] text-paper">Will NVDA close UP today?</p>
        <p className="num mt-3 text-[17px] text-faint">Opening bell $225.66 · 05:42:10 to the bell</p>

        <div className="mt-7 grid grid-cols-2 gap-3">
          <span className="flex h-[64px] items-center justify-center rounded-[14px] border border-lime bg-lime/[0.12] text-[22px] font-semibold text-lime">UP</span>
          <span className="flex h-[64px] items-center justify-center rounded-[14px] border border-edge-strong text-[22px] font-semibold text-muted">DOWN</span>
        </div>

        <div className="mt-6 flex items-center justify-between rounded-[14px] border border-edge-strong bg-white/[0.02] px-6 py-4">
          <span className="text-[18px] text-faint">Amount</span>
          <span className="num text-[26px] text-paper">
            25.00 <span className="text-[18px] text-faint">USDG</span>
          </span>
        </div>

        <dl className="mt-6 space-y-3 text-[18px]">
          <div className="flex justify-between">
            <dt className="text-faint">Accepted now</dt>
            <dd className="num text-paper">25.00</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-faint">If UP wins, at least</dt>
            <dd className="num text-paper">25.00</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-faint">Then, for every DOWN dollar after you</dt>
            <dd className="num text-lime">+ your share</dd>
          </div>
        </dl>

        <span className="mt-7 flex h-[66px] items-center justify-center rounded-[14px] bg-lime text-[21px] font-semibold text-ink">Sign once and bet UP</span>
        <p className="mt-4 text-center text-[15px] text-faint">Refunded in full if the price doesn&rsquo;t move or a feed goes stale.</p>
      </div>
    </div>
  );
}

// ================================================================================================
// 08 · Traction

export function Traction() {
  const [markets, cup] = TRACK_RECORD.engine;
  return (
    <Shell n={8} section="Traction" tone="lime">
      <Title>
        Live on mainnet, and battle-tested
        <br />
        on over a million trades<Dot />
      </Title>

      <div className="mt-8 grid flex-1 grid-cols-[600px_1fr] gap-6">
        <div className="rv pitch-card pitch-card-strong flex flex-col px-9 py-7" style={rv(1)}>
          <p className="pitch-kicker flex items-center gap-4 text-[15px] text-lime">
            <span className="pitch-live-dot" aria-hidden /> Robinhood Chain mainnet
          </p>
          <p className="pitch-title mt-5 text-[64px] text-paper">Live since {LIVE.deployedOn.replace(', 2026', '')}</p>
          <p className="mt-3 text-[20px] leading-[1.45] text-muted">Daily and weekly markets in USDG, settled by Chainlink.</p>
          <p className="mt-5 flex gap-3">
            {LIVE.tickers.map((ticker) => (
              <span key={ticker} className="num rounded-[10px] border border-lime/40 px-4 py-2 text-[19px] text-lime">
                {ticker}
              </span>
            ))}
          </p>
          <ul className="mt-auto space-y-3 border-t border-edge pt-5">
            {LIVE.contracts.map((contract) => (
              <li key={contract.name}>
                <a href={addressUrl(contract.address)} target="_blank" rel="noreferrer" className="flex items-center justify-between text-[17px] hover:text-paper">
                  <span className="flex items-center gap-3 text-paper">
                    <Check className="h-[20px] w-[20px] text-lime" />
                    <span className="font-mono">{contract.name}</span>
                  </span>
                  <span className="num text-faint">{shortAddress(contract.address)}</span>
                </a>
              </li>
            ))}
            <li className="pt-1 text-[15px] leading-[1.45] text-faint">
              Source verified · owned by a 2-of-3 Safe · two adversarial security reviews before mainnet
            </li>
          </ul>
        </div>

        <div className="grid grid-cols-2 grid-rows-2 gap-6">
          {[markets, cup].map((stat, i) => (
            <div key={stat.label} className="rv pitch-card flex flex-col justify-center px-9 py-6" style={rv(2 + i)}>
              <p className="pitch-title text-[76px] text-paper">{stat.value}</p>
              <p className="mt-3 text-[22px] font-semibold leading-[1.3] text-paper">{stat.label}</p>
              <p className="mt-2 text-[17px] leading-[1.45] text-faint">{stat.detail}</p>
            </div>
          ))}
          <div className="rv pitch-card flex flex-col justify-center px-9 py-6" style={rv(4)}>
            <p className="flex items-center gap-3">
              <Tag tone="sky">Proof of concept</Tag>
              <span className="text-[16px] text-faint">Real USDC on Base</span>
            </p>
            <div className="mt-5 grid grid-cols-2 gap-x-6 gap-y-4">
              {TRACK_RECORD.money.map((stat) => (
                <p key={stat.label} className="flex items-baseline gap-3">
                  <span className="pitch-title text-[44px] text-sky">{stat.value}</span>
                  <span className="text-[17px] leading-[1.3] text-muted">{stat.label}</span>
                </p>
              ))}
            </div>
          </div>
          <div className="rv pitch-card flex flex-col justify-center px-9 py-6" style={rv(5)}>
            <p className="flex items-baseline gap-4">
              <span className="pitch-title text-[76px] text-lime">{TRACK_RECORD.agents.value}</span>
              <span className="text-[22px] font-semibold leading-[1.3] text-paper">{TRACK_RECORD.agents.label}</span>
            </p>
            <p className="mt-3 text-[18px] leading-[1.45] text-muted">{TRACK_RECORD.agents.detail}</p>
          </div>
        </div>
      </div>

      <p className="rv mt-5 flex items-center justify-between gap-6 text-[15px] text-faint" style={rv(6)}>
        <span className="flex flex-wrap gap-3">
          {TRACK_RECORD.rails.map((rail) => (
            <span key={rail} className="rounded-full border border-edge-strong px-4 py-[6px] text-[15px] text-muted">
              {rail}
            </span>
          ))}
        </span>
        <span>Hunch production on Base, {TRACK_RECORD.asOf}. Resolver-run markets prove the engine, not demand.</span>
      </p>
    </Shell>
  );
}

// ================================================================================================
// 09 · Business model

export function BusinessModel() {
  const feePct = `${LIVE.feeBps / 100}%`;
  return (
    <Shell n={9} section="Business model" tone="lime">
      <Title>
        We earn when winners are paid.
        <br />
        Opening a market risks nothing<Dot />
      </Title>

      <div className="mt-10 grid flex-1 grid-cols-[600px_1fr] gap-8">
        <div className="rv pitch-card pitch-card-strong flex flex-col px-10 py-9" style={rv(1)}>
          <p className="pitch-title text-[150px] leading-[0.85] text-lime">{feePct}</p>
          <p className="mt-5 text-[26px] font-semibold text-paper">of winners&rsquo; gains, at settlement</p>
          <ul className="mt-7 space-y-4 text-[20px] leading-[1.45] text-muted">
            <li className="flex gap-4">
              <Check />
              <span>About 1% of volume on a balanced book, since winners&rsquo; gains are roughly the losing side.</span>
            </li>
            <li className="flex gap-4">
              <Check />
              <span>No fee to enter. Losing bets pay nothing extra.</span>
            </li>
            <li className="flex gap-4">
              <Check />
              <span>
                Our opening seed is floored in every outcome, and lost money in {PAPER.results[1].value} replayed markets: a revolving
                float, not a subsidy to a market maker.
              </span>
            </li>
          </ul>
        </div>

        <div className="rv pitch-card flex flex-col px-10 py-9" style={rv(2)}>
          <p className="flex items-center justify-between">
            <span className="text-[24px] font-semibold text-paper">What 1% of volume is worth</span>
            <Tag>Illustration, not a forecast</Tag>
          </p>
          <div className="mt-7 grid grid-cols-[1fr_auto_1fr] items-center gap-y-2 text-[18px] text-faint">
            <span className="pitch-kicker text-[14px]">Monthly volume</span>
            <span />
            <span className="pitch-kicker text-right text-[14px]">Yearly revenue</span>
          </div>
          <div className="mt-2 flex flex-1 flex-col justify-around">
            {FEE_SCENARIOS.map((row, i) => (
              <div key={row.monthly} className="grid grid-cols-[1fr_auto_1fr] items-center border-t border-edge py-3">
                <span className={`pitch-title text-[64px] ${i === FEE_SCENARIOS.length - 1 ? 'text-paper' : 'text-muted'}`}>{row.monthly}</span>
                <Arrow className="h-[34px] w-[34px] text-faint" />
                <span className={`pitch-title text-right text-[64px] ${i === FEE_SCENARIOS.length - 1 ? 'text-lime' : 'text-paper'}`}>{row.yearly}</span>
              </div>
            ))}
          </div>
          <p className="border-t border-edge pt-5 text-[18px] leading-[1.5] text-muted">
            For scale: Kalshi and Polymarket traded {WAVE.months.find((m) => m.label === 'Jul')?.display} in July 2026, and Robinhood made{' '}
            {TAILWINDS[0].value} from event contracts in one quarter. Our unit economics will be reported from chain data after the
            first month of markets.
          </p>
        </div>
      </div>
    </Shell>
  );
}

// ================================================================================================
// 10 · Competition

export function Competition() {
  return (
    <Shell n={10} section="Competition" tone="violet">
      <Title>
        They price the headlines.
        <br />
        We price everything else<Dot />
      </Title>

      <div className="mt-9 grid flex-1 grid-cols-[1000px_1fr] gap-10">
        <figure className="rv pitch-card flex flex-col px-8 pb-5 pt-6" style={rv(1)}>
          <LandscapeMap />
          <figcaption className="mt-2 text-[15px] text-faint">Our read of the field, not a measurement.</figcaption>
        </figure>

        <div className="flex flex-col justify-center gap-7">
          <p className="rv pitch-kicker text-[15px] text-lime" style={rv(2)}>
            Why we win the long tail
          </p>
          {WHY_WE_WIN.map((point, i) => (
            <div key={point.title} className="rv border-t border-edge pt-5" style={rv(3 + i)}>
              <p className="flex items-baseline gap-4">
                <span className="num text-[20px] text-lime">0{i + 1}</span>
                <span className="text-[28px] font-semibold tracking-[-0.01em] text-paper">{point.title}</span>
              </p>
              <p className="mt-2 pl-[44px] text-[20px] leading-[1.5] text-muted">{point.body}</p>
            </div>
          ))}
        </div>
      </div>
    </Shell>
  );
}

/** Two questions place every way of pricing a question: who supplies the liquidity, and how far it reaches. */
function LandscapeMap() {
  const W = 1000;
  const H = 590;
  const X0 = 40;
  const X1 = 960;
  const Y0 = 50;
  const Y1 = 540;
  const px = (v: number): number => X0 + v * (X1 - X0);
  const py = (v: number): number => Y1 - v * (Y1 - Y0);
  const MX = px(0.5);
  const MY = py(0.5);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="block w-full flex-1" role="img" aria-label="Order books and pools serve a few headline events; same-day options reach every stock but need market makers; Hunch reaches every stock and fills itself.">
      <rect x={MX} y={Y0} width={X1 - MX} height={MY - Y0} rx="18" fill="rgba(200,240,79,0.06)" stroke="rgba(200,240,79,0.18)" />
      <line x1={X0} x2={X1} y1={MY} y2={MY} stroke="rgba(255,255,255,0.14)" />
      <line x1={MX} x2={MX} y1={Y0} y2={Y1} stroke="rgba(255,255,255,0.14)" />

      <text x={X0} y={Y1 + 36} fill="rgba(244,244,242,0.55)" fontSize="17" fontFamily="var(--font-mono)" letterSpacing="1.5">
        NEEDS A MARKET MAKER
      </text>
      <text x={X1} y={Y1 + 36} textAnchor="end" fill="#C8F04F" fontSize="17" fontFamily="var(--font-mono)" letterSpacing="1.5">
        FILLS ITSELF →
      </text>
      <text x={X0 + 4} y={Y0 - 20} fill="#C8F04F" fontSize="17" fontFamily="var(--font-mono)" letterSpacing="1.5">
        ↑ EVERY STOCK, EVERY SESSION
      </text>
      <text x={X0 + 4} y={Y1 - 14} fill="rgba(244,244,242,0.55)" fontSize="17" fontFamily="var(--font-mono)" letterSpacing="1.5">
        A FEW HEADLINE EVENTS
      </text>

      {LANDSCAPE.map((player) => {
        const hunch = player.name === 'Hunch';
        const cx = px(player.x);
        const cy = py(player.y);
        return (
          <g key={player.name}>
            {hunch ? <circle cx={cx} cy={cy} r="34" fill="rgba(200,240,79,0.12)" /> : null}
            <circle cx={cx} cy={cy} r={hunch ? 15 : 10} fill={hunch ? '#C8F04F' : 'rgba(244,244,242,0.5)'} />
            <text x={cx + (hunch ? 30 : 22)} y={cy - 2} fill={hunch ? '#C8F04F' : '#F4F4F2'} fontSize={hunch ? 32 : 23} fontWeight={hunch ? 800 : 600} fontFamily={hunch ? 'var(--font-display)' : undefined}>
              {player.name}
            </text>
            <text x={cx + (hunch ? 30 : 22)} y={cy + 24} fill="rgba(244,244,242,0.5)" fontSize="16">
              {player.note}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

// ================================================================================================
// 11 · Where this goes

export function Vision() {
  const heights = [290, 360, 430, 500];
  return (
    <Shell n={11} section="Where this goes" tone="violet">
      <Title>
        From four stocks to a market
        <br />
        on everything with a price<Dot />
      </Title>
      <Lead className="mt-6 max-w-[780px] text-[24px]">
        A rule that lets any market open itself can list what no market maker would. Robinhood Chain gives us the prices, the
        dollars and the holders to start.
      </Lead>

      <div className="mt-auto grid grid-cols-4 items-end gap-6">
        {VISION.map((step, i) => {
          const last = i === VISION.length - 1;
          return (
            <div
              key={step.when}
              className={`rv pitch-card flex flex-col px-8 py-7 ${last ? 'pitch-card-strong' : ''}`}
              style={{
                ...rv(2 + i),
                height: `${heights[i]}px`,
                backgroundImage: `linear-gradient(0deg, rgba(200,240,79,${(0.03 + i * 0.035).toFixed(3)}), rgba(255,255,255,0.015) 70%)`,
              }}
            >
              <p className={`pitch-kicker text-[14px] ${last ? 'text-lime' : 'text-faint'}`}>{step.when}</p>
              <p className={`pitch-title mt-3 text-[80px] ${last || i === 0 ? 'text-lime' : 'text-paper'}`}>{step.count}</p>
              <p className="mt-auto text-[24px] font-semibold leading-[1.25] text-paper">{step.title}</p>
              <p className="mt-2 text-[17px] leading-[1.45] text-muted">{step.body}</p>
            </div>
          );
        })}
      </div>
    </Shell>
  );
}

// ================================================================================================
// 12 · Team

export function Team() {
  return (
    <Shell n={12} section="Team" tone="violet">
      <Title>
        The team that wrote the rule<Dot />
      </Title>
      <Lead className="mt-5 text-[24px]">
        Two founders, full time. Three products shipped together, a prediction market run since May, and the paper Hunch settles
        on. Based in Bengaluru. Bootstrapped: nothing raised.
      </Lead>

      <div className="mt-8 grid flex-1 grid-cols-2 gap-8">
        {TEAM.map((person, i) => (
          <div key={person.name} className="rv pitch-card flex flex-col px-10 py-7" style={rv(2 + i)}>
            <div className="flex items-center gap-8">
              <Monogram initials={person.initials} />
              <div>
                <p className="pitch-title text-[52px] text-paper">{person.name}</p>
                <p className="mt-3 flex items-center gap-4">
                  <span className="text-[22px] text-muted">{person.role}</span>
                  <Tag tone="lime">Full time</Tag>
                </p>
                <p className="mt-2 font-mono text-[15px] text-faint">{person.linkedin}</p>
              </div>
            </div>
            <p className="mt-6 text-[22px] font-semibold leading-[1.4] text-paper">{person.lead}</p>
            <ul className="mt-3 space-y-2">
              {person.points.map((point) => (
                <li key={point} className="flex gap-4 text-[19px] leading-[1.5] text-muted">
                  <span className="mt-[11px] h-[6px] w-[6px] shrink-0 rounded-full bg-lime" aria-hidden />
                  <span>{point}</span>
                </li>
              ))}
            </ul>
            <dl className="mt-auto grid grid-cols-3 gap-6 border-t border-edge pt-5">
              {person.stats.map((stat) => (
                <div key={stat.label}>
                  <dt className="pitch-title text-[44px] text-lime">{stat.value}</dt>
                  <dd className="mt-1 text-[17px] text-faint">{stat.label}</dd>
                </div>
              ))}
            </dl>
          </div>
        ))}
      </div>
    </Shell>
  );
}

/** Initials set in the mark's own geometry: a hairline square with the arch cut from its base. */
function Monogram({ initials }: { initials: string }) {
  return (
    <span className="relative flex h-[112px] w-[112px] shrink-0 items-center justify-center rounded-[20px] border border-lime/45 bg-gradient-to-b from-lime/[0.14] to-lime/[0.02]">
      <span className="pitch-title text-[46px] text-lime">{initials}</span>
      <span className="absolute bottom-[-1px] left-1/2 h-[26px] w-[34px] -translate-x-1/2 rounded-t-full border border-b-0 border-lime/45 bg-ink" aria-hidden />
    </span>
  );
}

// ================================================================================================
// 13 · The raise

export function TheRaise() {
  const colors = ['bg-lime', 'bg-violet', 'bg-sky', 'bg-paper/45'];
  const text = ['text-lime', 'text-violet', 'text-sky', 'text-paper'];
  return (
    <Shell n={13} section="The raise" tone="lime">
      <Title>
        Raising a pre-seed round to put a market
        <br />
        on every Stock Token, every session<Dot />
      </Title>

      <div className="mt-9 grid flex-1 grid-cols-[1fr_580px] gap-8">
        <div className="grid grid-cols-3 gap-5">
          {MILESTONES.map((milestone, i) => (
            <div key={milestone.when} className="rv pitch-card flex flex-col px-8 py-7" style={rv(1 + i)}>
              <p className="pitch-kicker text-[15px] text-lime">{milestone.when}</p>
              <p className="mt-3 text-[24px] font-semibold leading-[1.25] text-paper">{milestone.title}</p>
              <ul className="mt-4 space-y-3">
                {milestone.items.map((item) => (
                  <li key={item} className="flex gap-3 text-[18px] leading-[1.45] text-muted">
                    <span className="mt-[10px] h-[5px] w-[5px] shrink-0 rounded-full bg-paper/40" aria-hidden />
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <div className="rv pitch-card flex flex-col px-10 py-7" style={rv(4)}>
          <p className="pitch-kicker text-[15px] text-faint">Use of funds</p>
          <div className="mt-5 flex h-[18px] overflow-hidden rounded-full">
            {USE_OF_FUNDS.map((use, i) => (
              <span key={use.label} className={`grow-x h-full ${colors[i]}`} style={{ width: `${use.share}%`, '--d': 5 + i } as CSSProperties} />
            ))}
          </div>
          <ul className="mt-6 flex flex-1 flex-col justify-between">
            {USE_OF_FUNDS.map((use, i) => (
              <li key={use.label} className="grid grid-cols-[86px_1fr] items-baseline gap-4">
                <span className={`pitch-title text-[40px] ${text[i]}`}>{use.share}%</span>
                <span>
                  <span className="block text-[21px] font-semibold text-paper">{use.label}</span>
                  <span className="block text-[16px] leading-[1.45] text-faint">{use.detail}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      </div>

      <div className="rv mt-7 flex items-center justify-between rounded-[20px] border border-lime/30 bg-lime/[0.05] px-9 py-5" style={rv(6)}>
        <span className="flex items-center gap-6">
          <HunchMark className="h-[44px] w-[44px]" />
          <span className="pitch-title text-[48px] text-paper">
            Call it early<Dot />
          </span>
        </span>
        <span className="flex items-center gap-10 text-[20px] text-muted">
          <span className="text-paper">Raj Karia, CEO</span>
          <a href={PITCH.xUrl} target="_blank" rel="noreferrer" className="hover:text-paper">
            {PITCH.x}
          </a>
          <a href={`https://${PITCH.domain}`} className="hover:text-paper">
            {PITCH.domain}
          </a>
          <a href={LINKS.paper} target="_blank" rel="noreferrer" className="hover:text-paper">
            The paper
          </a>
        </span>
      </div>
    </Shell>
  );
}

/** The deck, in order, for the page and the tests. */
export const SLIDES = [
  Cover,
  Opportunity,
  Problem,
  RootCause,
  Insight,
  Research,
  Product,
  Traction,
  BusinessModel,
  Competition,
  Vision,
  Team,
  TheRaise,
] as const;
