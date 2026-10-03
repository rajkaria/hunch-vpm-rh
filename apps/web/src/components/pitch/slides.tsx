import type { CSSProperties } from 'react';

import { HunchLockup, HunchMark } from '@/components/brand/HunchLockup';
import {
  CHAIN_FACTS,
  EXAMPLE_FACTS,
  LIVE,
  MILESTONES,
  PITCH,
  TAILWINDS,
  TEAM,
  TRACK_RECORD,
  USE_OF_FUNDS,
  type Bettor,
} from '@/content/pitch';
import { LINKS, addressUrl } from '@/lib/site';
import { shortAddress } from '@/lib/units';

import { Arrow, Atmosphere, Check, Cross, Dot, Lead, Shell, Tag, Title, rv } from './parts';

/**
 * The eleven slides, in order. Every number comes from `@/content/pitch` (and through it from
 * the deployment file, the contract mirror, or a dated production read); nothing is typed here.
 */

export const SLIDE_LABELS = [
  'Hunch',
  'The problem',
  'The fix',
  'Early vs late',
  'The product',
  'Why Robinhood Chain',
  'Live on mainnet',
  'Traction',
  'Business model',
  'Team',
  'The raise',
] as const;

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

      <div className="absolute left-[120px] top-[244px] w-[1000px]">
        <p className="rv pitch-kicker flex items-center gap-4 text-lime" style={rv(0)}>
          <span className="pitch-live-dot" aria-hidden />
          Hunch VPM · Live on Robinhood Chain
        </p>
        <h1 className="rv pitch-title mt-10 text-[124px] text-paper" style={rv(1)}>
          Call it early.
          <br />
          Get paid more<Dot />
        </h1>
        <p className="rv pitch-lead mt-10 max-w-[860px] text-[30px] leading-[1.45] text-muted" style={rv(2)}>
          Prediction markets on Robinhood Stock Tokens that pay the first correct call more than the last one, and stay open
          until the closing bell. In USDG, settled by Chainlink.
        </p>
        <dl className="rv mt-14 grid grid-cols-3 border-t border-edge pt-8" style={rv(4)}>
          {[
            { value: 'Live', label: `on Robinhood Chain mainnet since ${LIVE.deployedOn.replace(', 2026', '')}` },
            { value: TRACK_RECORD.engine[0].value, label: `markets settled by Hunch’s engine since ${TRACK_RECORD.since.replace(' 2026', '')}` },
            { value: `${LIVE.feeBps / 100}%`, label: 'of winners’ gains: the only fee' },
          ].map((fact, i) => (
            <div key={fact.label} className={i > 0 ? 'border-l border-edge pl-8' : 'pr-8'}>
              <dt className="pitch-title text-[44px] text-lime">{fact.value}</dt>
              <dd className="mt-2 text-[18px] leading-[1.4] text-muted">{fact.label}</dd>
            </div>
          ))}
        </dl>
      </div>

      <div className="rv absolute right-[120px] top-[226px] w-[640px]" style={rv(3)}>
        <EntryCurve />
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

/** Hours after Tuesday's opening bell (wall clock) to hours of trading (6.5 a session). */
function sessionHours(hoursIn: number): number {
  const day = Math.floor(hoursIn / 24);
  return day * 6.5 + Math.min(6.5, hoursIn - day * 24);
}

const ppmToNumber = (ppm: bigint): number => Number(ppm) / 1_000_000;

