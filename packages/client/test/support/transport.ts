import type { GraphQLRequest, GraphQLTransport } from '../../src/transport.js';

export type Responder = (variables: Record<string, unknown>) => unknown;

export interface FixtureTransport extends GraphQLTransport {
  /** Every request the code under test made, in order. */
  readonly calls: GraphQLRequest[];
}

/**
 * A transport backed by recorded responses, keyed by operation name.
 *
 * An operation with no recording throws rather than returning empty, so a read
 * that starts issuing a query nobody recorded fails loudly instead of quietly
 * producing a wrong answer — and no test can reach the network.
 */
export function fixtureTransport(responses: Record<string, unknown>): FixtureTransport {
  const calls: GraphQLRequest[] = [];
  return {
    calls,
    async request<T>(request: GraphQLRequest): Promise<T> {
      calls.push(request);
      if (!(request.operation in responses)) {
        throw new Error(`no fixture recorded for operation "${request.operation}"`);
      }
      const recorded = responses[request.operation];
      const resolved =
        typeof recorded === 'function' ? (recorded as Responder)(request.variables ?? {}) : recorded;
      return resolved as T;
    },
  };
}

/**
 * Serve one recorded collection through `first`/`skip`, so a test can exercise
 * the paging loop without a second fixture file.
 */
export function pagedResponder(field: string, rows: unknown[]): Responder {
  return (variables) => {
    const first = Number(variables['first'] ?? rows.length);
    const skip = Number(variables['skip'] ?? 0);
    return { [field]: rows.slice(skip, skip + first) };
  };
}
