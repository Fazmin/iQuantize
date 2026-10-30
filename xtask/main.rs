//! Release tool. From the project root:
//!
//!   cargo run release                bump the patch version (0.2.20 → 0.2.21), then build
//!   cargo run release minor|major    bump the minor (0.3.0) or major (1.0.0) version, then build
//!   cargo run release 0.2.21         set an exact version; the current version rebuilds as is
//!
//! Options: `--no-build` only changes the version; `--only mac|windows` builds one platform.
//!
//! The version changes together everywhere it appears: src-tauri/Cargo.toml and Cargo.lock,
//! tauri.conf.json, CITATION.cff and the citations in README.md. The builds land in
//! releases/v<version>/ with SHA-256 checksums: an Apple Silicon .dmg, signed with the first
//! Developer ID Application certificate in the keychain (or APPLE_SIGNING_IDENTITY), and a
//! Windows NSIS installer cross-compiled with cargo-xwin. Only the dependency-free standard
//! library is used, so this builds in a second and works offline.

use std::env;
use std::fmt;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{exit, Command};

const MAC_TARGET: &str = "aarch64-apple-darwin";
const WIN_TARGET: &str = "x86_64-pc-windows-msvc";

const USAGE: &str =
    "usage: cargo run release [patch|minor|major|X.Y.Z] [--no-build] [--only mac|windows]";

type Result<T> = std::result::Result<T, String>;

fn main() {
    let args: Vec<String> = env::args().skip(1).collect();
    let result = match args.first().map(String::as_str) {
        Some("release") => release(&args[1..]),
        _ => Err(USAGE.to_string()),
    };
    if let Err(e) = result {
        eprintln!("error: {e}");
        exit(1);
    }
}

#[derive(Clone, Copy, PartialEq)]
struct Version(u64, u64, u64);

impl Version {
    fn parse(s: &str) -> Option<Version> {
        let mut parts = s.split('.').map(|p| p.parse::<u64>().ok());
        let v = Version(parts.next()??, parts.next()??, parts.next()??);
        parts.next().is_none().then_some(v)
    }

    fn next(self, level: &str) -> Option<Version> {
        match level {
            "patch" => Some(Version(self.0, self.1, self.2 + 1)),
            "minor" => Some(Version(self.0, self.1 + 1, 0)),
            "major" => Some(Version(self.0 + 1, 0, 0)),
            exact => Version::parse(exact),
        }
    }
}

impl fmt::Display for Version {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        write!(f, "{}.{}.{}", self.0, self.1, self.2)
    }
}

struct Options {
    level: String,
    build: bool,
    mac: bool,
    windows: bool,
}

fn options(args: &[String]) -> Result<Options> {
    let mut o = Options {
        level: "patch".into(),
        build: true,
        mac: true,
        windows: true,
    };
    let mut level = None;
    let mut it = args.iter();
    while let Some(a) = it.next() {
        match a.as_str() {
            "--no-build" => o.build = false,
            "--only" => match it.next().map(String::as_str) {
                Some("mac") => o.windows = false,
                Some("windows") => o.mac = false,
                _ => return Err("--only takes mac or windows".into()),
            },
            s if s.starts_with('-') || level.is_some() => {
                return Err(format!("unexpected argument {s}\n{USAGE}"))
            }
            s => level = Some(s.to_string()),
        }
    }
    if let Some(l) = level {
        o.level = l;
    }
    Ok(o)
}

