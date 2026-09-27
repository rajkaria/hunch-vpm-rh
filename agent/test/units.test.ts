import { describe, expect, it } from "vitest";
import {
  AmountError,
  clamp,
  describeMicroUsdc,
  formatMicroUsdc,
  formatUsdc,
  maxBigint,
  minBigint,
  parseUsdc,
  pct,
  ratio,
  scaleByFraction,
} from "../src/domain/units.js";

describe("parseUsdc", () => {
  it("reads whole and fractional amounts at six decimals", () => {
    expect(parseUsdc("1")).toBe(1_000_000n);
    expect(parseUsdc("12.5")).toBe(12_500_000n);
    expect(parseUsdc("0.000001")).toBe(1n);
    expect(parseUsdc("-3.25")).toBe(-3_250_000n);
  });

  it("truncates beyond six decimals rather than rounding a token into existence", () => {
    expect(parseUsdc("0.0000019")).toBe(1n);
  });

  it("rejects anything that is not a plain decimal", () => {
    for (const bad of ["", "abc", "1e6", "1.2.3", "0x10", " 1 2 "]) {
      expect(() => parseUsdc(bad)).toThrow(AmountError);
    }
  });
});

describe("formatUsdc", () => {
  it("round-trips", () => {
    for (const text of ["0.00", "1.00", "12.50", "1000000.00", "0.000001"]) {
      expect(formatUsdc(parseUsdc(text))).toBe(text);
    }
  });

  it("always shows at least two decimals", () => {
    expect(formatUsdc(0n)).toBe("0.00");
    expect(formatUsdc(1_500_000n)).toBe("1.50");
  });

  it("keeps the sign", () => {
    expect(formatUsdc(-1_500_000n)).toBe("-1.50");
  });
});

describe("scaleByFraction", () => {
  it("never converts a token amount through a float", () => {
    // 2^70 base units: a float would have lost the low bits long before here.
    const huge = 1n << 70n;
    expect(scaleByFraction(huge, 0.5)).toBe(huge / 2n);
  });

  it("floors rather than rounding up", () => {
    expect(scaleByFraction(10n, 0.19)).toBe(1n);
  });

  it("clamps a nonsense fraction to zero instead of producing a negative stake", () => {
    expect(scaleByFraction(1_000_000n, -1)).toBe(0n);
    expect(scaleByFraction(1_000_000n, Number.NaN)).toBe(0n);
  });
});

describe("ratio", () => {
  it("divides without overflowing a float", () => {
    expect(ratio(42n, 100n)).toBeCloseTo(0.42, 9);
    expect(ratio(1n << 100n, 1n << 101n)).toBeCloseTo(0.5, 9);
  });

  it("reads 0/0 as zero rather than NaN", () => {
    expect(ratio(0n, 0n)).toBe(0);
  });
});

describe("helpers", () => {
  it("min and max need at least one value", () => {
    expect(minBigint(3n, 1n, 2n)).toBe(1n);
    expect(maxBigint(3n, 1n, 2n)).toBe(3n);
    expect(() => minBigint()).toThrow(AmountError);
  });

  it("clamps", () => {
    expect(clamp(5, 0, 1)).toBe(1);
    expect(clamp(-5, 0, 1)).toBe(0);
    expect(clamp(Number.NaN, 0, 1)).toBe(0);
  });

  it("formats percentages and micro-USDC", () => {
    expect(pct(0.4237)).toBe("42.4%");
    expect(formatMicroUsdc(1_500_000n)).toBe("1.5");
    // One micro-USDC is one USDC base unit, so 250 µUSDC is 250 base units — 0.00025 USDC.
    // On chain that is a perfectly legal amount; it is the gas to move it that is not.
    expect(formatMicroUsdc(250n)).toBe("0.00025");
    expect(parseUsdc("0.00025")).toBe(250n);
    expect(describeMicroUsdc(3_250n)).toBe("3250 µUSDC (0.00325 USDC)");
  });

  it("treats one micro-USDC as one USDC base unit, because that is what six decimals means", () => {
    // The README's claim about nanopayments rests on this: the amounts are on-chain-legal,
    // they are just far smaller than the gas of a transaction that would carry them.
    expect(formatMicroUsdc(1n)).toBe("0.000001");
    expect(parseUsdc("0.000001")).toBe(1n);
    expect(formatMicroUsdc(3_250n)).toBe(formatUsdc(3_250n));
    expect(parseUsdc(formatMicroUsdc(3_250n))).toBe(3_250n);
  });
});
