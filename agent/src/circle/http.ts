/**
 * The one place this package talks HTTP.
 *
 * Small on purpose: a timeout, bounded retries on the errors that are worth retrying, and
 * a rule that no header value ever reaches a log line.
 */

import { CircleRequestError } from "./types.js";

export interface HttpOptions {
  readonly baseUrl: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  readonly maxAttempts: number;
  /** Injected so tests can drive the client without real timers or a real network. */
  readonly fetchImpl: typeof fetch;
  readonly sleep: (ms: number) => Promise<void>;
}

const RETRYABLE = new Set([408, 429, 500, 502, 503, 504]);

export class HttpClient {
  constructor(private readonly options: HttpOptions) {}

  async get(path: string): Promise<unknown> {
    return this.#request("GET", path, undefined);
  }

  async post(path: string, body: unknown): Promise<unknown> {
    return this.#request("POST", path, body);
  }

  async #request(method: "GET" | "POST", path: string, body: unknown): Promise<unknown> {
    const url = new URL(path, this.options.baseUrl).toString();
    let lastError: Error | undefined;

    for (let attempt = 1; attempt <= this.options.maxAttempts; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.options.timeoutMs);
      try {
        const init: RequestInit = {
          method,
          headers: { accept: "application/json", ...this.options.headers },
          signal: controller.signal,
        };
        if (body !== undefined) {
          init.body = JSON.stringify(body, bigintToString);
          init.headers = { ...init.headers, "content-type": "application/json" };
        }
        const response = await this.options.fetchImpl(url, init);
        const text = await response.text();

        if (!response.ok) {
          // The URL and status are safe to surface; the body may echo request fields, so
          // it is truncated and never joined with header values.
          const error = new CircleRequestError(
            `${method} ${path} -> ${String(response.status)} ${text.slice(0, 240)}`,
            response.status,
          );
          if (RETRYABLE.has(response.status) && attempt < this.options.maxAttempts) {
            lastError = error;
            await this.options.sleep(backoffMs(attempt));
            continue;
          }
          throw error;
        }
        return text === "" ? {} : (JSON.parse(text) as unknown);
      } catch (cause) {
        const error = cause instanceof Error ? cause : new Error(String(cause));
        if (error instanceof CircleRequestError) throw error;
        // Network failures and aborts are worth one more try; a 4xx is not.
        if (attempt < this.options.maxAttempts) {
          lastError = error;
          await this.options.sleep(backoffMs(attempt));
          continue;
        }
        throw error;
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastError ?? new Error(`${method} ${path} failed`);
  }
}

function backoffMs(attempt: number): number {
  return Math.min(4_000, 200 * 2 ** (attempt - 1));
}

/** JSON.stringify cannot serialise bigint; amounts go out as decimal strings. */
function bigintToString(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

/** Read a nested field without reaching for `any`. */
export function pick(source: unknown, ...path: readonly string[]): unknown {
  let current = source;
  for (const key of path) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}
