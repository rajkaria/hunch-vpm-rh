import { addressUrl, isAddress } from '@/lib/site';
import { shortAddress } from '@/lib/units';

/**
 * An address, linked into Blockscout when there is something there to see.
 *
 * Before deployment most of our own addresses are empty. An empty slot renders
 * as plain text saying "not yet deployed" rather than as a link into an
 * explorer page that does not exist: a dead link on a contract address reads
 * as a deployment that failed.
 */
export function AddressLink({
  address,
  label,
  full = false,
  className = '',
}: {
  address: string | null | undefined;
  /** Text to show instead of the shortened address. */
  label?: string;
  /** Show the whole address (wraps on narrow screens) instead of 0x1234…abcd. */
  full?: boolean;
  className?: string;
}) {
  if (!isAddress(address)) {
    return (
      <span className={`inline-flex items-center gap-2 text-sm text-faint ${className}`}>
        <span className="rounded-tag border border-edge px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.06em]">
          Not yet deployed
        </span>
      </span>
    );
  }

  const text = label ?? (full ? address : shortAddress(address));

  return (
    <a
      href={addressUrl(address)}
      target="_blank"
      rel="noreferrer noopener"
      title={address}
      className={`num inline-flex min-h-11 items-center break-all text-sm text-muted underline decoration-edge-strong underline-offset-4 transition-colors hover:text-paper hover:decoration-paper/40 ${className}`}
    >
      {text}
    </a>
  );
}
