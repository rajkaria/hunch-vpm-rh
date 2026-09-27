'use client';

/**
 * The last resort, if the root layout itself fails. It replaces the whole document, so it carries
 * its own html and body and inline styles (the stylesheet may be what failed).
 */
export default function GlobalError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, background: '#08080A', color: '#F4F4F2', fontFamily: 'system-ui, sans-serif' }}>
        <main style={{ maxWidth: 560, margin: '0 auto', padding: '96px 16px' }}>
          <h1 style={{ fontSize: 28, margin: 0 }}>Hunch could not load.</h1>
          <p style={{ color: 'rgba(244,244,242,0.7)', lineHeight: 1.6 }}>
            Nothing was sent and no bet changed: pages only read. Your positions live on-chain and are unaffected.
          </p>
          <button
            type="button"
            onClick={reset}
            style={{
              minHeight: 48,
              padding: '0 20px',
              borderRadius: 12,
              border: '1px solid rgba(255,255,255,0.14)',
              background: 'transparent',
              color: '#F4F4F2',
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            Try again
          </button>
        </main>
      </body>
    </html>
  );
}
