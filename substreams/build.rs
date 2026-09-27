//! Generates typed ABI decoders from `abi/*.json`.
//!
//! This runs on every build because it is pure Rust — `substreams-ethereum`'s Abigen
//! parses the ABI and emits decoders with no external toolchain. The protobuf bindings
//! are the opposite case (they need protoc) and are committed instead; see
//! `protogen/src/main.rs`.
//!
//! Output goes to OUT_DIR rather than into `src/`, so a checkout is never modified by a
//! build and a stale generated file cannot drift from the ABI it came from.

use std::path::Path;

use anyhow::{Context, Result};
use substreams_ethereum::Abigen;

/// (module name, ABI file). The module name becomes `abi::<name>` in the crate.
const CONTRACTS: &[(&str, &str)] = &[
    ("vested_parimutuel", "abi/VestedParimutuel.json"),
    ("classic_parimutuel", "abi/ClassicParimutuel.json"),
    ("feed_resolver", "abi/FeedResolver.json"),
    ("market_factory", "abi/MarketFactory.json"),
];

fn main() -> Result<()> {
    let out_dir = std::env::var("OUT_DIR").context("OUT_DIR is set by cargo")?;
    let out_dir = Path::new(&out_dir);

    let mut modules = String::new();
    for (name, abi_path) in CONTRACTS {
        println!("cargo:rerun-if-changed={abi_path}");

        let target = out_dir.join(format!("{name}.rs"));
        Abigen::new(name, abi_path)
            .with_context(|| format!("reading {abi_path}"))?
            .generate()
            .with_context(|| format!("generating bindings for {abi_path}"))?
            .write_to_file(&target)
            .with_context(|| format!("writing {}", target.display()))?;

        modules.push_str(&format!(
            "pub mod {name} {{ include!(concat!(env!(\"OUT_DIR\"), \"/{name}.rs\")); }}\n"
        ));
    }

    std::fs::write(out_dir.join("abi_mod.rs"), modules).context("writing abi_mod.rs")?;
    println!("cargo:rerun-if-changed=build.rs");
    Ok(())
}
