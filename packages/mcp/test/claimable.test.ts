import { describe, expect, it } from "vitest";

import { claimableTool } from "../src/tools/claimable.js";
import { CLAIMABLE, fakeVenue, makeDeps, SETTLER, USDC, VESTING, WALLET } from "./fixtures.js";

interface Item {
  kind: string;
  kindLabel: string;
  amount: { usdc: string };
  positionId?: string;
  marketId?: string;
  call: { contract: string; method: string; signature: string; argument: string } | null;
  vesting?: { earned: { usdc: string }; ofWhichPrincipal: { usdc: string } };
}

describe("vpm_claimable", () => {
  it("totals what can be pulled and names the call for each item", async () => {
    const payload = await claimableTool.run({ wallet: WALLET }, makeDeps());

    expect(payload.summary).toContain("can pull 1512 USDC right now, across 3 item(s)");
    expect(payload.data["total"]).toMatchObject({ usdc: "1512" });

    const items = payload.data["items"] as Item[];
    expect(items[0]?.call).toEqual({ contract: SETTLER, method: "claim", signature: "claim(uint256)", argument: "11" });
    expect(items[1]?.call).toMatchObject({ method: "withdrawRefund", argument: "24" });
    expect(items[2]?.call).toMatchObject({ method: "claimResidue", argument: "3" });
  });

  it("hands over the settler's own index as the argument, not the composite id", async () => {
    const payload = await claimableTool.run({ wallet: WALLET }, makeDeps());
    const items = payload.data["items"] as Item[];

    // Reads are addressed by `<settler>-<index>`; `claim` takes the index. Signing the
    // composite id is not a thing a wallet can do.
    expect(items[0]?.positionId).toBe(`${SETTLER}-11`);
    expect(items[0]?.call?.argument).toBe("11");
    expect(payload.summary).toContain("claim(uint256) with 11");
    expect(payload.summary).toContain("withdrawRefund(uint256) with 24");
  });

  it("falls back to the id only when the source names no call", async () => {
    const venue = fakeVenue({
      claimable: async () => ({
        wallet: WALLET,
        total: USDC,
        items: [
          {
            kind: "refund" as const,
            amount: USDC,
            marketId: "7",
            positionId: "24",
            outcome: 0,
            settler: SETTLER,
            call: undefined,
            argument: undefined,
          },
        ],
      }),
    });
    const payload = await claimableTool.run({ wallet: WALLET }, makeDeps({ venue }));
    expect((payload.data["items"] as Item[])[0]?.call).toMatchObject({ method: "withdrawRefund", argument: "24" });
  });

  it("labels each kind in words a model can repeat to a user", async () => {
    const payload = await claimableTool.run({ wallet: WALLET }, makeDeps());
    const items = payload.data["items"] as Item[];
    expect(items.map((item) => item.kindLabel)).toEqual(["settled payout", "refused remainder", "residue"]);
  });

  it("separates vested earnings from the principal that was staked", async () => {
    const payload = await claimableTool.run({ wallet: WALLET }, makeDeps());
    const items = payload.data["items"] as Item[];
    expect(items[0]?.vesting).toEqual({ earned: { base: "400000000", usdc: "400", display: "400 USDC" }, ofWhichPrincipal: { base: "1000000000", usdc: "1000", display: "1000 USDC" } });
    expect(payload.summary).toContain("1000 USDC of accepted principal plus 400 USDC vested");
  });

  it("skips the vesting reads when they are not wanted", async () => {
    let calls = 0;
    const venue = fakeVenue({
      vestingEarned: async () => {
        calls += 1;
        return VESTING;
      },
    });
    const payload = await claimableTool.run({ wallet: WALLET, explainVesting: false }, makeDeps({ venue }));
    expect(calls).toBe(0);
    expect((payload.data["items"] as Item[])[0]?.vesting).toBeUndefined();
  });

  it("still reports the money when the vesting annotation fails", async () => {
    const venue = fakeVenue({
      vestingEarned: async () => {
        throw new Error("indexer lag");
      },
    });
    const payload = await claimableTool.run({ wallet: WALLET }, makeDeps({ venue }));
    expect(payload.data["total"]).toMatchObject({ usdc: "1512" });
    expect(payload.data["notes"]).toEqual([expect.stringContaining("amounts below are unaffected")]);
  });

  it("says a position's vesting is not fixed yet rather than reporting it as zero", async () => {
    const venue = fakeVenue({ vestingEarned: async () => ({ ...VESTING, vested: undefined }) });
    const payload = await claimableTool.run({ wallet: WALLET }, makeDeps({ venue }));
    expect((payload.data["items"] as Item[])[0]?.vesting).toBeUndefined();
    expect(payload.data["notes"]).toEqual([expect.stringContaining("has not finalized")]);
  });

  it("caps the per-position reads and says how many it did", async () => {
    const many = Array.from({ length: 5 }, (_unused, index) => ({
      kind: "payout" as const,
      amount: USDC,
      marketId: "3",
      positionId: String(index),
      outcome: 0,
      settler: SETTLER,
      call: "claim",
      argument: String(index),
    }));
    const venue = fakeVenue({ claimable: async () => ({ wallet: WALLET, total: 5n * USDC, items: many }) });
    const deps = makeDeps({ venue, config: { ...makeDeps().config, maxPositionLookups: 2 } });

    const payload = await claimableTool.run({ wallet: WALLET }, deps);
    expect(payload.data["notes"]).toEqual([expect.stringContaining("2 of 5 positions")]);
  });

  it("explains the empty case instead of returning a bare zero", async () => {
    const venue = fakeVenue({ claimable: async () => ({ wallet: WALLET, total: 0n, items: [] }) });
    const payload = await claimableTool.run({ wallet: WALLET }, makeDeps({ venue }));

    expect(payload.summary).toContain("nothing to claim right now");
    expect(payload.summary).toContain("refused remainder, though, is refundable as soon as its vintage finalizes");
    expect(payload.data["count"]).toBe(0);
  });

  it("falls back to the configured settler when an item does not name one", async () => {
    const venue = fakeVenue({
      claimable: async () => ({
        wallet: WALLET,
        total: USDC,
        items: [
          {
            kind: "payout" as const,
            amount: USDC,
            marketId: "3",
            positionId: "11",
            outcome: 0,
            settler: undefined,
            call: "claim",
            argument: "11",
          },
        ],
      }),
    });
    const payload = await claimableTool.run({ wallet: WALLET }, makeDeps({ venue }));
    expect((payload.data["items"] as Item[])[0]?.call?.contract).toBe(SETTLER);
  });

  it("offers no call for a kind it does not recognise", async () => {
    const venue = fakeVenue({
      claimable: async () => ({
        wallet: WALLET,
        total: USDC,
        items: [
          {
            kind: "unknown" as const,
            amount: USDC,
            marketId: "3",
            positionId: "11",
            outcome: 0,
            settler: SETTLER,
            call: undefined,
            argument: undefined,
          },
        ],
      }),
    });
    const payload = await claimableTool.run({ wallet: WALLET }, makeDeps({ venue }));
    expect((payload.data["items"] as Item[])[0]?.call).toBeNull();
  });

  it("rejects a malformed wallet", async () => {
    await expect(claimableTool.run({ wallet: "0xnope" }, makeDeps())).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("says who signs", async () => {
    const payload = await claimableTool.run({ wallet: WALLET }, makeDeps());
    expect(payload.summary).toContain("the venue holds no keys and pushes no funds");
    expect(claimableTool.description).toMatch(/never has access to a key/);
  });

  it("reads the fixture it was written against", () => {
    expect(CLAIMABLE.items).toHaveLength(3);
  });
});
