/**
 * The Circle layer.
 *
 * The dry-run pair is tested for behaviour; the live pair is tested only for the
 * promises the rest of the package relies on — that constructing it without credentials
 * is refused up front, and that the HTTP client retries what is worth retrying.
 */

import { describe, expect, it } from "vitest";
import { DryRunNanopayments, DryRunWallet, dryRunAddress } from "../src/circle/dry-run.js";
import { HttpClient, pick } from "../src/circle/http.js";
import { CircleAgentWallet, GatewayNanopayments } from "../src/circle/live.js";
import { CircleConfigError, CircleRequestError } from "../src/circle/types.js";
import type { AgentTx } from "../src/circle/types.js";
import { formatMicroUsdc, formatUsdc, parseUsdc } from "../src/domain/units.js";
import { ConsoleLogger, MemoryLogger } from "../src/log.js";

const clock = (): number => 1_800_000_000;

function wallet(balance = "1000"): DryRunWallet {
  return new DryRunWallet({ seed: "test-seed", startingBalance: parseUsdc(balance), now: clock });
}

function tx(overrides: Partial<AgentTx> = {}): AgentTx {
  return {
    label: "enter",
    to: "0x0000000000000000000000000000000000000000",
    data: "0x",
    value: 0n,
    settlementDebit: 0n,
    ...overrides,
  };
}

describe("dry-run wallet", () => {
  it("needs no key, no network and no environment", async () => {
    const w = wallet();
    expect(w.mode).toBe("dry-run");
    expect(await w.address()).toMatch(/^0x[0-9a-f]{40}$/);
    expect(await w.balance()).toBe(parseUsdc("1000"));
  });

  it("is deterministic: the same seed gives the same address and the same hashes", async () => {
    const a = wallet();
    const b = wallet();
    expect(await a.address()).toBe(await b.address());
    expect((await a.send(tx())).hash).toBe((await b.send(tx())).hash);
    expect(dryRunAddress("other")).not.toBe(dryRunAddress("test-seed"));
  });

  it("debits what the call actually moves, and nothing for gas", async () => {
    const w = wallet();
    await w.send(tx({ settlementDebit: parseUsdc("150") }));
    expect(formatUsdc(await w.balance())).toBe("850.00");
    await w.send(tx({ value: parseUsdc("50") }));
    expect(formatUsdc(await w.balance())).toBe("800.00");
  });

  it("fails a send it cannot cover instead of going negative", async () => {
    const w = wallet("10");
    const result = await w.send(tx({ settlementDebit: parseUsdc("100") }));
    expect(result.status).toBe("failed");
    expect(formatUsdc(await w.balance())).toBe("10.00");
  });

  it("keeps a transcript of everything it was asked to send", async () => {
    const w = wallet();
    await w.send(tx({ label: "approve" }));
    await w.send(tx({ label: "enter" }));
    expect(w.sent().map((r) => r.tx.label)).toEqual(["approve", "enter"]);
    expect(w.sent().every((r) => r.at === clock())).toBe(true);
  });

  it("describes itself as exactly an address and a disclaimer", async () => {
    const w = wallet();
    expect(w.description).toBe(`dry-run wallet ${await w.address()} (no key, no network)`);
  });
});

