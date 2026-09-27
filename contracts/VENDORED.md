# Vendored code and its provenance

The settler this project builds around was published before this repository existed. It is
vendored verbatim rather than rewritten, so that the contracts built around it can be proven
not to have changed the mechanism.

| File | Origin | Modified |
|---|---|---|
| `src/reference/VestedParimutuel.sol` | reference implementation published with *The Vested Parimutuel* (MIT, no dependencies) | no — byte for byte |
| `src/reference/NaiveVestedParimutuel.sol` | the paper's §4.1 loop form, kept for gas comparison | no |
| `src/mocks/MockERC20.sol` | the reference project's transfer-exact test token | no |
| `test/Vectors.t.sol` | the reference project's differential replay | fixture and import paths only |
| `test/Mechanism.t.sol` | the reference project's hand-checked paths | import path only |
| `test/Gas.t.sol` | the reference project's gas measurements | import path, and its output file (`GAS-REFERENCE.md`; `GAS.md` now holds the product contracts' numbers) |
| `test/vectors/vpm-vectors.json` | published conformance suite 1.2.0, 118 vectors | no |

The two vendored settler files live under `src/reference/` so that nothing new can be
mistaken for them. They are test oracles and gas baselines here; neither is deployed.

`ClassicParimutuel` and `IParimutuelSettler` come from the pre-event Arc venue
(hunch-vpm @6313376) and are kept for the ordinary-pool counterfactual only.

## What is derived from the vendored settler, not vendored

`src/HunchVPM.sol`, the settler that is deployed, is a copy of
`src/reference/VestedParimutuel.sol` changed by tagged diffs only: D1 to D7 from
`docs/spec/03-contracts.md` and two safety fixes for Robinhood Chain (D8, D9).
`DIFF.md` is the literal `diff -u` with the reason for each diff, regenerated and checked by
`scripts/diff-reference.sh` in CI, which also requires the mechanism's functions to stay byte
for byte identical to the reference. `test/Differential.t.sol` proves the two settlers produce
identical outcomes on the 118 vectors and on fuzzed sequences.

## How the byte-for-byte claim is enforced

`test_ReplayAllVectors` replays all 118 published vectors against the vendored settler. Edit
the settler and they stop passing, so CI goes red. `forge fmt` is pointed away from every
file in the table above — it had quietly rewritten the settler once, which is what prompted
the `[fmt] ignore` block in `foundry.toml`.

One honest caveat about the strength of that guard, since the test's own docstring states it
and reader-facing prose should too: payouts are compared within the suite's P8 tolerance
rather than exactly. The tolerance is one unit plus the number of later-vintage opposing
entries on that vector, which is the published runner's own `compareVector` rule. `voided`
and every `accepted` value are compared exactly, as are the no-overpayment and conservation
identities.
