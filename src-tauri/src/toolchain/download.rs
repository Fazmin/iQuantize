//! Verified downloads of release assets and archive extraction.

use crate::error::{http_status_error, AppError, AppResult};
use crate::jobs::JobCtx;
use futures_util::StreamExt;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::io::Write;
use std::path::{Component, Path, PathBuf};

#[derive(Debug, Clone, Deserialize)]
pub struct GhAsset {
    pub name: String,
    pub browser_download_url: String,
    #[serde(default)]
    pub digest: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct GhRelease {
    pub assets: Vec<GhAsset>,
}

pub async fn github_release(http: &reqwest::Client, repo: &str, tag: &str) -> AppResult<GhRelease> {
    let url = format!("https://api.github.com/repos/{repo}/releases/tags/{tag}");
    let resp = http
        .get(&url)
        .header("Accept", "application/vnd.github+json")
        .send()
        .await?;
    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(http_status_error("GitHub", status, &body));
    }
    Ok(resp.json().await?)
}

/// Streams a URL to `dest`, reporting progress to the job and verifying the sha256 when known.
pub async fn download(
    http: &reqwest::Client,
    ctx: &JobCtx,
    url: &str,
    dest: &Path,
    expected_sha256: Option<&str>,
    label: &str,
) -> AppResult<String> {
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let resp = http.get(url).send().await?;
    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(http_status_error("Download server", status, &body));
    }
    let total = resp.content_length();
    let part = dest.with_extension("part");
    let mut file = std::fs::File::create(&part)?;
    let mut hasher = Sha256::new();
    let mut got: u64 = 0;
    let mut stream = resp.bytes_stream();
    let started = std::time::Instant::now();
    let mut last = std::time::Instant::now();
    while let Some(chunk) = stream.next().await {
        ctx.check_cancel()?;
        let chunk = chunk?;
        file.write_all(&chunk)?;
        hasher.update(&chunk);
        got += chunk.len() as u64;
        if last.elapsed().as_millis() > 150 {
            last = std::time::Instant::now();
            let rate = got as f64 / started.elapsed().as_secs_f64().max(0.001);
            let detail = match total {
                Some(t) => format!(
                    "{label}: {} / {} · {}/s",
                    human(got),
                    human(t),
                    human(rate as u64)
                ),
                None => format!("{label}: {} · {}/s", human(got), human(rate as u64)),
            };
            ctx.stage_progress(
                total.map(|t| got as f64 / t as f64).unwrap_or(0.0),
                Some(detail),
            );
        }
    }
    file.flush()?;
    drop(file);
    let digest = hex::encode(hasher.finalize());
    if let Some(exp) = expected_sha256 {
        let exp = exp.trim_start_matches("sha256:").to_lowercase();
        if exp != digest {
            let _ = std::fs::remove_file(&part);
            return Err(
                AppError::new("checksum", format!("Checksum mismatch for {label}"))
                    .with_hint("The download was corrupted or tampered with. Try again."),
            );
        }
        ctx.log(format!("✓ sha256 verified for {label}"));
    } else {
        ctx.log(format!(
            "sha256 of {label}: {digest} (no published checksum to compare)"
        ));
    }
    std::fs::rename(&part, dest)?;
    Ok(digest)
}

pub fn human(n: u64) -> String {
    let units = ["B", "KB", "MB", "GB", "TB"];
    let mut v = n as f64;
    let mut i = 0;
    while v >= 1000.0 && i < units.len() - 1 {
        v /= 1000.0;
        i += 1;
    }
    if i == 0 {
        format!("{n} B")
    } else {
        format!("{v:.1} {}", units[i])
    }
}

