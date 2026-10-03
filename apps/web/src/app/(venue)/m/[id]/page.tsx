import type { Metadata } from 'next';
import { headers } from 'next/headers';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { MarketLive } from '@/components/market/MarketLive';
import { MarketRulesBox } from '@/components/market/RulesBox';
import { StatusBadge } from '@/components/market/StatusBadge';
import { TickerMark } from '@/components/market/TickerMark';
import { Container } from '@/components/ui/Container';
import { ButtonLink, TextLink } from '@/components/ui/primitives';
import { marketDetailJson } from '@/lib/api/shapes';
import { readDeployment } from '@/lib/deployment';
import { formatEtDateTime } from '@/lib/et';
import { ReadUnavailableError } from '@/lib/server/cache';
import { regionFromHeaders } from '@/lib/server/geo';
import { getMarketBundle, parseMarketId, type MarketBundle } from '@/lib/server/market';
import { BETA_NOTICE } from '@/lib/site';

/**
 * `/m/[id]`: one market, trust before movement (docs/spec/05-web-app.md): the question, ticker and
 * status; the rules box, verbatim; the prices that decide it; the bet panel; your positions; every
 * bet; and after the bell the settlement, with a button anyone can press.
 *
 * Rendered per request (it reads the country verdict) from cached chain reads (5 s, expired at once
 * after a confirmed bet). No loading.tsx sits above it, so an unknown id is a real 404.
 */
export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ id: string }> };

async function load(id: string): Promise<{ bundle: MarketBundle | null; unavailable: boolean }> {
  const marketId = parseMarketId(id);
  if (marketId === null) notFound();
  try {
    return { bundle: await getMarketBundle(marketId), unavailable: false };
  } catch (error) {
    if (error instanceof ReadUnavailableError) return { bundle: null, unavailable: true };
    throw error;
  }
}

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { id } = await params;
  if (readDeployment().status !== 'deployed' || parseMarketId(id) === null) return { title: 'Market', robots: { index: false } };
  try {
    const bundle = await getMarketBundle(BigInt(id), { enhance: false });
    if (bundle.data === null) return { title: 'Market not found', robots: { index: false } };
    return {
      title: bundle.data.question,
      description: `${bundle.data.ticker} UP or DOWN on Robinhood Chain, in USDG, settled by Chainlink. ${bundle.data.rules.text.slice(0, 120)}`,
      alternates: { canonical: `/m/${id}` },
    };
  } catch {
    return { title: 'Market' };
  }
}

function Placeholder({ title, children, action }: { title: string; children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <Container className="pb-24 pt-12 sm:pt-16">
      <div className="rounded-card border border-dashed border-edge-strong p-5 sm:p-8">
        <p className="eyebrow">Market</p>
        <h1 className="mt-3 text-[28px] leading-tight sm:text-4xl">{title}</h1>
        <div className="mt-3 max-w-2xl text-[15px] leading-relaxed text-muted">{children}</div>
        <div className="mt-6 flex flex-wrap gap-3">{action}</div>
      </div>
    </Container>
  );
}

export default async function MarketPage({ params }: Params) {
  const { id } = await params;
  const deployment = readDeployment();

  if (deployment.status !== 'deployed') {
    if (parseMarketId(id) === null) notFound();
    return (
      <Placeholder
        title="This market does not exist yet."
        action={
          <>
            <ButtonLink href="/start">Get set up before it opens</ButtonLink>
            <ButtonLink href="/#markets" variant="secondary">
              See what will be listed
            </ButtonLink>
          </>
        }
      >
        Hunch&rsquo;s contracts are not deployed on Robinhood Chain yet, so there are no markets and nothing here takes a bet.
        Markets open at the next opening bell once the venue is live.
      </Placeholder>
    );
  }

  const { bundle, unavailable } = await load(id);
  if (unavailable || bundle === null) {
    return (
      <Placeholder
        title="Market data unavailable, retrying."
        action={
          <ButtonLink href={`/m/${id}`} variant="secondary">
            Try again
          </ButtonLink>
        }
      >
        Robinhood Chain could not be read just now, so this page cannot show the market&rsquo;s numbers. Nothing is lost: every
        stake is held by the contract, and the market settles on its own proofs. Try again in a moment.
      </Placeholder>
    );
  }
  const detail = bundle.data;
  if (detail === null) notFound();

  const region = regionFromHeaders(await headers());
  const json = marketDetailJson(detail, { activity: bundle.activity, log: bundle.log, readAt: bundle.readAt, stale: bundle.stale });
  const now = Math.floor(Date.now() / 1000);
  const familyLabel = detail.family === 'weekly' ? 'Weekly' : detail.family === 'daily' ? 'Daily' : 'Refund drill';

  return (
    <Container className="pb-24 pt-8 sm:pt-12">
      <nav aria-label="Breadcrumb" className="text-sm">
        <TextLink href="/#markets">Markets</TextLink>
        <span className="px-2 text-faint">/</span>
        <span className="num text-faint">{detail.ticker}</span>
      </nav>

      <header className="mt-5 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          <TickerMark ticker={detail.ticker} size="lg" />
          <div className="min-w-0">
            <p className="text-sm text-muted">
              <span className="font-semibold text-paper">{detail.ticker}</span> · {familyLabel} · Stock Token · market{' '}
              <span className="num">{detail.id.toString()}</span>
            </p>
            <h1 className="mt-1 text-[26px] leading-tight sm:text-[34px]">{detail.question}</h1>
            <p className="mt-2 text-xs text-faint">
              Bets accepted until <span className="num">{formatEtDateTime(detail.finalTime)}</span>
            </p>
          </div>
        </div>
        <div className="shrink-0">
          <StatusBadge phase={json.market.phase} winner={json.market.winner ?? undefined} />
        </div>
      </header>

      <div className="mt-6">
        <MarketLive initial={json} rules={<MarketRulesBox rules={detail.rules} />} region={region} serverNow={now} deploymentOverride={deployment} />
      </div>

      <p className="mt-10 text-xs leading-relaxed text-faint">
        {BETA_NOTICE}{' '}
        <Link href="/proof" className="underline decoration-edge-strong underline-offset-2 hover:text-paper">
          Verify it yourself
        </Link>
        .
      </p>
    </Container>
  );
}
