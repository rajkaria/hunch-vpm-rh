import { DocsMobileNav, DocsNav } from '@/components/docs/DocsNav';
import { Container } from '@/components/ui/Container';

export default function DocsLayout({ children }: { children: React.ReactNode }) {
  return (
    <Container className="pb-24 pt-8 sm:pt-12">
      <div className="lg:grid lg:grid-cols-[210px_minmax(0,1fr)] lg:gap-14">
        <aside className="hidden lg:block">
          <div className="sticky top-24 max-h-[calc(100dvh-7rem)] overflow-y-auto pb-8">
            <DocsNav />
          </div>
        </aside>
        <div className="min-w-0">
          <div className="mb-8 lg:hidden">
            <DocsMobileNav />
          </div>
          {children}
        </div>
      </div>
    </Container>
  );
}
