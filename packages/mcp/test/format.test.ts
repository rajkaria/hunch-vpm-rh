import { describe, expect, it } from "vitest";

import {
  decimalOdds,
  formatDuration,
  formatPercent,
  formatRelative,
  formatUsdc,
  isAddress,
  isUnbounded,
  money,
  parseUsdc,
  renderTable,
  shortAddress,
  toIso,
  UNBOUNDED,
} from "../src/format.js";

describe("USDC formatting", () => {
  it("renders base units as decimals without trailing zeros", () => {
    expect(formatUsdc(0n)).toBe("0");
    expect(formatUsdc(1_000_000n)).toBe("1");
    expect(formatUsdc(1_234_500n)).toBe("1.2345");
    expect(formatUsdc(1n)).toBe("0.000001");
    expect(formatUsdc(1_000_000_000_000n)).toBe("1000000");
  });

  it("keeps the exact base units alongside the display form", () => {
    expect(money(2_500_000n)).toEqual({ base: "2500000", usdc: "2.5", display: "2.5 USDC" });
  });

  it("names the unbounded sentinel instead of printing a 78-digit number", () => {
    const view = money(UNBOUNDED);
    expect(view.unbounded).toBe(true);
    expect(view.display).toBe("unbounded");
    expect(view.base).toBe(UNBOUNDED.toString());
  });

  it("treats a sentinel shaved by arithmetic as unbounded", () => {
    expect(isUnbounded(UNBOUNDED - 1_000_000n)).toBe(true);
    expect(isUnbounded(10n ** 18n)).toBe(false);
  });
});

describe("parseUsdc", () => {
  it("parses whole and fractional amounts", () => {
    expect(parseUsdc("250")).toBe(250_000_000n);
    expect(parseUsdc("250.5")).toBe(250_500_000n);
    expect(parseUsdc(" 0.000001 ")).toBe(1n);
  });

  it("refuses precision USDC does not have, rather than rounding it away", () => {
    expect(() => parseUsdc("1.0000001")).toThrow(/7 decimal places/);
  });

  it("refuses anything that is not a plain decimal", () => {
    expect(() => parseUsdc("1e6")).toThrow(/plain decimal/);
    expect(() => parseUsdc("-5")).toThrow(/plain decimal/);
    expect(() => parseUsdc("250 USDC")).toThrow(/plain decimal/);
  });
});

describe("time and odds", () => {
  it("formats durations to two units", () => {
    expect(formatDuration(45)).toBe("45s");
    expect(formatDuration(6_360)).toBe("1h 46m");
    expect(formatDuration(273_600)).toBe("3d 4h");
    expect(formatDuration(3_600)).toBe("1h");
  });

  it("says which side of now a moment is on", () => {
    expect(formatRelative(6_360)).toBe("in 1h 46m");
    expect(formatRelative(-6_360)).toBe("1h 46m ago");
    expect(formatRelative(0)).toBe("now");
  });

  it("turns probabilities into percentages and decimal odds", () => {
    expect(formatPercent(0.909_091)).toBe("90.9%");
    expect(decimalOdds(0.5)).toBe(2);
    expect(decimalOdds(0)).toBeNull();
  });

  it("emits ISO timestamps", () => {
    expect(toIso(1_790_791_200)).toBe("2026-09-30T18:00:00.000Z");
  });
});

describe("addresses and tables", () => {
  it("validates and shortens addresses", () => {
    expect(isAddress("0x1f9840a85d5af5bf1d1762f925bdaddc4201f984")).toBe(true);
    expect(isAddress("0x1234")).toBe(false);
    expect(shortAddress("0x1F9840A85D5aF5bf1D1762F925BDADdC4201F984")).toBe("0x1f98…f984");
  });

  it("aligns columns and trims the trailing padding", () => {
    const table = renderTable(["a", "bbb"], [["xx", "y"]]);
    expect(table).toBe("a   bbb\nxx  y");
  });
});
