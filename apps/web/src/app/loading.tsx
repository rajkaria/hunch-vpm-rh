import { LoadingBlock } from '@/components/ui/primitives';

/**
 * A calm placeholder while the board is read.
 *
 * It does not shimmer. A shimmer is an animation that says "still working",
 * and with data this fast it is on screen for less time than it takes to read,
 * which leaves a flicker behind rather than an explanation.
 */
export default function Loading() {
  return (
    <div className="space-y-4">
      <LoadingBlock label="Reading the markets…" rows={2} />
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <LoadingBlock label="" rows={4} />
        <LoadingBlock label="" rows={4} />
        <LoadingBlock label="" rows={4} />
      </div>
    </div>
  );
}
