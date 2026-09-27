import { addressExplorerUrl, isDeployed, type ChainFacts } from '@/lib/chain';
import { shortAddress } from '@/lib/units';

/**
 * An address, linked into the explorer when there is something there to see.
 *
 * Nothing of ours is deployed yet, so most of these are the zero placeholder.
 * A placeholder renders as plain text with a label saying so, rather than as a
 * link into an explorer page that does not exist — a dead link on a contract
 * address is worse than no link, because it reads as a deployment that failed.
 */
export function AddressLink({
  address,
  label,
  className = '',
  chain,
}: {
  address: string;
  label?: string;
  className?: string;
  /** Which chain's explorer to link into. Defaults to testnet's; mainnet's is unpublished, so it links nowhere. */
  chain?: ChainFacts;
}) {
  const url = addressExplorerUrl(address, chain);
  const text = label ?? shortAddress(address);

  if (!isDeployed(address)) {
    return (
      <span className={`num inline-flex items-center gap-2 text-sm text-muted ${className}`} title={address}>
        {text}
        <span className="rounded-tag border border-edge px-1.5 py-0.5 text-[10px] uppercase tracking-[0.1em] text-faint">
          not deployed
        </span>
      </span>
    );
  }

  if (url === null) {
    return (
      <span className={`num text-sm text-muted ${className}`} title={address}>
        {text}
      </span>
    );
  }

  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer noopener"
      title={address}
      className={`num text-sm text-muted underline decoration-edge underline-offset-4 transition-colors hover:text-paper hover:decoration-paper/40 ${className}`}
    >
      {text}
    </a>
  );
}
