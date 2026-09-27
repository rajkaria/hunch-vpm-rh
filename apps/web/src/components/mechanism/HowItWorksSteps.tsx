import { LATE_RULE } from '@/lib/site';

/** The three steps (docs/spec/05-web-app.md), numbered, in plain words. */
export const STEPS = [
  {
    title: 'Pick UP or DOWN',
    body: "Will the Stock Token's price be higher or lower at the closing bell than at the opening bell? Bet 1 to 100 USDG with one signature. No ETH needed.",
  },
  {
    title: "The earlier you bet, the more of the other side's money is yours",
    body: 'Every bet against you that lands after yours adds to what you are paid if you are right. What you have earned only goes up.',
  },
  {
    title: 'The bell settles it',
    body: 'Chainlink decides: its price in effect at the opening bell against its price in effect at the closing bell. Payouts arrive in your wallet automatically.',
  },
] as const;

export function HowItWorksSteps({ showRule = true }: { showRule?: boolean }) {
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
