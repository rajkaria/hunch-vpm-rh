import { POWERS } from '@/content/powers';

/**
 * Who can do what, verbatim from docs/spec/03-contracts.md. A table on a wide screen; on a phone
 * each row becomes a card with "Can" and "Cannot" stacked, so nothing scrolls sideways.
 */
export function PowersTable() {
  return (
    <div>
      <div className="hidden overflow-hidden rounded-card border border-edge md:block">
        <table className="data-table">
          <caption className="sr-only">Every privileged power in the contracts, and what each holder cannot do</caption>
          <thead>
            <tr>
              <th scope="col" className="w-[24%]">Who</th>
              <th scope="col" className="w-[40%]">Can</th>
              <th scope="col">Cannot</th>
            </tr>
          </thead>
          <tbody>
            {POWERS.map((row) => (
              <tr key={row.who}>
                <th scope="row" className="!text-[14px] !font-semibold !normal-case !tracking-normal !text-paper">
                  {row.who}
                </th>
                <td className="text-muted">
                  {row.can.map((part, index) =>
                    typeof part === 'string' ? <span key={index}>{part}</span> : <strong key={index} className="font-semibold text-paper">{part.strong}</strong>,
                  )}
                </td>
                <td className="text-muted">{row.cannot}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ul className="grid gap-3 md:hidden" aria-label="Every privileged power in the contracts">
        {POWERS.map((row) => (
          <li key={row.who} className="rounded-card border border-edge bg-raised p-4">
            <p className="text-sm font-semibold text-paper">{row.who}</p>
            <dl className="mt-3 grid gap-3 text-sm">
              <div>
                <dt className="eyebrow">Can</dt>
                <dd className="mt-1 text-muted">
                  {row.can.map((part, index) =>
                    typeof part === 'string' ? <span key={index}>{part}</span> : <strong key={index} className="font-semibold text-paper">{part.strong}</strong>,
                  )}
                </dd>
              </div>
              <div>
                <dt className="eyebrow">Cannot</dt>
                <dd className="mt-1 text-muted">{row.cannot}</dd>
              </div>
            </dl>
          </li>
        ))}
      </ul>
    </div>
  );
}