/** The cover's chart: what a small UP bet is paid per dollar, by when it lands, against a pool's flat line. */
function EntryCurve() {
  const W = 600;
  const H = 360;
  const X0 = 46;
  const X1 = 588;
  const Y0 = 18;
  const Y1 = 312;
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
    <figure className="pitch-card px-9 pb-8 pt-8">
      <figcaption className="flex items-start justify-between gap-6">
        <span>
          <span className="block text-[22px] font-semibold text-paper">What a dollar on UP is paid, by when it lands</span>
          <span className="mt-2 block text-[17px] text-faint">{EXAMPLE_FACTS.question} The week, in trading hours.</span>
        </span>
        <Tag>Illustration</Tag>
      </figcaption>

      <svg viewBox={`0 0 ${W} ${H}`} className="mt-7 block w-full" role="img" aria-label={`A bet at Tuesday's open is paid ${EXAMPLE_FACTS.mei.multiple} per dollar; one at Friday's close, ${EXAMPLE_FACTS.ben.multiple}; an ordinary pool pays every winner ${EXAMPLE_FACTS.classicMultiple}.`}>
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
          <text key={day} x={x(d * 6.5 + 3.25)} y={H - 14} textAnchor="middle" fill="rgba(244,244,242,0.45)" fontSize="14" fontFamily="var(--font-mono)" letterSpacing="2">
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
          Mei, Tue 9:35 am
        </text>
        <text x={x(firstDrop) + 18} y={y(mei.m) + 30} fill="#C8F04F" fontSize="22" fontFamily="var(--font-mono)" fontWeight="500">
          {EXAMPLE_FACTS.mei.multiple}
        </text>

        <circle cx={x(ben.t)} cy={y(ben.m)} r="7" fill="#08080A" stroke="#C8F04F" strokeWidth="3" />
        <text x={x(ben.t) - 16} y={y(ben.m) - 40} textAnchor="end" fill="#F4F4F2" fontSize="16" fontWeight="600">
          Ben, Fri 3:55 pm
        </text>
        <text x={x(ben.t) - 16} y={y(ben.m) - 14} textAnchor="end" fill="#C8F04F" fontSize="22" fontFamily="var(--font-mono)" fontWeight="500">
          {EXAMPLE_FACTS.ben.multiple}
        </text>
      </svg>

      <div className="mt-5 flex items-center gap-7 text-[16px] text-faint">
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
    </figure>
  );
}

// ================================================================================================
// 02 · The problem

export function Problem() {
  const ticket = (when: string, note: string, d: number) => (
    <div className="rv pitch-card w-[440px] px-9 py-6" style={rv(d)}>
      <p className="flex items-center justify-between">
        <span className="num text-[20px] text-paper">{when}</span>
        <Tag tone="lime">UP</Tag>
      </p>
      <p className="mt-2 text-[19px] text-faint">{note}</p>
      <p className="mt-4 flex items-baseline gap-3">
        <span className="pitch-title text-[60px] text-paper">{EXAMPLE_FACTS.classicMultiple}</span>
        <span className="text-[19px] text-muted">paid per dollar</span>
      </p>
    </div>
  );

  return (
    <Shell n={2} section="The problem" tone="coral">
      <Title>
        Every pool market pays the last dollar
        <br />
        like the first.
      </Title>
      <Lead className="mt-6">
        In a pool (a tote, a sports pool, most on-chain prediction markets) the pot is split at the end, pro rata to stake.
        The dollar that lands at 3:59 pm, answer nearly known, earns what the 9:30 am dollar did.
      </Lead>

      <div className="mt-9 flex items-center gap-8">
        {ticket('Tue 9:35 am', 'Called it at the open. Days of risk.', 2)}
        <div className="rv relative flex flex-1 items-center" style={rv(3)}>
          <span className="h-px flex-1 bg-gradient-to-r from-edge-strong to-coral/50" />
          <span className="pitch-title mx-6 text-[88px] leading-none text-coral">=</span>
          <span className="h-px flex-1 bg-gradient-to-r from-coral/50 to-edge-strong" />
          <span className="absolute -bottom-12 left-0 right-0 text-center text-[18px] text-faint">Same multiple, whatever the timing</span>
        </div>
        {ticket('Fri 3:55 pm', 'Five minutes before the bell.', 4)}
      </div>

      <div className="mt-auto grid grid-cols-3 gap-8">
        {[
          {
            title: 'Nobody goes first',
            body: 'Early money is diluted by everyone who piles in later, so the rational move is to wait. Books open thin and stay thin.',
          },
          {
            title: 'Betting shuts early',
            body: 'To stop late sniping, operators close the window before the best minutes. The product goes dark just as attention peaks.',
          },
          {
            title: 'Order books skip the long tail',
            body: 'Kalshi and Polymarket need market makers quoting both sides. They show up for elections and the Fed, not for TSLA on a Thursday.',
          },
        ].map((card, i) => (
          <div key={card.title} className="rv pitch-card px-9 py-7" style={rv(5 + i)}>
            <p className="num text-[16px] text-coral">0{i + 1}</p>
            <h3 className="mt-2 font-body text-[27px] font-semibold tracking-[-0.01em] text-paper">{card.title}</h3>
            <p className="mt-2 text-[20px] leading-[1.5] text-muted">{card.body}</p>
          </div>
        ))}
      </div>
    </Shell>
  );
}