fn release(args: &[String]) -> Result<()> {
    let o = options(args)?;
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let current = current_version(&root)?;
    let next = current.next(&o.level).ok_or_else(|| {
        format!(
            "{:?} is not patch, minor, major or a version like 1.2.3\n{USAGE}",
            o.level
        )
    })?;

    // Check the toolchains before touching the version, so a missing tool doesn't use one up.
    let llvm = if o.build {
        preflight(o.mac, o.windows)?
    } else {
        None
    };

    if next == current {
        println!("Version stays at {current}.");
    } else {
        for (path, text) in version_edits(&root, current, next)? {
            fs::write(&path, text).map_err(|e| format!("writing {}: {e}", path.display()))?;
        }
        println!("Version {current} → {next}");
    }
    if !o.build {
        return Ok(());
    }

    let out = root.join("releases").join(format!("v{next}"));
    fs::create_dir_all(&out).map_err(|e| format!("creating {}: {e}", out.display()))?;
    let retry = format!("The version is now {next}. Fix the problem above, then run `cargo run release {next}` to build it again without bumping.");
    let mut files = vec![];
    if o.mac {
        build_mac(&root).map_err(|e| format!("{e}\n{retry}"))?;
        files.push(collect(
            &root,
            MAC_TARGET,
            "dmg",
            &format!("_{next}_"),
            ".dmg",
            &out,
        )?);
    }
    if o.windows {
        build_windows(&root, llvm.as_deref()).map_err(|e| format!("{e}\n{retry}"))?;
        files.push(collect(
            &root,
            WIN_TARGET,
            "nsis",
            &format!("_{next}_"),
            "-setup.exe",
            &out,
        )?);
    }
    checksums(&out, &files)?;

    println!("\nReleased {next} to {}:", out.display());
    let sums = "SHA256SUMS.txt".to_string();
    for f in files.iter().chain([&sums]) {
        let size = fs::metadata(out.join(f)).map(|m| m.len()).unwrap_or(0);
        println!("  {f}  ({:.1} MB)", size as f64 / 1e6);
    }
    Ok(())
}

fn read(path: &Path) -> Result<String> {
    fs::read_to_string(path).map_err(|e| format!("reading {}: {e}", path.display()))
}

fn current_version(root: &Path) -> Result<Version> {
    let toml = read(&root.join("src-tauri/Cargo.toml"))?;
    toml.lines()
        .find_map(|l| l.strip_prefix("version = \"")?.strip_suffix('"'))
        .and_then(Version::parse)
        .ok_or_else(|| "no package version in src-tauri/Cargo.toml".into())
}

/// The new text of every file that carries the version. Nothing is written unless every file
/// has the current version exactly where expected, so they can't drift apart.
fn version_edits(root: &Path, old: Version, new: Version) -> Result<Vec<(PathBuf, String)>> {
    let date = String::from_utf8_lossy(&run_output("date", &["+%F"])?)
        .trim()
        .to_string();
    let replacements: [(&str, Vec<(String, String)>); 5] = [
        (
            "src-tauri/Cargo.toml",
            vec![(
                format!("\nversion = \"{old}\"\n"),
                format!("\nversion = \"{new}\"\n"),
            )],
        ),
        (
            "src-tauri/Cargo.lock",
            vec![(
                format!("name = \"iquantize\"\nversion = \"{old}\"\n"),
                format!("name = \"iquantize\"\nversion = \"{new}\"\n"),
            )],
        ),
        (
            "src-tauri/tauri.conf.json",
            vec![(
                format!("\"version\": \"{old}\""),
                format!("\"version\": \"{new}\""),
            )],
        ),
        (
            "CITATION.cff",
            vec![(format!("\nversion: {old}\n"), format!("\nversion: {new}\n"))],
        ),
        (
            "README.md",
            vec![
                (
                    format!("version = {{{old}}}"),
                    format!("version = {{{new}}}"),
                ),
                (format!("(Version {old})"), format!("(Version {new})")),
            ],
        ),
    ];
    let mut edits = vec![];
    for (file, pairs) in replacements {
        let path = root.join(file);
        let mut text = read(&path)?;
        for (from, to) in pairs {
            if text.matches(&from).count() != 1 {
                return Err(format!("{file} should contain {:?} exactly once; is its version out of sync with src-tauri/Cargo.toml?", from.trim()));
            }
            text = text.replacen(&from, &to, 1);
        }
        if file == "CITATION.cff" {
            text = replace_line(&text, "date-released: ", &format!("date-released: {date}"))
                .ok_or("CITATION.cff has no date-released line")?;
        }
        edits.push((path, text));
    }
    Ok(edits)
}

