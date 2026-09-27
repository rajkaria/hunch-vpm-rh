import { WHY_ROBINHOOD_CHAIN } from '@/content/why-robinhood';

/** The dependency list, not praise: what this venue needs and where each piece comes from. */
export function WhyRobinhoodChain() {
  return (
    <ul className="grid gap-px overflow-hidden rounded-card border border-edge bg-edge sm:grid-cols-2 lg:grid-cols-3">
      {WHY_ROBINHOOD_CHAIN.map((item, index) => (
        <li key={item.need} className="bg-ink p-5">
          <p className="num text-xs text-faint">{String(index + 1).padStart(2, '0')}</p>
          <p className="mt-3 text-[15px] font-semibold text-paper">{item.need}</p>
          <p className="mt-1.5 text-sm leading-relaxed text-muted">{item.detail}</p>
        </li>
      ))}
    </ul>
  );
}
