import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="lift rounded-card border border-edge bg-raised px-5 py-16 text-center">
      <p className="num text-sm uppercase tracking-[0.14em] text-faint">404</p>
      <h1 className="mt-3 text-2xl">Nothing here.</h1>
      <p className="mx-auto mt-3 max-w-md text-sm leading-relaxed text-muted">
        That address does not name a market on this venue. It may have been opened on a different settler, or the
        indexer may not have reached it yet.
      </p>
      <Link
        href="/"
        className="mt-6 inline-block border border-lime px-4 py-2.5 text-sm font-semibold text-lime transition-colors hover:bg-lime hover:text-ink"
      >
        Back to the markets
      </Link>
    </div>
  );
}
