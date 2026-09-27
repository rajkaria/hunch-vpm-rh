import { HERO_SUB, HERO_TITLE } from '@/lib/site';

export default function LandingPage() {
  return (
    <section className="py-16">
      <h1 className="display-xl text-4xl sm:text-6xl">{HERO_TITLE}</h1>
      <p className="mt-4 max-w-xl text-muted">{HERO_SUB}</p>
    </section>
  );
}
