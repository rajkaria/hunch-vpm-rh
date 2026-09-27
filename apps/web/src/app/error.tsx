'use client';

import { useEffect } from 'react';

/**
 * What the surface says when a read fails.
 *
 * Two sentences, always in this order: what happened, and what to do about it.
 * An error that gives only the first leaves the reader stuck, and one that
 * gives neither — "Something went wrong" — is worse than a blank page, because
 * it looks like it knows something it is not saying.
 */
export default function Error({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    // The digest is what a server log can be matched against; the message
    // itself is not shown, because a stack trace is not something a reader can
    // act on and may carry an endpoint we would rather not print.
    console.error('page failed to render', error.digest ?? error.message);
  }, [error]);

  return (
    <div className="lift rounded-card border border-coral/40 bg-raised px-5 py-8">
      <h1 className="font-display text-xl text-coral">This page could not be read.</h1>
      <p className="mt-3 max-w-prose text-sm leading-relaxed text-muted">
        The data source did not answer. Nothing has been sent and no position has changed — every page here
        only reads. Try again; if it keeps failing, the subgraph this deployment points at is likely down, and
        the market itself is unaffected either way.
      </p>
      {error.digest === undefined ? null : (
        <p className="num mt-3 text-xs text-faint">reference {error.digest}</p>
      )}
      <button
        type="button"
        onClick={reset}
        className="mt-5 rounded-control border border-lime px-4 py-2.5 text-sm font-semibold text-lime transition-colors hover:bg-lime hover:text-ink"
      >
        Try again
      </button>
    </div>
  );
}
