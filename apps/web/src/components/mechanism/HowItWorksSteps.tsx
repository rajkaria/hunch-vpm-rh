import { readDeployment } from '@/lib/deployment';
import { LATE_RULE } from '@/lib/site';
import { formatAmount } from '@/lib/units';

/** The three steps (docs/spec/05-web-app.md), numbered, in plain words. Bet limits come from the deployment. */
function steps(min: string, max: string) {
  return [
  {
    title: 'Pick UP or DOWN',
    body: `Will the Stock Token's price be higher or lower at the closing bell than at the opening bell? Bet ${min} to ${max} USDG with one signature. No ETH needed.`,
  },
  {
    title: "The earlier you bet, the more of the other side's money is yours",
    body: 'Every bet against you that lands after yours adds to what you are paid if you are right. What you have earned only goes up.',
  },
  {
    title: 'The bell settles it',
    body: 'Chainlink decides: its price in effect at the opening bell against its price in effect at the closing bell. Payouts arrive in your wallet automatically.',
  },
  ];
}

/**
 * `cards` (the /how-it-works page) sets the steps side by side as panels with the rule under
 * them; `list` (the landing page) is the hairline numbered list the Hunch landing page uses,
 * with the rule left to the caller.
 */
export function HowItWorksSteps({ showRule = true, variant = 'cards' }: { showRule?: boolean; variant?: 'cards' | 'list' }) {
  const { params } = readDeployment();
  const STEPS = steps(
    formatAmount(BigInt(params.minEntry), { fractionDigits: 0 }),
    formatAmount(BigInt(params.maxEntry), { fractionDigits: 0 }),
  );
  if (variant === 'list') {
    return (
      <ol className="divide-y divide-edge border-y border-edge">
        {STEPS.map((step, index) => (
          <li key={step.title} className="grid grid-cols-[36px_minmax(0,1fr)] gap-3 py-5 sm:grid-cols-[44px_minmax(0,1fr)] sm:py-6">
            <span className="num pt-0.5 text-sm text-faint">0{index + 1}</span>
            <div className="min-w-0">
              <h3 className="font-body text-base leading-snug font-semibold tracking-normal text-paper sm:text-[17px]">{step.title}</h3>
              <p className="mt-1.5 text-sm leading-relaxed text-muted">{step.body}</p>
            </div>
          </li>
        ))}
      </ol>
    );
  }
  return (
    <div>
      <ol className="grid gap-3 md:grid-cols-3 md:gap-4">
        {STEPS.map((step, index) => (
          <li key={step.title} className="lift flex flex-col rounded-card border border-edge bg-raised p-5">
            <span className="num text-sm text-faint">0{index + 1}</span>
            <h3 className="mt-4 text-[19px] leading-snug text-paper">{step.title}</h3>
            <p className="mt-2 text-sm leading-relaxed text-muted">{step.body}</p>
          </li>
        ))}
      </ol>
      {showRule ? (
        <p className="mt-5 max-w-2xl border-l-2 border-lime pl-4 text-[15px] leading-relaxed text-paper">{LATE_RULE}</p>
      ) : null}
    </div>
  );
}
