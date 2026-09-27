/**
 * Adapter for anything that speaks the fetch API: workers, Deno, Bun, Next route
 * handlers, and Hono underneath its own context.
 */

import type { AgentTierGate, GateDecision } from '../gate.js';
import type { VerifiableRequest } from '../types.js';

export function toVerifiableRequest(request: Request): VerifiableRequest {
  // Query strings are deliberately excluded from the binding: a proof bound to a path
  // should survive a cache-busting parameter being appended by something in the middle.
  const { pathname } = new URL(request.url);
  return { headers: request.headers, method: request.method, path: pathname };
}

/** RFC 9457 problem document. Small enough to build by hand; no dependency needed. */
export function problemResponse(decision: GateDecision): Response {
  const problem = decision.problem;
  if (problem === null) {
    throw new Error('problemResponse called on a decision that has no problem');
  }
  return new Response(
    JSON.stringify({
      type: `https://hunch.xyz/problems/${problem.code}`,
      title: problem.code === 'rate_limited' ? 'Too many requests' : 'Invalid agent proof',
      status: problem.status,
      detail: problem.detail,
      tier: decision.tier,
    }),
    {
      status: problem.status,
      headers: { ...decision.headers, 'content-type': 'application/problem+json' },
    },
  );
}

export interface FetchGuardResult {
  readonly decision: GateDecision;
  /** Non-null when the request should not proceed. Return it as-is. */
  readonly response: Response | null;
}

/**
 * Evaluates a request and tells you whether to continue.
 *
 * ```ts
 * const { decision, response } = await guard(request);
 * if (response) return response;
 * // decision.tier and decision.policy are in hand for the handler
 * ```
 */
export function createFetchAgentTierGuard(
  gate: AgentTierGate,
): (request: Request) => Promise<FetchGuardResult> {
  return async (request) => {
    const decision = await gate.evaluate(toVerifiableRequest(request));
    return { decision, response: decision.ok ? null : problemResponse(decision) };
  };
}

/** Copies the gate's advisory headers onto a handler's response. */
export function withAgentTierHeaders(response: Response, decision: GateDecision): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(decision.headers)) headers.set(name, value);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
