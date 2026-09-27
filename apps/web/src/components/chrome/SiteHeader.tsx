import Link from 'next/link';

export function SiteHeader() {
  return (
    <header className="border-b border-edge">
      <div className="mx-auto flex w-full max-w-[1180px] items-center gap-4 px-4 py-3 sm:px-6">
        <Link href="/" className="flex min-h-11 items-center gap-3" aria-label="Hunch on Robinhood Chain, home">
          <img src="/brand/hunch-lockup.svg" alt="Hunch" width={113} height={24} className="h-6 w-auto" />
        </Link>
      </div>
    </header>
  );
}
