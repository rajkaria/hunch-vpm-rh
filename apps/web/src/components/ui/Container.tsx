import type { ReactNode } from 'react';

/** The page column: 1180 px wide, a 16 px gutter on a phone, 24 px from 640 px up. */
export function Container({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`mx-auto w-full max-w-[1180px] px-4 sm:px-6 ${className}`}>{children}</div>;
}