fn replace_line(text: &str, prefix: &str, line: &str) -> Option<String> {
    let start = text.find(&format!("\n{prefix}"))? + 1;
    let end = text[start..].find('\n').map_or(text.len(), |i| start + i);
    Some(format!("{}{line}{}", &text[..start], &text[end..]))
}

/// Checks every tool the chosen builds need; returns the LLVM bin directory for Windows.
fn preflight(mac: bool, windows: bool) -> Result<Option<PathBuf>> {
    let mut missing = vec![];
    if !succeeds("cargo", &["tauri", "--version"]) {
        missing.push("the Tauri CLI: cargo install tauri-cli --version ^2".to_string());
    }
    let targets =
        String::from_utf8_lossy(&run_output("rustup", &["target", "list", "--installed"])?)
            .to_string();
    let mut llvm = None;
    if mac && !targets.lines().any(|t| t == MAC_TARGET) {
        missing.push(format!(
            "the {MAC_TARGET} target: rustup target add {MAC_TARGET}"
        ));
    }
    if windows {
        if !targets.lines().any(|t| t == WIN_TARGET) {
            missing.push(format!(
                "the {WIN_TARGET} target: rustup target add {WIN_TARGET}"
            ));
        }
        if !succeeds("cargo", &["xwin", "--version"]) {
            missing.push("cargo-xwin: cargo install --locked cargo-xwin".into());
        }
        if which("makensis").is_none() {
            missing.push("NSIS: brew install nsis".into());
        }
        // Homebrew's LLVM is keg-only, so its llvm-rc and clang-cl aren't on PATH by default.
        llvm = run_output("brew", &["--prefix", "llvm"])
            .ok()
            .map(|p| PathBuf::from(String::from_utf8_lossy(&p).trim()).join("bin"));
        if !llvm.as_ref().is_some_and(|d| d.join("llvm-rc").exists()) && which("llvm-rc").is_none()
        {
            missing.push("LLVM (for llvm-rc and lld-link): brew install llvm lld".into());
        }
    }
    if missing.is_empty() {
        Ok(llvm)
    } else {
        Err(format!(
            "missing build tools:\n  - {}",
            missing.join("\n  - ")
        ))
    }
}

fn build_mac(root: &Path) -> Result<()> {
    println!("\n== macOS ({MAC_TARGET}) ==");
    let mut cmd = tauri(
        root,
        &["build", "--target", MAC_TARGET, "--bundles", "app,dmg"],
    );
    match env::var("APPLE_SIGNING_IDENTITY") {
        Ok(id) => println!("Signing with {id}"),
        Err(_) => match developer_id() {
            Some(id) => {
                println!("Signing with {id}");
                cmd.env("APPLE_SIGNING_IDENTITY", id);
            }
            None => println!("No Developer ID Application certificate in the keychain: the app will be unsigned."),
        },
    }
    if env::var("APPLE_ID").is_err() && env::var("APPLE_API_KEY").is_err() {
        println!("Not notarizing: set APPLE_ID, APPLE_PASSWORD and APPLE_TEAM_ID (or APPLE_API_KEY, APPLE_API_ISSUER and APPLE_API_KEY_PATH) to notarize.");
    }
    status(cmd, "the macOS build")
}

fn build_windows(root: &Path, llvm: Option<&Path>) -> Result<()> {
    println!("\n== Windows ({WIN_TARGET}, cross-compiled with cargo-xwin) ==");
    // On a Mac the CLI only accepts Mac values for --bundles, so NSIS is picked through the config.
    let mut cmd = tauri(
        root,
        &[
            "build",
            "--runner",
            "cargo-xwin",
            "--target",
            WIN_TARGET,
            "--config",
            r#"{"bundle":{"targets":["nsis"]}}"#,
        ],
    );
    if let Some(dir) = llvm.filter(|d| d.exists()) {
        let path = env::var_os("PATH").unwrap_or_default();
        let joined = env::join_paths(
            [dir.to_path_buf()]
                .into_iter()
                .chain(env::split_paths(&path)),
        )
        .map_err(|e| e.to_string())?;
        cmd.env("PATH", joined);
    }
    status(cmd, "the Windows build")
}

