'use client';

import { useEffect } from 'react';

import { Container } from '@/components/ui/Container';
import { Button } from '@/components/ui/primitives';

/**
 * What the site says when a page fails to render: what happened, what it means for money, one
 * action. The message itself is not shown (a stack trace helps nobody and may carry an endpoint);
 * the digest is, so a report can be matched to the server log.
 */
export default function Error({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error('page failed to render', error.digest ?? error.message);
  }, [error]);

  return (
    <Container className="py-20 sm:py-28">
      <div className="max-w-xl rounded-card border border-edge bg-raised p-5 sm:p-7">
        <h1 className="text-[26px] leading-tight sm:text-3xl">This page could not load.</h1>
        <p className="mt-3 text-[15px] leading-relaxed text-muted">
          A read from Robinhood Chain or from this site failed. Nothing was sent and no bet changed: pages only read. Your
          positions and payouts live on-chain and are unaffected.
        </p>
        {error.digest === undefined ? null : <p className="num mt-3 text-xs text-faint">reference {error.digest}</p>}
        <div className="mt-6">
          <Button variant="secondary" onClick={reset}>
            Try again
          </Button>
        </div>
      </div>
    </Container>
  );
}
