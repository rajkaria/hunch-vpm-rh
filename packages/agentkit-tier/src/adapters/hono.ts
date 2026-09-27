/**
 * Hono adapter.
 *
 * Hono is not a dependency of this package and is not imported here. The context is
 * described structurally by the two members the middleware actually uses, so the
 * middleware drops into a Hono app without this package having an opinion about which
 * Hono version you are on, and drops into anything else with the same shape.
 *
 * The decision is stored in a WeakMap keyed on the underlying `Request` rather than in
 * Hono's typed variables, so that reading it back needs no module augmentation. For
 * convenience the middleware also writes it to `c.set(contextKey, decision)` when the
 * context has a `set`, which is what you want if you have already augmented Hono's
 * `Variables`.
 */

import type { AgentTierGate, GateDecision } from '../gate.js';
import { problemResponse, toVerifiableRequest } from './fetch.js';

export interface HonoLikeRequest {
  readonly raw: Request;
}

export interface HonoLikeContext {
  readonly req: HonoLikeRequest;
  /** Sets a response header. */
  header(name: string, value: string): void;
}

export type HonoLikeNext = () => Promise<void>;

export const DEFAULT_CONTEXT_KEY = 'agentTier';

const decisions = new WeakMap<Request, GateDecision>();

/** The decision for the request currently in flight, or undefined outside the middleware. */
export function agentTierOf(c: HonoLikeContext): GateDecision | undefined {
  return decisions.get(c.req.raw);
}

export interface HonoMiddlewareOptions {
  /** Variable name used for the best-effort `c.set`. Default `"agentTier"`. */
  readonly contextKey?: string | undefined;
}

export function createHonoAgentTierMiddleware(
  gate: AgentTierGate,
  options: HonoMiddlewareOptions = {},
): (c: HonoLikeContext, next: HonoLikeNext) => Promise<Response | undefined> {
  const contextKey = options.contextKey ?? DEFAULT_CONTEXT_KEY;

  return async (c, next) => {
    const decision = await gate.evaluate(toVerifiableRequest(c.req.raw));
    decisions.set(c.req.raw, decision);
    setVariable(c, contextKey, decision);

    if (!decision.ok) return problemResponse(decision);

    for (const [name, value] of Object.entries(decision.headers)) c.header(name, value);
    await next();
    return undefined;
  };
}

interface ContextWithSet {
  set(key: string, value: unknown): void;
}

/**
 * Hono's `set` is typed against an app's `Variables` generic, which this package cannot
 * see. The call is made by feature detection instead, so the middleware stays usable by
 * an app that has not augmented anything.
 */
function setVariable(c: HonoLikeContext, key: string, value: unknown): void {
  const candidate = c as unknown as Partial<ContextWithSet>;
  if (typeof candidate.set === 'function') candidate.set(key, value);
}
