import { AddressLink } from '@/components/market/AddressLink';
import type { ContractRow } from '@/lib/live/types';
import { addressUrl, isAddress, txUrl } from '@/lib/site';
import { shortHex } from '@/lib/units';

/**
 * Contracts with their addresses, Blockscout links and deploy transactions. An empty address says
 * "Not yet deployed" instead of linking to nothing. `compact` drops the deploy column (landing).
 */
export function ContractTable({ rows, compact = false }: { rows: ContractRow[]; compact?: boolean }) {
  return (
    <ul className="divide-y divide-edge-soft overflow-hidden rounded-card border border-edge bg-raised">
      {rows.map((row) => (
        <li key={row.name} className="grid gap-2 px-4 py-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:gap-6 sm:px-5">
          <div className="min-w-0">
            <p className="num text-sm font-medium text-paper">{row.name}</p>
            <p className="mt-1 text-xs leading-relaxed text-muted">{row.role}</p>
          </div>
          <div className="flex min-w-0 flex-col sm:items-end">
            <AddressLink address={row.address} />
            {compact ? null : (
              <div className="flex flex-wrap gap-x-4 text-[11px] text-faint sm:justify-end">
                {isAddress(row.address) ? (
                  <a
                    href={`${addressUrl(row.address)}?tab=contract`}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="inline-flex min-h-11 items-center underline decoration-edge-strong underline-offset-2 hover:text-paper"
                  >
                    {row.verified === true ? 'Verified source' : row.verified === false ? 'Source not verified' : 'Source on Blockscout'}
                  </a>
                ) : null}
                {row.deployTx === null ? null : (
                  <a href={txUrl(row.deployTx)} target="_blank" rel="noreferrer noopener" className="num inline-flex min-h-11 items-center underline decoration-edge-strong underline-offset-2 hover:text-paper">
                    deploy {shortHex(row.deployTx)}
                  </a>
                )}
              </div>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}
