import type { MetadataRoute } from 'next';

import { DOCS, docHref } from '@/content/docs-nav';
import { getVenue } from '@/lib/server/venue';
import { SITE_URL } from '@/lib/site';

/** Rebuilt every 5 minutes: the static pages plus one entry per listed market. */
export const revalidate = 300;

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const pages: { path: string; priority: number; changeFrequency: 'hourly' | 'daily' | 'weekly' }[] = [
    { path: '/', priority: 1, changeFrequency: 'hourly' },
    { path: '/how-it-works', priority: 0.8, changeFrequency: 'weekly' },
    { path: '/start', priority: 0.8, changeFrequency: 'weekly' },
    { path: '/proof', priority: 0.7, changeFrequency: 'daily' },
    ...DOCS.map((doc) => ({ path: docHref(doc.slug), priority: doc.slug === '' ? 0.6 : 0.5, changeFrequency: 'weekly' as const })),
  ];
  let markets: { path: string; priority: number; changeFrequency: 'hourly' | 'daily' | 'weekly' }[] = [];
  try {
    const venue = await getVenue();
    markets = venue.data.markets.slice(0, 500).map((market) => ({
      path: `/m/${market.id.toString()}`,
      priority: market.statusCode === 0 ? 0.7 : 0.4,
      changeFrequency: market.statusCode === 0 ? ('hourly' as const) : ('weekly' as const),
    }));
  } catch {
    markets = [];
  }
  return [...pages, ...markets].map((page) => ({
    url: `${SITE_URL}${page.path === '/' ? '' : page.path}`,
    changeFrequency: page.changeFrequency,
    priority: page.priority,
  }));
}
