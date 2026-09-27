/**
 * A GraphQL POST and nothing else. The subgraphs this server reads are plain HTTP
 * endpoints; pulling in a client library would buy caching and normalization we do not
 * want here, since every failure mode has to come back as a tool result with a cause an
 * agent can report.
 */

import { asObject } from "./decode.js";
import { ToolError } from "./errors.js";

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface GraphQLClientOptions {
  readonly url: string;
  readonly apiKey?: string | undefined;
  readonly timeoutMs: number;
  /** Injected in tests; defaults to the platform fetch. */
  readonly fetchImpl?: FetchLike | undefined;
  /** Named in error messages so an agent can say which endpoint is down. */
  readonly label: string;
}

export interface GraphQLClient {
  query(document: string, variables: Record<string, unknown>): Promise<Record<string, unknown>>;
}

export function createGraphQLClient(options: GraphQLClientOptions): GraphQLClient {
  const fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));

  return {
    async query(document, variables) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), options.timeoutMs);
      let response: Response;
      try {
        response = await fetchImpl(options.url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json",
            ...(options.apiKey === undefined ? {} : { authorization: `Bearer ${options.apiKey}` }),
          },
          body: JSON.stringify({ query: document, variables }),
          signal: controller.signal,
        });
      } catch (thrown) {
        const aborted = controller.signal.aborted;
        throw new ToolError(
          "upstream_unavailable",
          aborted
            ? `${options.label} did not answer within ${options.timeoutMs}ms.`
            : `${options.label} is unreachable: ${thrown instanceof Error ? thrown.message : String(thrown)}.`,
          {
            hint: aborted ? "Raise HUNCH_VPM_REQUEST_TIMEOUT_MS or retry." : "Check the endpoint URL and network access.",
            detail: { endpoint: options.label, timeoutMs: options.timeoutMs },
            cause: thrown,
          },
        );
      } finally {
        clearTimeout(timer);
      }

      if (!response.ok) {
        const body = await safeText(response);
        throw new ToolError("upstream_unavailable", `${options.label} returned HTTP ${response.status}.`, {
          hint:
            response.status === 401 || response.status === 403
              ? "The endpoint needs an API key — set HUNCH_VPM_GRAPH_API_KEY."
              : "Retry; if it persists the endpoint or its indexer is down.",
          detail: { endpoint: options.label, status: response.status, body: body.slice(0, 400) },
        });
      }

      let payload: unknown;
      try {
        payload = await response.json();
      } catch (thrown) {
        throw new ToolError("bad_upstream_data", `${options.label} returned a body that is not JSON.`, {
          detail: { endpoint: options.label },
          cause: thrown,
        });
      }

      const body = asObject(payload, `${options.label} response`);
      const errors = body["errors"];
      if (Array.isArray(errors) && errors.length > 0) {
        const messages = errors.map((error) => readMessage(error)).join("; ");
        throw new ToolError("bad_upstream_data", `${options.label} rejected the query: ${messages}`, {
          hint: "The deployed schema does not match the query in this server. See the query constants in src/agent-directory.ts.",
          detail: { endpoint: options.label, errors: messages },
        });
      }
      const data = body["data"];
      if (data === null || data === undefined) {
        throw new ToolError("bad_upstream_data", `${options.label} returned no data.`, {
          detail: { endpoint: options.label },
        });
      }
      return asObject(data, `${options.label} data`);
    },
  };
}

function readMessage(error: unknown): string {
  if (typeof error === "object" && error !== null) {
    const message = (error as Record<string, unknown>)["message"];
    if (typeof message === "string") return message;
  }
  return String(error);
}

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}
