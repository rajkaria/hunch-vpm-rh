import { OG_ALT, OG_SIZE, renderShareCard } from '@/lib/og';

export const alt = OG_ALT;
export const size = OG_SIZE;
export const contentType = 'image/png';

export default function OpenGraphImage() {
  return renderShareCard();
}