// ================================================================================================
// 03 · The fix

export function Solution() {
  const { dan } = EXAMPLE_FACTS;
  const properties = [
    { title: 'Early earns more', body: 'If you win, you are paid your stake plus every opposing dollar that arrives after you.' },
    { title: 'Nobody can dilute you', body: 'Your payout can only go up after you bet. Later money adds to it; it never shrinks it.' },
    { title: 'Open until the bell', body: 'A last-second bet gets its stake back plus what comes after it. Nothing to snipe, so nothing to close.' },
    { title: 'Our seed can’t lose', body: 'Hunch’s opening seed is floored in every outcome, so we can open every ticker, every session.' },
  ];
  return (
    <Shell n={3} section="The fix" tone="lime">
      <div className="flex items-start justify-between gap-12">
        <div>
          <Title>
            Pay the people who were
            <br />
            already standing there<Dot />
          </Title>
          <Lead className="mt-6 max-w-[1060px]" d={2}>
            The moment a stake lands, it is paid to the bettors already on the other side, and it is accepted only up to what
            they can cover. We call the rule the <span className="text-paper">Vested Parimutuel</span>.
          </Lead>
        </div>
        <a href={LINKS.paper} target="_blank" rel="noreferrer" className="rv pitch-card mt-2 block w-[560px] shrink-0 px-8 py-7" style={rv(1)}>
          <span className="pitch-kicker block text-[14px] text-lime">Our research</span>
          <span className="mt-3 block text-[22px] font-semibold text-paper">The Vested Parimutuel</span>
          <span className="mt-1 block text-[17px] text-faint">Karia, Hunch Research, 2nd ed., Sep 2026</span>
          <span className="mt-3 block text-[16px] leading-[1.5] text-muted">
            Reference settler in Solidity · {LIVE.conformanceVectors} conformance vectors · replayed over 5,291 real markets
          </span>
        </a>
      </div>
      <div className="mt-10 grid flex-1 grid-cols-[720px_1fr] gap-8">
        <div className="rv pitch-card flex flex-col px-10 py-9" style={rv(2)}>
          <p className="pitch-kicker text-[15px] text-faint">{dan.when.replace('Tue', 'Tuesday')}, in the worked example</p>
          <div className="mt-6 flex items-center gap-4">
            <Tag tone="coral">DOWN</Tag>
            <p className="text-[25px] text-paper">
              Dan bets <span className="num">{dan.stake}</span> USDG
            </p>
          </div>
          <div className="my-5 ml-[26px] flex items-center gap-4 border-l border-dashed border-paper/25 py-3 pl-8 text-[19px] text-faint">
            paid at once to the UP side already standing there
          </div>
          <div className="space-y-3">
            {[
              { who: 'Mei, bet UP at 9:35 am', from: dan.meiBefore, to: dan.meiAfter, strong: true },
              { who: 'Hunch’s opening seed, UP', from: EXAMPLE_FACTS.seed, to: dan.seedAfter, strong: false },
            ].map((row) => (
              <div key={row.who} className={`flex items-center justify-between rounded-[14px] border px-6 py-4 ${row.strong ? 'border-lime/30 bg-lime/[0.06]' : 'border-edge bg-white/[0.02]'}`}>
                <span className="text-[20px] text-muted">{row.who}</span>
                <span className="num flex items-center gap-3 text-[24px]">
                  <span className="text-faint">{row.from}</span>
                  <Arrow className="h-[20px] w-[20px] text-faint" />
                  <span className={row.strong ? 'text-lime' : 'text-paper'}>{row.to}</span>
                </span>
              </div>
            ))}
          </div>
          <p className="mt-auto pt-6 text-[19px] leading-[1.5] text-faint">
            Mei&rsquo;s payout if UP wins doubled before the market was three hours old, and no later bet can take it back.
          </p>
        </div>

        <div className="grid grid-cols-2 gap-6">
          {properties.map((property, i) => (
            <div key={property.title} className="rv pitch-card px-9 py-6" style={rv(3 + i)}>
              <Check />
              <h3 className="mt-3 font-body text-[27px] font-semibold tracking-[-0.01em] text-paper">{property.title}</h3>
              <p className="mt-3 text-[20px] leading-[1.5] text-muted">{property.body}</p>
            </div>
          ))}
        </div>
      </div>

    </Shell>
  );
}