fn tauri(root: &Path, args: &[&str]) -> Command {
    let mut cmd = Command::new("cargo");
    cmd.arg("tauri")
        .args(args)
        .current_dir(root.join("src-tauri"));
    cmd
}

fn developer_id() -> Option<String> {
    let out = run_output("security", &["find-identity", "-v", "-p", "codesigning"]).ok()?;
    String::from_utf8_lossy(&out).lines().find_map(|l| {
        let name = l.split('"').nth(1)?;
        name.starts_with("Developer ID Application:")
            .then(|| name.to_string())
    })
}

/// Copies the bundle for `target` whose name contains `marker` and ends with `suffix` into `out`.
fn collect(
    root: &Path,
    target: &str,
    kind: &str,
    marker: &str,
    suffix: &str,
    out: &Path,
) -> Result<String> {
    let dir = root
        .join("src-tauri/target")
        .join(target)
        .join("release/bundle")
        .join(kind);
    let name = fs::read_dir(&dir)
        .map_err(|e| format!("reading {}: {e}", dir.display()))?
        .filter_map(|e| e.ok()?.file_name().into_string().ok())
        .find(|n| n.contains(marker) && n.ends_with(suffix))
        .ok_or_else(|| format!("no *{marker}*{suffix} in {}", dir.display()))?;
    fs::copy(dir.join(&name), out.join(&name)).map_err(|e| format!("copying {name}: {e}"))?;
    Ok(name)
}

fn checksums(out: &Path, files: &[String]) -> Result<()> {
    let output = Command::new("shasum")
        .args(["-a", "256"])
        .args(files)
        .current_dir(out)
        .output()
        .map_err(|e| format!("running shasum: {e}"))?;
    if !output.status.success() {
        return Err("shasum failed".into());
    }
    fs::write(out.join("SHA256SUMS.txt"), output.stdout)
        .map_err(|e| format!("writing SHA256SUMS.txt: {e}"))
}

fn status(mut cmd: Command, what: &str) -> Result<()> {
    match cmd.status() {
        Ok(s) if s.success() => Ok(()),
        Ok(s) => Err(format!("{what} failed ({s})")),
        Err(e) => Err(format!("{what} could not start: {e}")),
    }
}

fn run_output(program: &str, args: &[&str]) -> Result<Vec<u8>> {
    let out = Command::new(program)
        .args(args)
        .output()
        .map_err(|e| format!("running {program}: {e}"))?;
    if out.status.success() {
        Ok(out.stdout)
    } else {
        Err(format!("{program} {} failed", args.join(" ")))
    }
}

fn succeeds(program: &str, args: &[&str]) -> bool {
    Command::new(program)
        .args(args)
        .output()
        .is_ok_and(|o| o.status.success())
}

fn which(name: &str) -> Option<PathBuf> {
    env::split_paths(&env::var_os("PATH")?)
        .map(|d| d.join(name))
        .find(|p| p.is_file())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bumps_versions() {
        let v = Version(0, 2, 20);
        assert_eq!(v.next("patch").unwrap().to_string(), "0.2.21");
        assert_eq!(v.next("minor").unwrap().to_string(), "0.3.0");
        assert_eq!(v.next("major").unwrap().to_string(), "1.0.0");
        assert_eq!(v.next("1.4.2").unwrap().to_string(), "1.4.2");
        assert!(v.next("1.4").is_none() && v.next("1.4.2.1").is_none() && v.next("beta").is_none());
    }

    #[test]
    fn replaces_one_line() {
        let text = "version: 1\ndate-released: 2026-01-01\nlicense: MIT\n";
        assert_eq!(
            replace_line(text, "date-released: ", "date-released: 2026-10-29").unwrap(),
            "version: 1\ndate-released: 2026-10-29\nlicense: MIT\n"
        );
    }
}