describe("dry-run nanopayments", () => {
  it("collapses many authorizations into one settlement", async () => {
    const channel = new DryRunNanopayments({ seed: "test-seed", now: clock });
    for (let i = 0; i < 24; i += 1) await channel.authorize(250n, `quote:FEED${String(i)}`);

    expect(channel.pending()).toHaveLength(24);
    expect(channel.totalAuthorizedMicroUsdc()).toBe(6_000n);

    const settlement = await channel.settle();
    expect(settlement.authorizations).toBe(24);
    expect(settlement.totalMicroUsdc).toBe(6_000n);
    expect(settlement.txHash).toBeDefined();
    // 24 paid calls for six-thousandths of a USDC, in one on-chain payment.
    expect(formatMicroUsdc(settlement.totalMicroUsdc)).toBe("0.006");
    expect(channel.pending()).toHaveLength(0);
  });

  it("settles an empty channel without inventing a payment", async () => {
    const channel = new DryRunNanopayments({ seed: "test-seed", now: clock });
    const settlement = await channel.settle();
    expect(settlement.authorizations).toBe(0);
    expect(settlement.txHash).toBeUndefined();
  });

  it("counts lifetime usage across settlements", async () => {
    const channel = new DryRunNanopayments({ seed: "test-seed", now: clock });
    await channel.authorize(250n, "a");
    await channel.settle();
    await channel.authorize(250n, "b");
    await channel.settle();
    expect(channel.stats()).toEqual({ calls: 2, microUsdc: 500n, settlements: 2 });
  });
});

describe("live adapters", () => {
  const deps = { fetchImpl: (() => Promise.reject(new Error("no network in tests"))) as typeof fetch, sleep: () => Promise.resolve() };
  const base = {
    apiBase: "https://example.invalid",
    walletId: "w",
    entitySecretCiphertext: "c",
    usdcAddress: "0x3600000000000000000000000000000000000000" as const,
    explorerBase: "https://testnet.arcscan.app",
    feeLevel: "MEDIUM" as const,
    pollIntervalMs: 1,
    pollAttempts: 1,
  };

  it("refuses to construct without credentials, rather than failing mid-loop", () => {
    expect(() => new CircleAgentWallet({ ...base, apiKey: "" }, deps)).toThrow(CircleConfigError);
    expect(() => new CircleAgentWallet({ ...base, apiKey: "k", walletId: "" }, deps)).toThrow(
      CircleConfigError,
    );
    expect(
      () => new CircleAgentWallet({ ...base, apiKey: "k", entitySecretCiphertext: "" }, deps),
    ).toThrow(CircleConfigError);
    expect(
      () =>
        new GatewayNanopayments(
          { apiBase: "x", apiKey: "", accountId: "a", authorizePath: "/a", settlePath: "/s" },
          deps,
        ),
    ).toThrow(CircleConfigError);
  });

  it("describes itself without naming the key", () => {
    const w = new CircleAgentWallet({ ...base, apiKey: "sk-do-not-log-me" }, deps);
    expect(w.description).not.toContain("sk-do-not-log-me");
    expect(w.mode).toBe("live");
  });

  /**
   * Circle's REST API talks in human decimal strings, not base units. Reading a balance
   * and sending native value are the two places that convention is crossed, and getting
   * one of them backwards is a factor of a million. The round trip is the test.
   */
  describe("the Circle unit convention, both directions", () => {
    /** A Circle stub: balances on GET /balances, a confirmed transaction for everything else. */
    function circleStub(balanceAmount: string) {
      const posted: unknown[] = [];
      const fetchImpl = ((url: string, init?: RequestInit): Promise<Response> => {
        if (url.endsWith("/balances")) {
          const body = {
            data: {
              tokenBalances: [
                { token: { tokenAddress: base.usdcAddress, isNative: true }, amount: balanceAmount },
              ],
            },
          };
          return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
        }
        if (init?.method === "POST") {
          posted.push(JSON.parse(String(init.body)));
          return Promise.resolve(new Response(JSON.stringify({ data: { id: "tx-1" } }), { status: 200 }));
        }
        const confirmed = { data: { transaction: { state: "CONFIRMED", txHash: "0xfeed" } } };
        return Promise.resolve(new Response(JSON.stringify(confirmed), { status: 200 }));
      }) as unknown as typeof fetch;
      return {
        posted,
        wallet: new CircleAgentWallet({ ...base, apiKey: "k" }, { fetchImpl, sleep: () => Promise.resolve() }),
      };
    }

    it("reads a balance as a decimal string and returns base units", async () => {
      const { wallet: w } = circleStub("12.5");
      expect(await w.balance()).toBe(parseUsdc("12.5"));
      expect(formatUsdc(await w.balance())).toBe("12.50");
    });

    it("sends native value as the same decimal string it would read back", async () => {
      const { posted, wallet: w } = circleStub("0");
      const result = await w.send(tx({ value: parseUsdc("12.5") }));
      expect(result.status).toBe("confirmed");

      const body = posted[0] as { amount: string };
      // The bug this guards against: "12500000", which Circle would read as 12.5m USDC.
      expect(body.amount).toBe("12.50");
      expect(parseUsdc(body.amount)).toBe(parseUsdc("12.5"));
    });

    it("round-trips a sub-cent value without losing a base unit", async () => {
      const { posted, wallet: w } = circleStub("0");
      await w.send(tx({ value: 1n }));
      const body = posted[0] as { amount: string };
      expect(body.amount).toBe("0.000001");
      expect(parseUsdc(body.amount)).toBe(1n);
    });

    it("omits the amount entirely when the call carries no native value", async () => {
      const { posted, wallet: w } = circleStub("0");
      await w.send(tx({ value: 0n }));
      expect((posted[0] as Record<string, unknown>)["amount"]).toBeUndefined();
    });
  });
});

