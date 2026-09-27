import { describe, expect, it } from "vitest";
import { redactUrl, urlSecrets } from "../src/redact.js";

/** A real gateway key's shape: 32 lowercase hex characters in the path. */
const KEY = "0123456789abcdef0123456789abcdef";
const GATEWAY = `https://gateway.thegraph.com/api/${KEY}/subgraphs/id/QmVpmSubgraphId`;

describe("redactUrl", () => {
  it("keeps the shape of a gateway URL and loses the key", () => {
    expect(redactUrl(GATEWAY)).toBe("https://gateway.thegraph.com/api/***/subgraphs/id/***");
  });

  it("never returns the key, whatever the URL looks like", () => {
    const shapes = [
      GATEWAY,
      `https://gateway.thegraph.com/api/${KEY}/deployments/id/0xabc`,
      `https://gateway.thegraph.com/api/${KEY}`,
      `https://gateway.thegraph.com/subgraphs/${KEY}`,
      `https://example.test/graphql?api_key=${KEY}`,
      `https://example.test/graphql#${KEY}`,
      `https://user:${KEY}@example.test/graphql`,
      `https://example.test/${KEY}/`,
    ];
    for (const shape of shapes) {
      expect(redactUrl(shape), shape).not.toContain(KEY);
    }
  });

  it("keeps enough to tell two endpoints apart", () => {
    expect(redactUrl(GATEWAY)).toContain("gateway.thegraph.com");
    expect(redactUrl("https://intel.example.test:8443/v1/quote")).toBe(
      "https://intel.example.test:8443/v1/quote",
    );
  });

  it("collapses a query string rather than reading it, since ?api_key= is just as common", () => {
    expect(redactUrl("https://example.test/graphql?api_key=secretvalue&foo=1")).toBe(
      "https://example.test/graphql?***",
    );
  });

  it("replaces userinfo wholesale", () => {
    expect(redactUrl("https://alice:hunter2@example.test/graphql")).toBe("https://***@example.test/graphql");
  });

  it("says a value is set without printing it when it is not a URL", () => {
    const out = redactUrl(`not-a-url-${KEY}`);
    expect(out).not.toContain(KEY);
    expect(out).toContain("not a URL");
  });

  it("redacts identifying segments even where no key is present, because guessing is the failure mode", () => {
    // A Studio URL carries no key; its numeric account id and version are hidden anyway,
    // because the rule is a whitelist of structural words rather than a hunt for secrets.
    expect(redactUrl("https://api.studio.thegraph.com/query/45678/hunch-vpm/v0.0.1")).toBe(
      "https://api.studio.thegraph.com/query/***/hunch-vpm/***",
    );
  });
});

describe("urlSecrets", () => {
  it("hands the key to the logger's scrubber", () => {
    expect(urlSecrets(GATEWAY)).toContain(KEY);
  });

  it("returns nothing for an unset, blank or unparseable value", () => {
    expect(urlSecrets(undefined)).toEqual([]);
    expect(urlSecrets("   ")).toEqual([]);
    expect(urlSecrets("not-a-url")).toEqual([]);
  });

  it("drops short segments, which would mangle unrelated output if scrubbed", () => {
    expect(urlSecrets("https://example.test/api/ab12")).toEqual([]);
  });

  it("includes a password given as userinfo", () => {
    expect(urlSecrets(`https://alice:${KEY}@example.test/graphql`)).toContain(KEY);
  });
});
