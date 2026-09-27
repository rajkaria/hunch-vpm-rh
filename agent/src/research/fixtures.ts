/**
 * Loading `fixtures/markets.json` into a `FixtureWorld`.
 *
 * Times in the file are offsets, not timestamps, so the fixtures do not expire: a market
 * described as freezing in four minutes is still freezing in four minutes next year.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { KAPPA_UNBOUNDED } from "../domain/types.js";
import type { FeedDirection, Hex } from "../domain/types.js";
import { parseUsdc } from "../domain/units.js";
import { PLACEHOLDER_ADDRESS } from "../config.js";
import { asArray, asBigint, asNumber, asObject, asString, field, optionalField } from "./decode.js";
import { FixtureWorld } from "./fixture-world.js";
import type { WorldBook, WorldMarket } from "./fixture-world.js";

/** `VestedParimutuel.SCALE`. */
const SCALE = 10n ** 18n;

export const DEFAULT_FIXTURE_PATH = fileURLToPath(new URL("../../fixtures/markets.json", import.meta.url));

export function loadFixtureWorld(now: number, path: string = DEFAULT_FIXTURE_PATH): FixtureWorld {
  return parseFixtureWorld(JSON.parse(readFileSync(path, "utf8")) as unknown, now);
}

export function parseFixtureWorld(raw: unknown, now: number): FixtureWorld {
  const root = asObject(raw, "fixtures");
  const markets = asArray(field(root, "markets", "fixtures"), "fixtures.markets");
  return new FixtureWorld(markets.map((m, i) => parseMarket(m, `fixtures.markets[${String(i)}]`, now, i)));
}

function parseMarket(raw: unknown, path: string, now: number, index: number): WorldMarket {
  const m = asObject(raw, path);
  const marketId = asString(field(m, "id", path), `${path}.id`);
  const kappaText = asString(field(m, "kappa", path), `${path}.kappa`);
  const kappa = kappaText === "unbounded" ? KAPPA_UNBOUNDED : BigInt(kappaText);

  const openedAt = now - asNumber(field(m, "openedSecondsAgo", path), `${path}.openedSecondsAgo`);
  const resolutionTime = now + asNumber(field(m, "freezeInSeconds", path), `${path}.freezeInSeconds`);

  const specRaw = asObject(field(m, "spec", path), `${path}.spec`);
  const directionValue = asNumber(field(specRaw, "direction", `${path}.spec`), `${path}.spec.direction`);
  if (directionValue !== 0 && directionValue !== 1) {
    throw new Error(`${path}.spec.direction: expected 0 or 1, got ${String(directionValue)}`);
  }

  const intelRaw = asObject(field(m, "intel", path), `${path}.intel`);
  const outcomes = asArray(field(m, "outcomes", path), `${path}.outcomes`);

  return {
    marketId,
    // Nothing is deployed, so there is no real index to mirror; file order is the one
    // stable numbering a fixture can offer, and the settler's ids are 0-based too.
    onChainMarketId: BigInt(index),
    question: asString(field(m, "question", path), `${path}.question`),
    // Nothing is deployed yet, so every fixture market points at the placeholder settler.
    settler: PLACEHOLDER_ADDRESS,
    token: "0x3600000000000000000000000000000000000000" as Hex,
    kappa,
    openedAt,
    resolutionTime,
    spec: {
      feedKey: asString(field(specRaw, "feedKey", `${path}.spec`), `${path}.spec.feedKey`),
      strike8: asBigint(field(specRaw, "strike8", `${path}.spec`), `${path}.spec.strike8`),
      direction: directionValue as FeedDirection,
      maxStaleness: asNumber(field(specRaw, "maxStaleness", `${path}.spec`), `${path}.spec.maxStaleness`),
    },
    books: outcomes.map((o, i) => parseBook(o, `${path}.outcomes[${String(i)}]`, i, kappa)),
    status: "open",
    winner: undefined,
    intel: {
      price8: asBigint(field(intelRaw, "price8", `${path}.intel`), `${path}.intel.price8`),
      volAnnualised: asNumber(field(intelRaw, "volAnnualised", `${path}.intel`), `${path}.intel.volAnnualised`),
      driftPerTick: asNumber(field(intelRaw, "driftPerTick", `${path}.intel`), `${path}.intel.driftPerTick`),
      source: asString(field(intelRaw, "source", `${path}.intel`), `${path}.intel.source`),
    },
    flowPerTick: parseUsdc(asString(field(m, "flowPerTickUsdc", path), `${path}.flowPerTickUsdc`)),
  };
}

function parseBook(raw: unknown, path: string, outcome: number, kappa: bigint): WorldBook {
  const b = asObject(raw, path);
  const principal = parseUsdc(asString(field(b, "principalUsdc", path), `${path}.principalUsdc`));
  const vested = parseUsdc(asString(field(b, "vestedUsdc", path), `${path}.vestedUsdc`));
  if (principal <= 0n) throw new Error(`${path}.principalUsdc: a book with no principal cannot exist`);

  const capacityOverride = optionalField(b, "capacityUsdc");
  const capacity =
    kappa === KAPPA_UNBOUNDED
      ? KAPPA_UNBOUNDED
      : capacityOverride === undefined
        ? kappa * principal
        : parseUsdc(asString(capacityOverride, `${path}.capacityUsdc`));

  // A_w is a running accumulator on-chain. A fixture is a snapshot, so unless the file
  // says otherwise the starting value is the one consistent with the vesting recorded
  // against this book: A_w = V_w / P_w.
  const accOverride = optionalField(b, "accE18");
  const acc =
    accOverride === undefined ? (vested * SCALE) / principal : asBigint(accOverride, `${path}.accE18`);

  return {
    outcome,
    label: asString(field(b, "label", path), `${path}.label`),
    principal,
    acc,
    capacity,
    vested,
    holders: asNumber(field(b, "holders", path), `${path}.holders`),
    trust: asNumber(field(b, "trust", path), `${path}.trust`),
  };
}