describe("http client", () => {
  function client(responses: readonly (() => Response)[], sleeps: number[]): HttpClient {
    let call = 0;
    const fetchImpl = ((): Promise<Response> => {
      const next = responses[Math.min(call, responses.length - 1)];
      call += 1;
      return Promise.resolve((next as () => Response)());
    }) as unknown as typeof fetch;
    return new HttpClient({
      baseUrl: "https://example.invalid",
      headers: {},
      timeoutMs: 50,
      maxAttempts: 3,
      fetchImpl,
      sleep: (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
    });
  }

  it("retries a 503 and returns the body that eventually arrives", async () => {
    const sleeps: number[] = [];
    const http = client(
      [
        () => new Response("busy", { status: 503 }),
        () => new Response(JSON.stringify({ data: { id: "ok" } }), { status: 200 }),
      ],
      sleeps,
    );
    expect(pick(await http.get("/x"), "data", "id")).toBe("ok");
    expect(sleeps).toHaveLength(1);
  });

  it("does not retry a 400", async () => {
    const sleeps: number[] = [];
    const http = client([() => new Response("bad", { status: 400 })], sleeps);
    await expect(http.get("/x")).rejects.toBeInstanceOf(CircleRequestError);
    expect(sleeps).toHaveLength(0);
  });

  it("serialises bigint amounts as decimal strings", async () => {
    let seen = "";
    const fetchImpl = ((_url: string, init: RequestInit): Promise<Response> => {
      seen = String(init.body);
      return Promise.resolve(new Response("{}", { status: 200 }));
    }) as unknown as typeof fetch;
    const http = new HttpClient({
      baseUrl: "https://example.invalid",
      headers: {},
      timeoutMs: 50,
      maxAttempts: 1,
      fetchImpl,
      sleep: () => Promise.resolve(),
    });
    await http.post("/x", { amount: 12_345_678n });
    expect(seen).toBe('{"amount":"12345678"}');
  });
});

describe("logging", () => {
  it("scrubs known secrets from anything written", () => {
    const lines: string[] = [];
    const logger = new ConsoleLogger(["super-secret-api-key"]);
    // ConsoleLogger writes to the real stream, so check the behaviour through the same
    // scrubbing path a MemoryLogger cannot exercise: a stubbed stdout.
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string): boolean => {
      lines.push(chunk);
      return true;
    }) as typeof process.stdout.write;
    try {
      logger.info("request failed with super-secret-api-key in the message");
    } finally {
      process.stdout.write = original;
    }
    expect(lines.join("")).toContain("***");
    expect(lines.join("")).not.toContain("super-secret-api-key");
  });

  it("ignores values too short to be a key", () => {
    const memory = new MemoryLogger();
    memory.info("nothing to scrub here");
    expect(memory.lines).toEqual(["nothing to scrub here"]);
  });
});
