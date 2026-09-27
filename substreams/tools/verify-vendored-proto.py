#!/usr/bin/env python3
"""Check that proto/sink/database_changes.proto still matches upstream.

`db_out` emits `sf.substreams.sink.database.v1.DatabaseChanges`. The manifest needs that
type's descriptor at pack time, and the choice is between fetching a remote .spkg on every
pack or vendoring the schema. Vendoring keeps the package buildable offline, but a
vendored copy that silently drifted from the crate the wasm actually encodes with would
produce a package whose declared output type and real output type disagree.

So: generate Rust from the vendored .proto, read the substreams-database-change crate's
own committed bindings, reduce both to the thing that actually matters — message and enum
names, prost field attributes with their tags, and enum discriminants — and compare those.
Formatting, doc comments, derive lists and prost-version cosmetics are ignored; a changed
tag, type, field name or enum value is not.

Run via `make verify-vendored-proto`.
"""

from __future__ import annotations

import json
import pathlib
import re
import subprocess
import sys
import tempfile

HERE = pathlib.Path(__file__).resolve().parent
PACKAGE = HERE.parent
VENDORED = PACKAGE / "proto" / "sink" / "database_changes.proto"
CRATE = "substreams-database-change"
GENERATED = "sf.substreams.sink.database.v1.rs"

TYPE_RE = re.compile(r"\bpub (struct|enum) (\w+)")
FIELD_RE = re.compile(r"#\[prost\(([^)]*)\)\]\s*pub (\w+)\s*:")
ONEOF_VARIANT_RE = re.compile(r"#\[prost\(([^)]*)\)\]\s*(\w+)\s*\(")
DISCRIMINANT_RE = re.compile(r"^\s*(\w+) = (\d+),\s*$", re.MULTILINE)


def crate_source_dir() -> pathlib.Path:
    """Where cargo unpacked substreams-database-change for this build."""
    meta = json.loads(
        subprocess.run(
            ["cargo", "metadata", "--format-version", "1", "--locked"],
            cwd=PACKAGE,
            check=True,
            capture_output=True,
            text=True,
        ).stdout
    )
    for package in meta["packages"]:
        if package["name"] == CRATE:
            return pathlib.Path(package["manifest_path"]).parent
    raise SystemExit(f"{CRATE} is not in the dependency graph")


def generate_from_vendored(out_dir: pathlib.Path) -> pathlib.Path:
    subprocess.run(
        [
            "cargo",
            "run",
            "--quiet",
            "--manifest-path",
            str(PACKAGE / "protogen" / "Cargo.toml"),
            "--",
            "--proto-dir",
            str(VENDORED.parent),
            "--out-dir",
            str(out_dir),
        ],
        check=True,
        stdout=subprocess.DEVNULL,
    )
    return out_dir / GENERATED


def schema(path: pathlib.Path) -> set[str]:
    """The wire format, as a set of comparable facts."""
    source = re.sub(r"//.*", "", path.read_text())
    flat = re.sub(r"\s+", " ", source)

    facts = {f"type {kind} {name}" for kind, name in TYPE_RE.findall(flat)}
    for attr, field in FIELD_RE.findall(flat):
        facts.add(f"field {field} {normalise(attr)}")
    for attr, variant in ONEOF_VARIANT_RE.findall(flat):
        facts.add(f"variant {variant} {normalise(attr)}")
    for name, value in DISCRIMINANT_RE.findall(source):
        facts.add(f"discriminant {name} = {value}")
    return facts


def normalise(attr: str) -> str:
    """`string, tag = "2"` and `string, tag="2"` are the same schema."""
    return re.sub(r"\s*([,=])\s*", r"\1", attr.strip())


def main() -> int:
    crate_file = crate_source_dir() / "src" / "pb" / GENERATED
    if not crate_file.exists():
        raise SystemExit(f"expected upstream bindings at {crate_file}")

    with tempfile.TemporaryDirectory() as tmp:
        mine = schema(generate_from_vendored(pathlib.Path(tmp)))
    theirs = schema(crate_file)

    if mine == theirs:
        print(
            f"{VENDORED.relative_to(PACKAGE)} matches {CRATE}"
            f" ({len(mine)} schema facts)"
        )
        return 0

    print(f"{VENDORED.relative_to(PACKAGE)} has drifted from {CRATE}:", file=sys.stderr)
    for fact in sorted(mine - theirs):
        print(f"  vendored only: {fact}", file=sys.stderr)
    for fact in sorted(theirs - mine):
        print(f"  upstream only: {fact}", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
