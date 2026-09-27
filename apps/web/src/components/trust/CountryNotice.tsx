import { BETA_NOTICE, COUNTRY_NOTICE } from '@/lib/site';

/** The eligibility notice, stated plainly wherever money could be at stake. */
export function CountryNotice({ className = '' }: { className?: string }) {
  return (
    <aside aria-label="Eligibility" className={`rounded-card border border-edge bg-raised p-4 sm:p-5 ${className}`}>
      <p className="text-sm font-semibold text-paper">Who can use it</p>
      <p className="mt-2 text-sm leading-relaxed text-muted">
        {COUNTRY_NOTICE} Prediction markets are regulated in many places; make sure they are legal where you are.
      </p>
      <p className="mt-2 text-xs leading-relaxed text-faint">{BETA_NOTICE}</p>
    </aside>
  );
}
