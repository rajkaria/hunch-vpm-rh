import { LoadingBlock } from '@/components/ui/primitives';

export default function Loading() {
  return (
    <div className="space-y-6">
      <LoadingBlock label="Reading the book…" rows={3} />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]">
        <LoadingBlock label="" rows={6} />
        <LoadingBlock label="" rows={4} />
      </div>
    </div>
  );
}