// ================================================================================================
// 04 · Early vs late

function BettorRow({ bettor, note, after, d }: { bettor: Bettor; note: string; after?: string; d: number }) {
  const bar = (label: string, share: number, value: string, multiple: string, hunch: boolean, delay: number) => (
    <div className="grid grid-cols-[180px_1fr_260px] items-center gap-6">
      <span className={`text-[19px] ${hunch ? 'text-paper' : 'text-faint'}`}>{label}</span>
      <span className="relative h-[34px] rounded-[10px] bg-white/[0.03]">
        <span
          className={`grow-x absolute inset-y-0 left-0 rounded-[10px] ${hunch ? 'bg-lime' : 'bg-paper/20'}`}
          style={{ width: `${Math.max(3, share * 100)}%`, '--d': delay } as CSSProperties}
        />
      </span>
      <span className="flex items-baseline justify-end gap-4">
        <span className={`num text-[30px] ${hunch ? 'text-paper' : 'text-muted'}`}>{value}</span>
        <span className={`num w-[96px] text-right text-[24px] ${hunch ? 'text-lime' : 'text-faint'}`}>{multiple}</span>
      </span>
    </div>
  );
  return (
    <div className="rv pitch-card grid grid-cols-[400px_1fr] gap-12 px-10 py-9" style={rv(d)}>
      <div>
        <p className="pitch-title text-[60px] text-paper">{bettor.name}</p>
        <p className="num mt-3 text-[20px] text-muted">
          {bettor.when} · <span className="text-lime">UP</span> · {bettor.stake} USDG
        </p>
        <p className="mt-4 text-[19px] leading-[1.5] text-faint">{note}</p>
      </div>
      <div className="flex flex-col justify-center gap-5">
        {bar('Hunch pays', bettor.payoutShare, bettor.payout, bettor.multiple, true, d + 1)}
        {bar('Ordinary pool', bettor.classicShare, bettor.classic, bettor.classicMultiple, false, d + 2)}
        {after === undefined ? null : <p className="pl-[204px] text-[18px] text-faint">{after}</p>}
      </div>
    </div>
  );
}

export function EarlyVsLate() {
  const { mei, ben } = EXAMPLE_FACTS;
  return (
    <Shell n={4} section="Early vs late, in dollars" tone="lime">
      <Title>
        Same market, same side.
        <br />
        Paid for the risk, not the timing<Dot />
      </Title>

      <div className="mt-12 flex flex-1 flex-col gap-7">
        <BettorRow bettor={mei} d={2} note="Called it Tuesday morning and held through two days of bets against her." />
        <BettorRow
          bettor={ben}
          d={5}
          note="Bet the obvious side five minutes before the bell."
          after={`Ben still wins: his stake back plus the ${ben.gain} that arrived after him. He just can’t take Mei’s reward.`}
        />
      </div>

      <p className="rv mt-8 text-[18px] leading-[1.5] text-faint" style={rv(8)}>
        <span className="text-muted">{EXAMPLE_FACTS.question}</span> Opening seed {EXAMPLE_FACTS.seed} / {EXAMPLE_FACTS.seed} USDG, five
        bets, NVDA closes up. Made-up bettors, the contract&rsquo;s exact arithmetic: replayed by our client and pinned by a Foundry test.
      </p>
    </Shell>
  );
}

// ================================================================================================
// 05 · The product

