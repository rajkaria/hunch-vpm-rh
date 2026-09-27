//! Regenerates `src/pb/` from `proto/`.
//!
//! The generated bindings are committed. Substreams modules are compiled to wasm by
//! whoever runs `cargo build`, including CI and the hosted build, and requiring a system
//! `protoc` or the `substreams` CLI on every one of those machines buys nothing: the
//! schema changes when a human edits the `.proto`, not on every build. Running codegen
//! from `build.rs` would also make the wasm build depend on a host toolchain that the
//! wasm target has no use for.
//!
//! Run with `make protogen` after editing `proto/hunch_vpm.proto`, and commit the diff.
//!
//! Usage:
//!   hunch-vpm-protogen                                  package protos -> src/pb
//!   hunch-vpm-protogen --proto-dir DIR --out-dir DIR    anywhere else (used by
//!                                                       tools/verify-vendored-proto.py)

use std::path::{Path, PathBuf};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("protogen lives one level under the substreams package")
        .to_path_buf();

    let args = Args::parse(std::env::args().skip(1))?;
    let proto_dir = args.proto_dir.unwrap_or_else(|| root.join("proto"));
    let out_dir = args.out_dir.unwrap_or_else(|| root.join("src").join("pb"));
    std::fs::create_dir_all(&out_dir)?;

    // prost-build shells out to protoc; point it at the vendored binary so no system
    // install is required.
    std::env::set_var("PROTOC", protoc_bin_vendored::protoc_bin_path()?);

    let inputs = collect_protos(&proto_dir)?;
    if inputs.is_empty() {
        return Err(format!("no .proto files under {}", proto_dir.display()).into());
    }

    let mut config = prost_build::Config::new();
    config.out_dir(&out_dir);
    config.compile_protos(&inputs, &[proto_dir.as_path()])?;

    for input in &inputs {
        println!("generated from {}", input.display());
    }
    println!("wrote {}", out_dir.display());
    Ok(())
}

#[derive(Default)]
struct Args {
    proto_dir: Option<PathBuf>,
    out_dir: Option<PathBuf>,
}

impl Args {
    fn parse(args: impl Iterator<Item = String>) -> Result<Self, String> {
        let mut out = Args::default();
        let mut args = args.peekable();
        while let Some(flag) = args.next() {
            let value = args
                .next()
                .ok_or_else(|| format!("{flag} needs a directory"))?;
            match flag.as_str() {
                "--proto-dir" => out.proto_dir = Some(PathBuf::from(value)),
                "--out-dir" => out.out_dir = Some(PathBuf::from(value)),
                other => return Err(format!("unknown flag {other}")),
            }
        }
        Ok(out)
    }
}

/// Non-recursive on purpose: `proto/sink/` holds a vendored upstream schema that this
/// crate must not compile into its own bindings.
fn collect_protos(dir: &Path) -> std::io::Result<Vec<PathBuf>> {
    let mut out = Vec::new();
    for entry in std::fs::read_dir(dir)? {
        let path = entry?.path();
        if path.extension().and_then(|e| e.to_str()) == Some("proto") {
            out.push(path);
        }
    }
    out.sort();
    Ok(out)
}
