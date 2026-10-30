//! Besides the Tauri build step, embeds every file in `drivers/` (Python drivers) and
//! `resources/suites/` (prompt suites) so the app ships as a single binary.

use std::fmt::Write as _;
use std::path::Path;

fn embed(dir: &str, ext: &str, const_name: &str, out: &mut String) {
    println!("cargo:rerun-if-changed={dir}");
    let manifest = std::env::var("CARGO_MANIFEST_DIR").unwrap();
    let full = Path::new(&manifest).join(dir);
    let mut files: Vec<_> = std::fs::read_dir(&full)
        .map(|rd| {
            rd.flatten()
                .map(|e| e.path())
                .filter(|p| p.extension().map(|e| e == ext).unwrap_or(false))
                .collect()
        })
        .unwrap_or_default();
    files.sort();
    writeln!(out, "pub const {const_name}: &[(&str, &str)] = &[").unwrap();
    for f in files {
        println!("cargo:rerun-if-changed={}", f.display());
        let name = f.file_name().unwrap().to_string_lossy().to_string();
        writeln!(
            out,
            "    ({name:?}, include_str!({:?})),",
            f.display().to_string()
        )
        .unwrap();
    }
    writeln!(out, "];").unwrap();
}

fn main() {
    let mut out = String::new();
    embed("drivers", "py", "DRIVERS", &mut out);
    embed("resources/suites", "json", "SUITES", &mut out);
    let dest = Path::new(&std::env::var("OUT_DIR").unwrap()).join("embedded.rs");
    std::fs::write(dest, out).unwrap();
    tauri_build::build()
}
