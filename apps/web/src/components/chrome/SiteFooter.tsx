import { BETA_NOTICE, COUNTRY_NOTICE } from '@/lib/site';

export function SiteFooter() {
  return (
    <footer className="border-t border-edge">
      <div className="mx-auto w-full max-w-[1180px] px-4 py-10 text-sm text-muted sm:px-6">
        <p>{COUNTRY_NOTICE}</p>
        <p className="mt-2">{BETA_NOTICE}</p>
      </div>
    </footer>
  );
}
