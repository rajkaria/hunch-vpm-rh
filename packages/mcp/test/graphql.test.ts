import { describe, expect, it } from "vitest";

import { createGraphQLClient, type FetchLike } from "../src/graphql.js";

function client(fetchImpl: FetchLike, timeoutMs = 1_000) {
  return createGraphQLClient({ url: "https://example.test/graphql", timeoutMs, fetchImpl, label: "the test subgraph" });
}

describe("createGraphQLClient", () => {
  it("posts the query and returns the data object", async () => {
    let seen: { url: string; body: unknown; headers: Record<string, string> } | undefined;
    const graph = createGraphQLClient({
      url: "https://example.test/graphql",
      apiKey: "key-123",
      timeoutMs: 1_000,
      label: "the test subgraph",
      fetchImpl: async (url, init) => {
        seen = {
          url,
          body: JSON.parse(String(init.body)),
          headers: init.headers as Record<string, string>,
        };
        return new Response(JSON.stringify({ data: { agent: { id: "0xabc" } } }), { status: 200 });
      },
    });

    const data = await graph.query("query Q($wallet: ID!) { agent(id: $wallet) { id } }", { wallet: "0xabc" });

    expect(data).toEqual({ agent: { id: "0xabc" } });
    expect(seen?.url).toBe("https://example.test/graphql");
    expect(seen?.body).toMatchObject({ variables: { wallet: "0xabc" } });
    expect(seen?.headers["authorization"]).toBe("Bearer key-123");
  });

  it("sends no authorization header when no key is configured", async () => {
    let headers: Record<string, string> = {};
    const graph = client(async (_url, init) => {
      headers = init.headers as Record<string, string>;
      return new Response(JSON.stringify({ data: {} }), { status: 200 });
    });
    await graph.query("{ ping }", {});
    expect(headers["authorization"]).toBeUndefined();
  });

  it("points at the API key when the endpoint answers 401", async () => {
    const graph = client(async () => new Response("no", { status: 401 }));
    await expect(graph.query("{ ping }", {})).rejects.toMatchObject({
      code: "upstream_unavailable",
      hint: expect.stringContaining("HUNCH_VPM_GRAPH_API_KEY"),
    });
  });

  it("reports other HTTP failures with the status", async () => {
    const graph = client(async () => new Response("upstream exploded", { status: 502 }));
    await expect(graph.query("{ ping }", {})).rejects.toMatchObject({
      code: "upstream_unavailable",
      message: expect.stringContaining("HTTP 502"),
    });
  });

  it("turns GraphQL errors into bad_upstream_data, carrying the message", async () => {
    const graph = client(
      async () => new Response(JSON.stringify({ errors: [{ message: "Cannot query field `humanBacked`" }] }), { status: 200 }),
    );
    await expect(graph.query("{ ping }", {})).rejects.toMatchObject({
      code: "bad_upstream_data",
      message: expect.stringContaining("Cannot query field"),
    });
  });

  it("rejects a body that is not JSON", async () => {
    const graph = client(async () => new Response("<html>gateway</html>", { status: 200 }));
    await expect(graph.query("{ ping }", {})).rejects.toMatchObject({ code: "bad_upstream_data" });
  });

  it("rejects a JSON body with neither data nor errors", async () => {
    const graph = client(async () => new Response(JSON.stringify({ extensions: {} }), { status: 200 }));
    await expect(graph.query("{ ping }", {})).rejects.toMatchObject({ message: expect.stringContaining("no data") });
  });

  it("times out instead of hanging the tool call", async () => {
    const graph = client(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => {
            reject(new Error("The operation was aborted"));
          });
        }),
      5,
    );
    await expect(graph.query("{ ping }", {})).rejects.toMatchObject({
      code: "upstream_unavailable",
      message: expect.stringContaining("did not answer within 5ms"),
      hint: expect.stringContaining("HUNCH_VPM_REQUEST_TIMEOUT_MS"),
    });
  });

  it("reports a network failure as unreachable", async () => {
    const graph = client(async () => {
      throw new Error("getaddrinfo ENOTFOUND example.test");
    });
    await expect(graph.query("{ ping }", {})).rejects.toMatchObject({
      code: "upstream_unavailable",
      message: expect.stringContaining("unreachable"),
    });
  });
});
