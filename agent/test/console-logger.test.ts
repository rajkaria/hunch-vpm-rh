import { describe, expect, it, vi } from "vitest";
import { ConsoleLogger } from "../src/log.js";
import { urlSecrets } from "../src/redact.js";

/**
 * The rest of the agent's tests use MemoryLogger, which does not scrub — so the scrubber
 * wiring in cli/main.ts had no coverage at all. These exercise ConsoleLogger directly,
 * because it is the logger the binary actually runs with.
 */
describe("ConsoleLogger scrubbing", () => {
  const KEY = "deadbeefdeadbeefdeadbeefdeadbeef";
  const KEYED_URL = `https://gateway.thegraph.com/api/${KEY}/subgraphs/id/QmExample`;

  function capture(fn: (logger: ConsoleLogger) => void, secrets: string[]): string {
    let out = "";
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      out += String(chunk);
      return true;
    });
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      out += String(chunk);
      return true;
    });
    try {
      fn(new ConsoleLogger(secrets));
    } finally {
      stdout.mockRestore();
      stderr.mockRestore();
    }
    return out;
  }

  it("removes a key that reaches it inside someone else's error message", () => {
    // The case redaction cannot cover: a dependency formats the URL into its own message,
    // so nothing of ours runs before the string reaches the logger.
    const out = capture(
      (logger) => logger.error(`request failed: GET ${KEYED_URL} returned 500`),
      urlSecrets(KEYED_URL),
    );
    expect(out).not.toContain(KEY);
    expect(out).toContain("***");
  });

  it("scrubs every level, not just error", () => {
    const secrets = urlSecrets(KEYED_URL);
    for (const level of ["info", "warn", "error"] as const) {
      const out = capture((logger) => logger[level](`endpoint ${KEYED_URL}`), secrets);
      expect(out, level).not.toContain(KEY);
    }
  });

  it("leaves ordinary output alone when there is nothing to scrub", () => {
    const out = capture((logger) => logger.info("3 markets, 1 entered"), []);
    expect(out).toContain("3 markets, 1 entered");
  });

  it("takes no secrets from a keyless endpoint, so nothing is over-redacted", () => {
    const keyless = "https://api.studio.thegraph.com/query/1/hunch-vpm/v0.0.1";
    expect(urlSecrets(keyless)).toEqual([]);
    const out = capture((logger) => logger.info(`endpoint ${keyless}`), urlSecrets(keyless));
    expect(out).toContain(keyless);
  });
});