/// Extracts .tar.gz / .tgz / .zip into `dest`. If every entry shares one top-level folder,
/// it is stripped. `keep` filters on the (stripped) relative path.
pub fn extract(archive: &Path, dest: &Path, keep: &dyn Fn(&Path) -> bool) -> AppResult<usize> {
    std::fs::create_dir_all(dest)?;
    let name = archive
        .file_name()
        .map(|n| n.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    if name.ends_with(".zip") {
        extract_zip(archive, dest, keep)
    } else {
        extract_tgz(archive, dest, keep)
    }
}

fn common_top(paths: &[PathBuf]) -> Option<PathBuf> {
    let first = paths.iter().find_map(|p| p.components().next())?;
    let Component::Normal(top) = first else {
        return None;
    };
    let all = paths.iter().all(|p| {
        p.components().next() == Some(Component::Normal(top)) && p.components().count() >= 1
    });
    let has_nested = paths.iter().any(|p| p.components().count() > 1);
    if all && has_nested {
        Some(PathBuf::from(top))
    } else {
        None
    }
}

fn safe_join(dest: &Path, rel: &Path) -> Option<PathBuf> {
    if rel.components().any(|c| {
        matches!(
            c,
            Component::ParentDir | Component::RootDir | Component::Prefix(_)
        )
    }) {
        return None;
    }
    Some(dest.join(rel))
}

fn extract_tgz(archive: &Path, dest: &Path, keep: &dyn Fn(&Path) -> bool) -> AppResult<usize> {
    // First pass: list entries to detect a common top folder.
    let names: Vec<PathBuf> = {
        let f = std::fs::File::open(archive)?;
        let mut ar = tar::Archive::new(flate2::read::GzDecoder::new(f));
        ar.entries()?
            .filter_map(|e| e.ok())
            .filter(|e| !is_meta(e.header().entry_type()))
            .filter_map(|e| e.path().ok().map(|p| p.into_owned()))
            .collect()
    };
    let top = common_top(&names);
    let f = std::fs::File::open(archive)?;
    let mut ar = tar::Archive::new(flate2::read::GzDecoder::new(f));
    ar.set_preserve_permissions(true);
    let mut count = 0;
    for entry in ar.entries()? {
        let mut entry = entry?;
        if is_meta(entry.header().entry_type()) {
            continue;
        }
        let path = entry.path()?.into_owned();
        let rel = match &top {
            Some(t) => match path.strip_prefix(t) {
                Ok(r) => r.to_path_buf(),
                Err(_) => continue,
            },
            None => path,
        };
        if rel.as_os_str().is_empty() || !keep(&rel) {
            continue;
        }
        let Some(out) = safe_join(dest, &rel) else {
            continue;
        };
        if let Some(parent) = out.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let kind = entry.header().entry_type();
        if kind.is_symlink() {
            #[cfg(unix)]
            if let Ok(Some(target)) = entry.link_name() {
                let _ = std::fs::remove_file(&out);
                std::os::unix::fs::symlink(target.as_ref(), &out)?;
                count += 1;
            }
            continue;
        }
        if kind.is_dir() {
            std::fs::create_dir_all(&out)?;
            continue;
        }
        entry.unpack(&out)?;
        count += 1;
    }
    Ok(count)
}

/// PAX/GNU metadata entries (e.g. GitHub's `pax_global_header`) are not real files.
fn is_meta(t: tar::EntryType) -> bool {
    matches!(
        t,
        tar::EntryType::XGlobalHeader
            | tar::EntryType::XHeader
            | tar::EntryType::GNULongName
            | tar::EntryType::GNULongLink
    )
}

fn extract_zip(archive: &Path, dest: &Path, keep: &dyn Fn(&Path) -> bool) -> AppResult<usize> {
    let f = std::fs::File::open(archive)?;
    let mut zip = zip::ZipArchive::new(f).map_err(|e| AppError::new("archive", e.to_string()))?;
    let names: Vec<PathBuf> = (0..zip.len())
        .filter_map(|i| zip.by_index(i).ok().and_then(|e| e.enclosed_name()))
        .collect();
    let top = common_top(&names);
    let mut count = 0;
    for i in 0..zip.len() {
        let mut entry = zip
            .by_index(i)
            .map_err(|e| AppError::new("archive", e.to_string()))?;
        let Some(path) = entry.enclosed_name() else {
            continue;
        };
        let rel = match &top {
            Some(t) => match path.strip_prefix(t) {
                Ok(r) => r.to_path_buf(),
                Err(_) => continue,
            },
            None => path,
        };
        if rel.as_os_str().is_empty() || !keep(&rel) {
            continue;
        }
        let out = dest.join(&rel);
        if entry.is_dir() {
            std::fs::create_dir_all(&out)?;
            continue;
        }
        if let Some(parent) = out.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let mut w = std::fs::File::create(&out)?;
        std::io::copy(&mut entry, &mut w)?;
        #[cfg(unix)]
        if let Some(mode) = entry.unix_mode() {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&out, std::fs::Permissions::from_mode(mode));
        }
        count += 1;
    }
    Ok(count)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_common_top_folder() {
        let p = |s: &str| PathBuf::from(s);
        assert_eq!(
            common_top(&[
                p("llama-b1/"),
                p("llama-b1/llama-quantize"),
                p("llama-b1/lib.dylib")
            ]),
            Some(p("llama-b1"))
        );
        assert_eq!(common_top(&[p("llama-quantize.exe"), p("ggml.dll")]), None);
        assert!(safe_join(Path::new("/tmp/x"), Path::new("../etc/passwd")).is_none());
    }

    #[test]
    fn extracts_tgz_stripping_top() {
        let dir = std::env::temp_dir().join(format!("iq-tgz-{}", crate::db::new_id()));
        std::fs::create_dir_all(&dir).unwrap();
        let archive = dir.join("a.tar.gz");
        {
            let f = std::fs::File::create(&archive).unwrap();
            let gz = flate2::write::GzEncoder::new(f, flate2::Compression::fast());
            let mut b = tar::Builder::new(gz);
            let mut pax = tar::Header::new_ustar();
            pax.set_entry_type(tar::EntryType::XGlobalHeader);
            pax.set_size(0);
            pax.set_cksum();
            b.append_data(&mut pax, "pax_global_header", &[][..])
                .unwrap();
            for (name, body) in [("top/bin/tool", "x"), ("top/README", "y")] {
                let mut h = tar::Header::new_gnu();
                h.set_size(body.len() as u64);
                h.set_mode(0o755);
                h.set_cksum();
                b.append_data(&mut h, name, body.as_bytes()).unwrap();
            }
            b.into_inner().unwrap().finish().unwrap();
        }
        let out = dir.join("out");
        let n = extract(&archive, &out, &|p| p.starts_with("bin")).unwrap();
        assert_eq!(n, 1);
        assert!(out.join("bin/tool").exists());
        assert!(!out.join("README").exists());
        let _ = std::fs::remove_dir_all(dir);
    }
}
