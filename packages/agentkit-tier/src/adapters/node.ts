/**
 * Plain Node `http` adapter, in the connect/express `(req, res, next)` shape.
 *
 * `@types/node` is not a dependency: the request and response are described by the
 * members used, so this works against `http.IncomingMessage`, express, and anything
 * else with the same surface.
 */

import type { AgentTierGate, GateDecision } from '../gate.js';
import type { VerifiableRequest } from '../types.js';

export interface NodeLikeRequest {
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly method?: string | undefined;
  /** Origin-form target, e.g. `/v1/markets?limit=10`. */
  readonly url?: string | undefined;
}

export interface NodeLikeResponse {
  setHeader(name: string, value: string): void;
  statusCode: number;
  end(chunk?: string): void;
}

export type NodeNext = (error?: unknown) => void;

const decisions = new WeakMap<object, GateDecision>();

/**
 * The decision attached to a request by the middleware.
 *
 * A WeakMap rather than a property on `req`: express-style property stamping needs
 * module augmentation to typecheck and collides with whatever else stamped the same
 * name.
 */
export function agentTierOf(req: NodeLikeRequest): GateDecision | undefined {
  return decisions.get(req as object);
}

export function toVerifiableRequest(req: NodeLikeRequest): VerifiableRequest {
  const target = req.url ?? '/';
  // The origin is irrelevant and never inspected; it is only here because URL needs a
  // base to parse an origin-form target.
  const path = new URL(target, 'http://request.invalid').pathname;
  return { headers: req.headers, method: req.method, path };
}

export interface NodeMiddlewareOptions {
  /**
   * Called instead of the default problem response when the gate blocks a request.
   * Use it to match an existing error envelope.
   */
  readonly onBlocked?: ((req: NodeLikeRequest, res: NodeLikeResponse, decision: GateDecision) => void) | undefined;
}

export function createNodeAgentTierMiddleware(
  gate: AgentTierGate,
  options: NodeMiddlewareOptions = {},
): (req: NodeLikeRequest, res: NodeLikeResponse, next: NodeNext) => void {
  return (req, res, next) => {
    gate
      .evaluate(toVerifiableRequest(req))
      .then((decision) => {
        decisions.set(req as object, decision);
        for (const [name, value] of Object.entries(decision.headers)) res.setHeader(name, value);

        if (decision.ok) {
          next();
          return;
        }
        if (options.onBlocked !== undefined) {
          options.onBlocked(req, res, decision);
          return;
        }
        const problem = decision.problem;
        /* istanbul ignore next -- `ok: false` always carries a problem; this is a type guard. */
        if (problem === null) {
          next();
          return;
        }
        res.statusCode = problem.status;
        res.setHeader('content-type', 'application/problem+json');
        res.end(
          JSON.stringify({
            type: `https://hunch.xyz/problems/${problem.code}`,
            title: problem.code === 'rate_limited' ? 'Too many requests' : 'Invalid agent proof',
            status: problem.status,
            detail: problem.detail,
            tier: decision.tier,
          }),
        );
      })
      // An error here is a bug in the gate or a rejection from a caller-supplied hook,
      // not a failed proof. It goes to the framework's error handler rather than being
      // swallowed into an anonymous pass.
      .catch((error: unknown) => next(error));
  };
}
