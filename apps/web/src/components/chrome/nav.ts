/** The primary navigation, shared by the desktop bar, the mobile menu and the footer. */
export const NAV = [
  { href: '/#markets', label: 'Markets', match: '/' },
  { href: '/how-it-works', label: 'How it works', match: '/how-it-works' },
  { href: '/proof', label: 'Proof', match: '/proof' },
  { href: '/start', label: 'Start', match: '/start' },
  { href: '/docs', label: 'Docs', match: '/docs' },
] as const;

export function isActive(pathname: string, match: string): boolean {
  if (match === '/') return pathname === '/' || pathname.startsWith('/m/');
  return pathname === match || pathname.startsWith(`${match}/`);
}
