import type { ReactNode } from 'react';

/**
 * The long-form vocabulary shared by /docs and /how-it-works: anchor headings, body text,
 * lists, callouts, code and tables, all in the Hunch system. Server components, no client code.
 */

function Anchor({ id }: { id: string }) {
  return (
    <a
      href={`#${id}`}
      aria-hidden
      tabIndex={-1}
      className="ml-2 inline-block text-faint no-underline opacity-0 transition-opacity group-hover:opacity-100 focus:opacity-100"
    >
      #
    </a>
  );
}

export function H2({ id, children }: { id: string; children: ReactNode }) {
  return (
    <h2 id={id} className="group mt-14 text-[24px] leading-tight text-paper first-of-type:mt-0 sm:text-[28px]">
      {children}
      <Anchor id={id} />
    </h2>
  );
}

export function H3({ id, children }: { id: string; children: ReactNode }) {
  return (
    <h3 id={id} className="group mt-9 font-body text-[17px] leading-snug font-semibold tracking-normal text-paper">
      {children}
      <Anchor id={id} />
    </h3>
  );
}

export function P({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <p className={`mt-4 text-[15px] leading-[1.7] text-muted ${className}`}>{children}</p>;
}

export function Lead({ children }: { children: ReactNode }) {
  return <p className="mt-4 max-w-2xl text-base leading-relaxed text-muted sm:text-[17px]">{children}</p>;
}

export function UL({ children }: { children: ReactNode }) {
  return <ul className="mt-4 grid gap-2.5 text-[15px] leading-[1.65] text-muted">{children}</ul>;
}

export function OL({ children }: { children: ReactNode }) {
  return <ol className="mt-4 grid list-none gap-3 text-[15px] leading-[1.65] text-muted [counter-reset:step]">{children}</ol>;
}

export function LI({ children }: { children: ReactNode }) {
  return (
    <li className="relative pl-5 before:absolute before:left-0 before:top-[0.7em] before:h-1 before:w-1 before:rounded-pill before:bg-paper/40">
      {children}
    </li>
  );
}

export function Step({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <li className="grid grid-cols-[28px_1fr] gap-3">
      <span className="num mt-0.5 inline-flex h-7 w-7 items-center justify-center rounded-tag border border-edge-strong text-xs text-paper">
        {n}
      </span>
      <div>
        <p className="font-semibold text-paper">{title}</p>
        <div className="mt-1">{children}</div>
      </div>
    </li>
  );
}

/** Strong text inside body copy. */
export function B({ children }: { children: ReactNode }) {
  return <strong className="font-semibold text-paper">{children}</strong>;
}

/** Inline code: an identifier, an address, a value. Mono by definition. */
export function C({ children }: { children: ReactNode }) {
  return (
    <code className="num break-hash rounded-[5px] border border-edge bg-paper/5 px-1.5 py-[1px] text-[0.86em] text-paper">
      {children}
    </code>
  );
}

export function CodeBlock({ children, label }: { children: string; label?: string }) {
  return (
    <figure className="mt-5 overflow-hidden rounded-control border border-edge bg-[#0c0c0f]">
      {label === undefined ? null : (
        <figcaption className="border-b border-edge px-4 py-2 text-[11px] text-faint">{label}</figcaption>
      )}
      <pre className="scroll-x px-4 py-3.5 text-[12.5px] leading-relaxed text-paper/90">
        <code className="num">{children}</code>
      </pre>
    </figure>
  );
}

export function Callout({
  title,
  children,
  tone = 'note',
}: {
  title: string;
  children: ReactNode;
  tone?: 'note' | 'caution';
}) {
  return (
    <aside
      className={`mt-6 rounded-control border p-4 text-sm leading-relaxed ${
        tone === 'caution' ? 'border-coral/30 bg-coral/[0.04]' : 'border-edge-strong bg-raised'
      }`}
    >
      <p className={`font-semibold ${tone === 'caution' ? 'text-coral' : 'text-paper'}`}>{title}</p>
      <div className="mt-1.5 text-muted [&_p]:mt-2 [&_p:first-child]:mt-0">{children}</div>
    </aside>
  );
}

/** A plain table that scrolls inside itself on a phone, never the page. */
export function Table({
  head,
  rows,
  caption,
  numeric = [],
  minWidth = 520,
}: {
  head: string[];
  rows: ReactNode[][];
  caption: string;
  /** Column indexes that hold numbers (right-aligned, mono). */
  numeric?: number[];
  minWidth?: number;
}) {
  return (
    <div className="scroll-x mt-5 rounded-card border border-edge">
      <table className="data-table" style={{ minWidth }}>
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>
            {head.map((cell, index) => (
              <th key={cell} scope="col" className={numeric.includes(index) ? 'text-right' : ''}>
                {cell}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, rowIndex) => (
            <tr key={rowIndex}>
              {row.map((cell, index) => (
                <td
                  key={index}
                  className={numeric.includes(index) ? 'num text-right text-paper' : index === 0 ? 'text-paper' : 'text-muted'}
                >
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** A term list: each term on its own line with its anchor, the definition below. */
export function Terms({ items }: { items: readonly { id: string; term: string; definition: ReactNode }[] }) {
  return (
    <dl className="mt-5 divide-y divide-edge-soft rounded-card border border-edge bg-raised">
      {items.map((item) => (
        <div key={item.id} id={item.id} className="px-4 py-4 sm:px-5">
          <dt className="text-[15px] font-semibold text-paper">{item.term}</dt>
          <dd className="mt-1.5 text-sm leading-relaxed text-muted">{item.definition}</dd>
        </div>
      ))}
    </dl>
  );
}

/** "On this page": the section list for a long page. */
export function Toc({ items, title = 'On this page' }: { items: readonly { id: string; label: string }[]; title?: string }) {
  return (
    <nav aria-label={title}>
      <p className="eyebrow">{title}</p>
      <ul className="mt-3 grid gap-0.5 border-l border-edge">
        {items.map((item) => (
          <li key={item.id}>
            <a
              href={`#${item.id}`}
              className="-ml-px flex min-h-9 items-center border-l border-transparent pl-3 text-sm text-muted transition-colors hover:border-paper/40 hover:text-paper"
            >
              {item.label}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
