# Vendored code and its provenance

The settler this project builds around was published before this repository existed. It is
vendored verbatim rather than rewritten, so that the contracts built around it can be proven
not to have changed the mechanism.

| File | Origin | Modified |
|---|---|---|
| `src/VestedParimutuel.sol` | reference implementation published with *The Vested Parimutuel* (MIT, no dependencies) | no — byte for byte |
| `src/NaiveVestedParimutuel.sol` | the paper's §4.1 loop form, kept for gas comparison | no |
| `src/mocks/MockERC20.sol` | the reference project's transfer-exact test token | no |
| `test/Vectors.t.sol` | the reference project's differential replay | fixture path only |
| `test/Mechanism.t.sol` | the reference project's hand-checked paths | no |
| `test/Gas.t.sol` | the reference project's gas measurements | no |
| `test/vectors/vpm-vectors.json` | published conformance suite 1.2.0, 118 vectors | no |

Everything else under `src/` is new: `ClassicParimutuel`, `FeedResolver`, `MarketFactory`,
the two interfaces and the oracle adapters.

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
