/**
 * Where the agent's two model inputs come from, and what they cost.
 *
 * `MeteredIntelProvider` is the piece that makes the loop economical: it authorizes a
 * nanopayment per call instead of sending a transaction per call. A research round over
 * six markets is six authorizations and one settlement — which is why an agent can afford
 * to re-read the feed every round rather than once a day.
 */

import type { NanopaymentChannel } from "../circle/types.js";
import { HttpClient, pick } from "../circle/http.js";
import type { FixtureWorld } from "../research/fixture-world.js";
import type { FeedQuote, IntelProvider } from "./types.js";

/** Quotes read straight off the fixture world. Deterministic, free, offline. */
export class FixtureIntelProvider implements IntelProvider {
  readonly name = "fixture-feed";

  constructor(
    private readonly world: FixtureWorld,
    readonly pricePerCallMicroUsdc: bigint,
    private readonly now: () => number,
  ) {}

  quote(feedKey: string): Promise<FeedQuote> {
    for (const market of this.world.list()) {
      if (market.spec.feedKey !== feedKey) continue;
      return Promise.resolve({
        feedKey,
        price8: market.intel.price8,
        volAnnualised: market.intel.volAnnualised,
        observedAt: this.now(),
        source: market.intel.source,
      });
    }
    return Promise.reject(new Error(`no fixture quote for feed ${feedKey}`));
  }
}

export interface HttpIntelConfig {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly pricePerCallMicroUsdc: bigint;
  readonly fetchImpl: typeof fetch;
  readonly sleep: (ms: number) => Promise<void>;
}

/** The real paid endpoint. Returns the same two numbers; the agent still does the model. */
export class HttpIntelProvider implements IntelProvider {
  readonly name = "http-feed";
  readonly pricePerCallMicroUsdc: bigint;
  readonly #http: HttpClient;

  constructor(config: HttpIntelConfig) {
    this.pricePerCallMicroUsdc = config.pricePerCallMicroUsdc;
    this.#http = new HttpClient({
      baseUrl: config.baseUrl,
      headers: config.apiKey === "" ? {} : { authorization: `Bearer ${config.apiKey}` },
      timeoutMs: 10_000,
      maxAttempts: 3,
      fetchImpl: config.fetchImpl,
      sleep: config.sleep,
    });
  }

  async quote(feedKey: string): Promise<FeedQuote> {
    const body = await this.#http.get(`/quotes/${encodeURIComponent(feedKey)}`);
    const price8 = pick(body, "price8");
    const vol = pick(body, "volAnnualised");
    const observedAt = pick(body, "observedAt");
    const source = pick(body, "source");
    if (typeof price8 !== "string" || typeof vol !== "number" || typeof observedAt !== "number") {
      throw new Error(`intel response for ${feedKey} is missing price8/volAnnualised/observedAt`);
    }
    return {
      feedKey,
      price8: BigInt(price8),
      volAnnualised: vol,
      observedAt,
      source: typeof source === "string" ? source : "http",
    };
  }
}

/**
 * Wraps any provider with a nanopayment authorization per call.
 *
 * The authorization happens BEFORE the call, so a provider that never answers has still
 * been promised its fee and a provider that answers has always been paid. Settlement is a
 * separate, batched step — that is the whole point.
 */
export class MeteredIntelProvider implements IntelProvider {
  readonly name: string;
  readonly pricePerCallMicroUsdc: bigint;

  constructor(
    private readonly inner: IntelProvider,
    private readonly channel: NanopaymentChannel,
  ) {
    this.name = `${inner.name} (metered)`;
    this.pricePerCallMicroUsdc = inner.pricePerCallMicroUsdc;
  }

  async quote(feedKey: string): Promise<FeedQuote> {
    await this.channel.authorize(this.pricePerCallMicroUsdc, `quote:${feedKey}`);
    return this.inner.quote(feedKey);
  }
}