export function Product() {
  const steps = [
    { title: 'Fund in seconds', body: 'Send USDC from Arbitrum One or Base through Across. It lands as USDG on Robinhood Chain. No ETH needed.' },
    { title: 'Pick a side', body: `UP or DOWN on ${LIVE.tickers.join(', ').replace(/, (\w+)$/, ' or $1')}. Daily: will TSLA close UP today? Weekly: will NVDA finish the week UP?` },
    { title: 'Sign once', body: 'A gasless USDG authorization binds market, side and amount. Our relayer pays the gas and can’t change any of it.' },
    { title: 'Settled at the bell', body: 'Two Chainlink rounds, at the opening and the closing bell, decide it. Anyone can resolve; winners are paid automatically.' },
  ];
  return (
    <Shell n={5} section="The product" tone="sky">
      <div className="grid flex-1 grid-cols-[1fr_620px] gap-20">
        <div className="flex flex-col">
          <Title>
            One signature. No ETH.
            <br />
            Settled at the bell<Dot />
          </Title>
          <div className="mt-12 flex flex-1 flex-col justify-between">
            {steps.map((step, i) => (
              <div key={step.title} className="rv grid grid-cols-[72px_1fr] gap-6 border-t border-edge pt-6" style={rv(1 + i)}>
                <span className="num text-[26px] text-lime">0{i + 1}</span>
                <div>
                  <h3 className="font-body text-[27px] font-semibold tracking-[-0.01em] text-paper">{step.title}</h3>
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
// 06 · Why Robinhood Chain, why now

export function WhyRobinhood() {
  return (
    <Shell n={6} section="Why Robinhood Chain, why now" tone="violet">
      <Title>
        Stock Tokens have prices, dollars and holders.
        <br />
        Not yet a market on this week<Dot />
      </Title>
      <Lead className="mt-7 max-w-[1500px]">
        Robinhood Chain puts every input on one chain: the Stock Token, a Chainlink price nobody types in, and a dollar that
        moves with one signature. Hunch turns them into a market that pays for being early.
      </Lead>

      <div className="mt-10 grid grid-cols-4 gap-6">
        {CHAIN_FACTS.map((fact, i) => (
          <div key={fact.label} className="rv pitch-card px-8 py-8" style={rv(2 + i)}>
            <p className="pitch-title text-[64px] text-paper">{fact.value}</p>
            <p className="mt-4 text-[21px] font-semibold text-paper">{fact.label}</p>
            <p className="mt-2 text-[16px] leading-[1.45] text-faint">{fact.note}</p>
          </div>
        ))}
      </div>

      <div className="mt-6 grid flex-1 grid-cols-2 gap-6">
        {TAILWINDS.map((wind, i) => (
          <div key={wind.label} className="rv pitch-card flex items-center gap-9 px-10 py-7" style={rv(6 + i)}>
            <p className="pitch-title w-[180px] shrink-0 text-[76px] text-violet">{wind.value}</p>
            <div>
              <p className="text-[24px] font-semibold text-paper">{wind.label}</p>
              <p className="mt-2 text-[19px] leading-[1.45] text-muted">{wind.detail}</p>
              <p className="mt-2 text-[15px] text-faint">Source: {wind.source}</p>
            </div>
          </div>
        ))}
      </div>
    </Shell>
  );
}

// ================================================================================================
// 07 · Live on Robinhood Chain

export function LiveOnMainnet() {
  const cannot = [
    'Move a bettor’s stake, or send it anywhere but to its owner',
    'Type in a price or choose the outcome',
    'Stop claims, refunds or resolution',
    'Change a listed market’s feed, times, fee or caps',
    'Spend a bettor’s signature on another market, side or amount',
  ];
  return (
    <Shell n={7} section="Live on Robinhood Chain" tone="lime">
      <div className="flex items-end justify-between">
        <Title>
          Live on mainnet,
          <br />
          with the receipts<Dot />
        </Title>
        <p className="rv mb-3 flex items-center gap-4 text-[22px] text-muted" style={rv(1)}>
          <span className="pitch-live-dot" aria-hidden /> Deployed {LIVE.deployedOn} · chain {LIVE.chainId}
        </p>
      </div>

      <div className="mt-12 grid flex-1 grid-cols-[1fr_640px] gap-10">
        <div className="flex flex-col gap-5">
          {LIVE.contracts.map((contract, i) => (
            <a
              key={contract.name}
              href={addressUrl(contract.address)}
              target="_blank"
              rel="noreferrer"
              className="rv pitch-card flex items-center justify-between px-9 py-6 transition-colors hover:border-edge-strong"
              style={rv(2 + i)}
            >
              <span className="flex items-center gap-6">
                <Check />
                <span>
                  <span className="block font-mono text-[25px] text-paper">{contract.name}</span>
                  <span className="mt-1 block text-[18px] text-faint">{contract.role}</span>
                </span>
              </span>
              <span className="text-right">
                <span className="num block text-[20px] text-muted">{shortAddress(contract.address)}</span>
                <span className="mt-1 block text-[15px] text-faint">Source verified · Sourcify exact match</span>
              </span>
            </a>
          ))}
          <div className="rv pitch-card flex items-center justify-between px-9 py-6" style={rv(5)}>
            <span className="flex items-center gap-6">
              <Check />
              <span className="text-[22px] text-paper">Allow-listed against their Chainlink feeds</span>
            </span>
            <span className="flex gap-3">
              {LIVE.tickers.map((ticker) => (
                <span key={ticker} className="num rounded-[10px] border border-edge-strong px-4 py-2 text-[19px] text-paper">
                  {ticker}
                </span>
              ))}
            </span>
          </div>
        </div>

        <div className="rv pitch-card flex flex-col px-10 py-9" style={rv(3)}>
          <p className="pitch-kicker text-[15px] text-coral">What nobody can do, including us</p>
          <ul className="mt-6 space-y-5">
            {cannot.map((line) => (
              <li key={line} className="flex gap-4 text-[21px] leading-[1.4] text-paper">
                <Cross />
                <span>{line}</span>
              </li>
            ))}
          </ul>
          <p className="mt-auto border-t border-edge pt-6 text-[18px] leading-[1.5] text-muted">
            Every market refunds in full if the price didn&rsquo;t move, a price is stale or out of range, or the token&rsquo;s price
            is paused for more than a day. Owned by a 2-of-3 Safe.
          </p>
        </div>
      </div>

      <div className="rv mt-8 grid grid-cols-4 gap-5 text-[17px] leading-[1.45] text-muted" style={rv(7)}>
        {[
          `Settler equals the paper’s reference on all ${LIVE.conformanceVectors} published vectors, plus fuzzing`,
          'Full launch rehearsed on a fork of chain 4663 with real USDG and real Chainlink feeds',
          'Two adversarial security reviews, hardening merged before mainnet; Slither in CI',
          'Gasless entry: one signature, the relayer pays, a used authorization can’t book twice',
        ].map((line) => (
          <p key={line} className="border-l-2 border-lime/50 pl-5">
            {line}
          </p>
        ))}
      </div>
    </Shell>
  );
}

// ================================================================================================
// 08 · Traction

export function Traction() {
  return (
    <Shell n={8} section="Traction" tone="sky">
      <div className="flex items-end justify-between gap-10">
        <Title>
          Hunch has run the engine
          <br />
          since {TRACK_RECORD.since.replace(' 2026', '')}<Dot />
        </Title>
        <p className="rv mb-2 max-w-[640px] text-[22px] leading-[1.5] text-muted" style={rv(1)}>
          Before Robinhood Chain we built and ran Hunch at {PITCH.hunchDomain}. The Vested Parimutuel is the settlement rule we
          wrote from what we saw there.
        </p>
      </div>

      <div className="mt-11 grid grid-cols-2 gap-6">
        {TRACK_RECORD.engine.map((stat, i) => (
          <div key={stat.label} className="rv pitch-card px-10 py-8" style={rv(2 + i)}>
            <p className="pitch-title text-[96px] text-paper">{stat.value}</p>
            <p className="mt-4 text-[25px] font-semibold text-paper">{stat.label}</p>
            <p className="mt-2 text-[19px] leading-[1.5] text-faint">{stat.detail}</p>
          </div>
        ))}
      </div>

      <div className="mt-6 grid flex-1 grid-cols-[1fr_560px] gap-6">
        <div className="rv pitch-card flex flex-col justify-center gap-7 px-10 py-7" style={rv(4)}>
          <p className="flex items-center gap-4">
            <Tag tone="sky">Proof of concept</Tag>
            <span className="text-[18px] text-faint">Real USDC on Base, every bet and payout an on-chain transaction</span>
          </p>
          <div className="grid grid-cols-4 gap-6">
            {TRACK_RECORD.money.map((stat) => (
              <div key={stat.label}>
                <p className="pitch-title text-[72px] text-sky">{stat.value}</p>
                <p className="mt-2 text-[19px] text-muted">{stat.label}</p>
              </div>
            ))}
          </div>
        </div>
        <div className="rv pitch-card pitch-card-strong flex flex-col justify-center px-10 py-7" style={rv(5)}>
          <p className="pitch-title text-[72px] text-lime">{TRACK_RECORD.agents.value}</p>
          <p className="mt-3 text-[23px] font-semibold text-paper">{TRACK_RECORD.agents.label}</p>
          <p className="mt-2 text-[19px] leading-[1.5] text-muted">{TRACK_RECORD.agents.detail}</p>
        </div>
      </div>

      <div className="rv mt-6 flex items-center justify-between gap-6" style={rv(6)}>
        <span className="flex flex-wrap gap-3">
          {TRACK_RECORD.rails.map((rail) => (
            <span key={rail} className="rounded-full border border-edge-strong px-5 py-2 text-[17px] text-muted">
              {rail}
            </span>
          ))}
        </span>
        <span className="text-[15px] text-faint">
          Production, {TRACK_RECORD.asOf}. Resolver-run markets prove the engine, not demand.
        </span>
      </div>
    </Shell>
  );
}

// ================================================================================================
// 09 · Business model

export function BusinessModel() {
  const feePct = `${LIVE.feeBps / 100}%`;
  const rows: { label: string; book: string; pool: string; hunch: string }[] = [
    { label: 'Needs a market maker', book: 'On every market', pool: 'None', hunch: 'None' },
    { label: 'Pays the early call more', book: 'Through the price', pool: 'Diluted by late money', hunch: 'Yes, by rule' },
    { label: 'Open until the answer is near', book: 'While makers quote', pool: 'Closes early', hunch: 'Until the bell' },
    { label: 'Operator capital at risk', book: 'Maker inventory', pool: 'The seed', hunch: 'Seed floored' },
  ];
  return (
    <Shell n={9} section="Business model" tone="lime">
      <Title>
        We earn when winners are paid.
        <br />
        Listing costs nothing we can lose<Dot />
      </Title>

      <div className="mt-12 grid flex-1 grid-cols-[560px_1fr] gap-10">
        <div className="rv pitch-card pitch-card-strong flex flex-col px-10 py-9" style={rv(1)}>
          <p className="pitch-title text-[140px] leading-[0.85] text-lime">{feePct}</p>
          <p className="mt-4 text-[25px] font-semibold text-paper">of winners&rsquo; gains, at settlement</p>
          <ul className="mt-6 space-y-4 text-[19px] leading-[1.45] text-muted">
            <li className="flex gap-4">
              <Check />
              <span>No fee to enter. Losing bets pay nothing extra.</span>
            </li>
            <li className="flex gap-4">
              <Check />
              <span>About 1% of volume on balanced books, since winners&rsquo; gains are roughly the losing side.</span>
            </li>
            <li className="flex gap-4">
              <Check />
              <span>The seed can&rsquo;t lose: listing every ticker, every session, is a revolving float, not a subsidy.</span>
            </li>
          </ul>
          <p className="mt-auto border-t border-edge pt-5 text-[16px] leading-[1.5] text-faint">
            Unit economics will be reported from chain data after the first month of markets, not projected.
          </p>
        </div>

        <div className="rv pitch-card overflow-hidden" style={rv(2)}>
          <table className="h-full w-full border-collapse text-left">
            <thead>
              <tr className="border-b border-edge">
                <th className="w-[300px] px-8 py-6" />
                <th className="px-6 py-6 text-[18px] font-semibold text-muted">
                  Order books
                  <span className="block text-[15px] font-normal text-faint">Kalshi, Polymarket</span>
                </th>
                <th className="px-6 py-6 text-[18px] font-semibold text-muted">
                  Classic pools
                  <span className="block text-[15px] font-normal text-faint">Tote, most on-chain pools</span>
                </th>
                <th className="bg-lime/[0.07] px-6 py-6 text-[18px] font-semibold text-lime">
                  Hunch
                  <span className="block text-[15px] font-normal text-lime/70">Vested Parimutuel</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => (
                <tr key={row.label} className={i < rows.length - 1 ? 'border-b border-edge' : undefined}>
                  <td className="px-8 py-4 text-[20px] font-semibold text-paper">{row.label}</td>
                  <td className="px-6 py-4 text-[19px] text-muted">{row.book}</td>
                  <td className="px-6 py-4 text-[19px] text-muted">{row.pool}</td>
                  <td className="bg-lime/[0.07] px-6 py-4 text-[19px] font-semibold text-paper">{row.hunch}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

    </Shell>
  );
}

// ================================================================================================
// 10 · Team

export function Team() {
  return (
    <Shell n={10} section="Team" tone="violet">
      <div className="flex items-end justify-between">
        <Title>
          Two founders, full time<Dot />
        </Title>
        <p className="rv mb-1 max-w-[760px] text-right text-[21px] leading-[1.5] text-muted" style={rv(1)}>
          Three products shipped together. Met in college, worked together at Infosys. Based in Bengaluru. Bootstrapped:
          nothing raised.
        </p>
      </div>

      <div className="mt-10 grid flex-1 grid-cols-2 gap-8">
        {TEAM.map((person, i) => (
          <div key={person.name} className="rv pitch-card flex flex-col px-11 py-9" style={rv(2 + i)}>
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
            <p className="mt-7 text-[23px] font-semibold leading-[1.4] text-paper">{person.lead}</p>
            <ul className="mt-4 space-y-3">
              {person.points.map((point) => (
                <li key={point} className="flex gap-4 text-[20px] leading-[1.5] text-muted">
                  <span className="mt-[11px] h-[6px] w-[6px] shrink-0 rounded-full bg-lime" aria-hidden />
                  <span>{point}</span>
                </li>
              ))}
            </ul>
            <dl className="mt-auto grid grid-cols-3 gap-6 border-t border-edge pt-6">
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
    <span className="relative flex h-[132px] w-[132px] shrink-0 items-center justify-center rounded-[22px] border border-lime/45 bg-gradient-to-b from-lime/[0.14] to-lime/[0.02]">
      <span className="pitch-title text-[54px] text-lime">{initials}</span>
      <span className="absolute bottom-[-1px] left-1/2 h-[26px] w-[34px] -translate-x-1/2 rounded-t-full border border-b-0 border-lime/45 bg-ink" aria-hidden />
    </span>
  );
}

// ================================================================================================
// 11 · The raise

export function TheRaise() {
  const colors = ['bg-lime', 'bg-violet', 'bg-sky', 'bg-paper/45'];
  const text = ['text-lime', 'text-violet', 'text-sky', 'text-paper'];
  return (
    <Shell n={11} section="The raise" tone="lime">
      <Title className="max-w-[1500px]">
        Raising a pre-seed round to put a market on every Stock Token, every session<Dot />
      </Title>

      <div className="mt-12 grid flex-1 grid-cols-[1fr_600px] gap-10">
        <div className="grid grid-cols-3 gap-5">
          {MILESTONES.map((milestone, i) => (
            <div key={milestone.when} className="rv pitch-card flex flex-col px-8 py-8" style={rv(1 + i)}>
              <p className="pitch-kicker text-[15px] text-lime">{milestone.when}</p>
              <p className="mt-3 text-[24px] font-semibold leading-[1.25] text-paper">{milestone.title}</p>
              <ul className="mt-5 space-y-3">
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

        <div className="rv pitch-card flex flex-col px-10 py-8" style={rv(4)}>
          <p className="pitch-kicker text-[15px] text-faint">Use of funds</p>
          <div className="mt-6 flex h-[18px] overflow-hidden rounded-full">
            {USE_OF_FUNDS.map((use, i) => (
              <span key={use.label} className={`grow-x h-full ${colors[i]}`} style={{ width: `${use.share}%`, '--d': 5 + i } as CSSProperties} />
            ))}
          </div>
          <ul className="mt-7 flex flex-1 flex-col justify-between">
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

      <div className="rv mt-8 flex items-center justify-between rounded-[20px] border border-edge bg-white/[0.02] px-9 py-5" style={rv(6)}>
        <span className="flex items-center gap-5">
          <HunchMark className="h-[34px] w-[34px]" />
          <span className="text-[21px] text-paper">Raj Karia, CEO</span>
        </span>
        <span className="flex items-center gap-10 text-[20px] text-muted">
          <a href={PITCH.xUrl} target="_blank" rel="noreferrer" className="hover:text-paper">
            {PITCH.x}
          </a>
          <a href={`https://${PITCH.domain}`} className="hover:text-paper">
            {PITCH.domain}
          </a>
          <a href={LINKS.paper} target="_blank" rel="noreferrer" className="hover:text-paper">
            The paper
          </a>
          <a href={LINKS.hunch} target="_blank" rel="noreferrer" className="text-paper hover:text-lime">
            {PITCH.hunchDomain}
          </a>
        </span>
      </div>
    </Shell>
  );
}

/** The deck, in order, for the page and the tests. */
export const SLIDES = [Cover, Problem, Solution, EarlyVsLate, Product, WhyRobinhood, LiveOnMainnet, Traction, BusinessModel, Team, TheRaise] as const;

