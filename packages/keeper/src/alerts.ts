import type { EnvLike } from './wallet.js';

/**
 * Optional paging through Telegram (TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID). Never throws:
 * a failed page must not stop a keeper job. Messages are redacted before sending.
 */

export interface Alerter {
  enabled: boolean;
  page(message: string): Promise<boolean>;
}

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ ok: boolean }>;

export function makeAlerter(env: EnvLike, options: { redact?: (text: string) => string; fetch?: FetchLike; prefix?: string } = {}): Alerter {
  const token = env.TELEGRAM_BOT_TOKEN?.trim();
  const chat = env.TELEGRAM_CHAT_ID?.trim();
  const redact = options.redact ?? ((t: string) => t);
  const doFetch = options.fetch ?? ((globalThis as { fetch?: FetchLike }).fetch as FetchLike | undefined);
  if (!token || !chat || doFetch === undefined) return { enabled: false, page: async () => false };
  const prefix = options.prefix ?? 'Hunch keeper';
  return {
    enabled: true,
    async page(message: string) {
      try {
        const res = await doFetch(`https://api.telegram.org/bot${token}/sendMessage`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ chat_id: chat, text: redact(`${prefix}: ${message}`).slice(0, 4000), disable_web_page_preview: true }),
        });
        return res.ok;
      } catch {
        return false;
      }
    },
  };
}
