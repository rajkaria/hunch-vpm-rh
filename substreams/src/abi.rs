//! Typed event decoders generated from `abi/*.json` by `build.rs` into OUT_DIR.
//!
//! `VestedParimutuel` and `ClassicParimutuel` share most of their event set by design —
//! same interface, different settlement rule — so the two generated modules contain
//! near-identical types. They are kept separate rather than deduplicated because
//! `Entered` genuinely differs: the vested settler's carries a vintage and the classic
//! one does not, which gives the two events different topic0 and lets one package index
//! both settlers side by side.
#![allow(dead_code)]
#![allow(clippy::all)]

include!(concat!(env!("OUT_DIR"), "/abi_mod.rs"));
