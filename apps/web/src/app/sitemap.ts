import type { MetadataRoute } from 'next';

import { DOCS, docHref } from '@/content/docs-nav';
import { SITE_URL } from '@/lib/site';

// S7: add one entry per market (/m/[id]) once markets are enumerable.
export default function sitemap(): MetadataRoute.Sitemap {
  const pages: { path: string; priority: number; changeFrequency: 'hourly' | 'daily' | 'weekly' }[] = [
    { path: '/', priority: 1, changeFrequency: 'hourly' },
    { path: '/how-it-works', priority: 0.8, changeFrequency: 'weekly' },
    { path: '/start', priority: 0.8, changeFrequency: 'weekly' },
    { path: '/proof', priority: 0.7, changeFrequency: 'daily' },
    ...DOCS.map((doc) => ({ path: docHref(doc.slug), priority: doc.slug === '' ? 0.6 : 0.5, changeFrequency: 'weekly' as const })),
  ];
  return pages.map((page) => ({
    url: `${SITE_URL}${page.path === '/' ? '' : page.path}`,
    changeFrequency: page.changeFrequency,
    priority: page.priority,
  }));
}
