//! Model library: Hugging Face downloads (native, resumable, verified), local imports,
//! inspection and per-format compatibility.

pub mod config;
pub mod tensors;

use crate::db::{json_col, new_id, now_ms};
use crate::error::{AppError, AppResult};
use crate::jobs::{JobCtx, Lane, NewJob, StageDef};
use crate::state::AppState;
use futures_util::StreamExt;
use rusqlite::OptionalExtension;
use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

#[derive(Debug, Clone, Serialize)]
pub struct ModelRow {
    pub id: String,
    pub source: String,
    pub repo_id: Option<String>,
    pub revision: Option<String>,
    pub local_path: String,
    pub name: String,
    pub architecture: Option<String>,
    pub model_type: Option<String>,
    pub params: Option<i64>,
    pub dtype: Option<String>,
    pub context_length: Option<i64>,
    pub license: Option<String>,
    pub size_bytes: Option<i64>,
    pub config: Value,
    pub info: Value,
    pub status: String,
    pub created_at: i64,
    pub artifacts: i64,
}

const SELECT: &str = "SELECT m.id, m.source, m.repo_id, m.revision, m.local_path, m.name, m.architecture, m.model_type, m.params, m.dtype,
    m.context_length, m.license, m.size_bytes, m.config_json, m.info_json, m.status, m.created_at,
    (SELECT COUNT(*) FROM artifacts a WHERE a.model_id = m.id AND a.role = 'quantized') FROM models m";

fn row(r: &rusqlite::Row) -> rusqlite::Result<ModelRow> {
    Ok(ModelRow {
        id: r.get(0)?,
        source: r.get(1)?,
        repo_id: r.get(2)?,
        revision: r.get(3)?,
        local_path: r.get(4)?,
        name: r.get(5)?,
        architecture: r.get(6)?,
        model_type: r.get(7)?,
        params: r.get(8)?,
        dtype: r.get(9)?,
        context_length: r.get(10)?,
        license: r.get(11)?,
        size_bytes: r.get(12)?,
        config: json_col(r.get(13)?),
        info: json_col(r.get(14)?),
        status: r.get(15)?,
        created_at: r.get(16)?,
        artifacts: r.get(17)?,
    })
}

pub fn list(st: &AppState) -> AppResult<Vec<ModelRow>> {
    st.db.with(|c| {
        let mut s = c.prepare(&format!("{SELECT} ORDER BY m.created_at DESC"))?;
        let rows = s.query_map([], row)?;
        rows.collect()
    })
}

pub fn get(st: &AppState, id: &str) -> AppResult<ModelRow> {
    st.db
        .with(|c| {
            c.query_row(&format!("{SELECT} WHERE m.id = ?1"), [id], row)
                .optional()
        })?
        .ok_or_else(|| AppError::not_found("Model"))
}

/// Model row plus compatibility, for the UI.
pub fn detail(st: &AppState, id: &str) -> AppResult<Value> {
    let m = get(st, id)?;
    let has_st = Path::new(&m.local_path)
        .read_dir()
        .map(|rd| {
            rd.flatten().any(|e| {
                e.path()
                    .extension()
                    .map(|x| x == "safetensors")
                    .unwrap_or(false)
            })
        })
        .unwrap_or(false);
    let compat = compat(
        st,
        m.architecture.as_deref(),
        m.model_type.as_deref(),
        has_st,
        m.info["arch"]["quantization"].as_str(),
    );
    let mut v = serde_json::to_value(&m)?;
    v["compat"] = compat;
    v["exists"] = json!(Path::new(&m.local_path).exists());
    Ok(v)
}

/// Which repo files to fetch for quantization (weights, configs, tokenizer, chat template).
pub fn select_files(files: &[Value]) -> Vec<Value> {
    let names: Vec<&str> = files.iter().filter_map(|f| f["path"].as_str()).collect();
    let has_st = names.iter().any(|n| n.ends_with(".safetensors"));
    files
        .iter()
        .filter(|f| {
            let p = f["path"].as_str().unwrap_or("");
            if p.contains('/') && !p.starts_with("tokenizer") {
                // Skip sub-folders such as original/, onnx/, gguf/ exports.
                return false;
            }
            let lower = p.to_lowercase();
            if lower.ends_with(".safetensors") || lower == "model.safetensors.index.json" {
                return true;
            }
            if !has_st
                && (lower.starts_with("pytorch_model")
                    && (lower.ends_with(".bin") || lower.ends_with(".bin.index.json")))
            {
                return true;
            }
            lower.ends_with(".json") && !lower.contains("onnx")
                || lower.ends_with(".jinja")
                || lower == "tokenizer.model"
                || lower.ends_with(".tiktoken")
                || lower == "merges.txt"
                || lower == "vocab.txt"
                || lower.starts_with("readme")
                || lower.starts_with("license")
                || lower.ends_with(".py")
        })
        .cloned()
        .collect()
}

fn caps_list(st: &AppState, component: &str, path: &[&str]) -> Option<Vec<String>> {
    let mut v = crate::toolchain::capability(st, component, "caps")?;
    for p in path {
        v = v.get(*p)?.clone();
    }
    Some(
        v.as_array()?
            .iter()
            .filter_map(|x| x.as_str().map(str::to_string))
            .collect(),
    )
}

/// Per-format support verdicts: yes | no | warn | unknown, with a plain-English reason.
pub fn compat(
    st: &AppState,
    arch: Option<&str>,
    model_type: Option<&str>,
    has_safetensors: bool,
    quantization: Option<&str>,
) -> Value {
    let verdict = |status: &str, reason: String| json!({ "status": status, "reason": reason });
    let arch_s = arch.unwrap_or("unknown architecture");
    let mut gguf = match caps_list(st, "env_gguf", &["convert_archs"]) {
        Some(list) if arch.map(|a| list.iter().any(|x| x == a)).unwrap_or(false) => {
            verdict("yes", format!("llama.cpp's converter supports {arch_s}."))
        }
        Some(_) => verdict(
            "no",
            format!("llama.cpp's converter in this build does not list {arch_s}."),
        ),
        None => verdict(
            "unknown",
            "Install the GGUF converter to check support.".into(),
        ),
    };
    let p = st.platform();
    let mlx = if !p.mlx_supported {
        verdict("no", "MLX only runs on Apple Silicon Macs.".into())
    } else {
        match caps_list(st, "env_mlx", &["model_types"]) {
            Some(list)
                if model_type
                    .map(|m| list.iter().any(|x| x == m))
                    .unwrap_or(false) =>
            {
                verdict(
                    "yes",
                    format!(
                        "mlx-lm has a native implementation of \"{}\".",
                        model_type.unwrap_or("")
                    ),
                )
            }
            Some(_) => verdict(
                "no",
                format!(
                    "mlx-lm has no implementation for \"{}\".",
                    model_type.unwrap_or("this model type")
                ),
            ),
            None => verdict("unknown", "Install MLX to check support.".into()),
        }
    };
    let onnx = match caps_list(st, "env_onnx", &["architectures"]) {
        Some(list) if arch.map(|a| list.iter().any(|x| x == a)).unwrap_or(false) => verdict("yes", format!("The ONNX Runtime GenAI model builder supports {arch_s}.")),
        Some(_) => verdict("warn", format!("The GenAI builder does not support {arch_s}; the generic exporter may still work, but inference tests need the builder.")),
        None => verdict("unknown", "Install ONNX Runtime GenAI to check support.".into()),
    };
    if let Some(q) = quantization {
        gguf = verdict("warn", format!("This checkpoint is already quantized ({q}). Start from the original full-precision model for best results."));
    }
    if !has_safetensors {
        gguf = verdict(
            if gguf["status"] == "yes" {
                "warn"
            } else {
                gguf["status"].as_str().unwrap_or("unknown")
            },
            "No .safetensors weights found; conversion needs the original weights.".into(),
        );
    }
    json!({ "gguf": gguf, "mlx": mlx, "onnx": onnx })
}

/// Reads config + safetensors headers of a local model folder.
pub fn inspect_dir(dir: &Path) -> AppResult<(Value, config::ArchInfo, Value)> {
    let cfg_path = dir.join("config.json");
    let cfg: Value = if cfg_path.exists() {
        serde_json::from_str(&std::fs::read_to_string(&cfg_path)?)?
    } else {
        return Err(AppError::invalid(
            "This folder has no config.json, so it is not a Hugging Face model folder",
        )
        .with_hint("Pick the folder that contains config.json and the .safetensors files."));
    };
    let arch = config::analyze(&cfg);
    let tensors = tensors::read_safetensors_dir(dir).unwrap_or_default();
    let summary = tensors::summarize(&tensors);
    Ok((cfg, arch, summary))
}

fn dominant_dtype(summary: &Value) -> Option<String> {
    summary["by_dtype"]
        .as_array()?
        .iter()
        .max_by_key(|d| d["params"].as_u64().unwrap_or(0))
        .and_then(|d| d["dtype"].as_str().map(str::to_string))
}

#[allow(clippy::too_many_arguments)]
fn upsert_ready(
    st: &AppState,
    id: &str,
    dir: &Path,
    name: &str,
    source: &str,
    repo: Option<&str>,
    revision: Option<&str>,
    license: Option<&str>,
    extra: Value,
) -> AppResult<()> {
    let (cfg, arch, summary) = inspect_dir(dir)?;
    let params = summary["params"]
        .as_u64()
        .filter(|p| *p > 0)
        .or_else(|| config::estimate_params(&arch));
    let size = crate::paths::dir_size(dir) as i64;
    let mut info = json!({ "arch": arch, "summary": summary });
    if let Value::Object(e) = extra {
        for (k, v) in e {
            info[k] = v;
        }
    }
    st.db.with(|c| {
        c.execute(
            "INSERT INTO models (id, source, repo_id, revision, local_path, name, architecture, model_type, params, dtype, context_length, license, size_bytes, config_json, info_json, status, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, 'ready', ?16)
             ON CONFLICT(id) DO UPDATE SET revision = excluded.revision, local_path = excluded.local_path, architecture = excluded.architecture,
               model_type = excluded.model_type, params = excluded.params, dtype = excluded.dtype, context_length = excluded.context_length,
               license = COALESCE(excluded.license, models.license), size_bytes = excluded.size_bytes, config_json = excluded.config_json,
               info_json = excluded.info_json, status = 'ready'",
            rusqlite::params![
                id,
                source,
                repo,
                revision,
                dir.to_string_lossy(),
                name,
                arch.architecture,
                arch.model_type,
                params.map(|p| p as i64),
                dominant_dtype(&summary).or(arch.torch_dtype.clone()),
                arch.context_length.map(|c| c as i64),
                license,
                size,
                cfg.to_string(),
                info.to_string(),
                now_ms()
            ],
        )
    })?;
    Ok(())
}

pub fn import_local(st: &AppState, path: &str) -> AppResult<Value> {
    let dir = PathBuf::from(path);
    if !dir.is_dir() {
        return Err(AppError::invalid("Choose a folder"));
    }
    let existing: Option<String> = st.db.with(|c| {
        c.query_row("SELECT id FROM models WHERE local_path = ?1", [path], |r| {
            r.get(0)
        })
        .optional()
    })?;
    let id = existing.unwrap_or_else(new_id);
    let name = dir
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "Local model".into());
    let license = std::fs::read_to_string(dir.join("README.md"))
        .ok()
        .and_then(|r| readme_license(&r));
    upsert_ready(
        st,
        &id,
        &dir,
        &name,
        "local",
        None,
        None,
        license.as_deref(),
        json!({}),
    )?;
    detail(st, &id)
}

fn readme_license(readme: &str) -> Option<String> {
    let fm = readme.strip_prefix("---")?.split("\n---").next()?;
    fm.lines().find_map(|l| {
        l.trim()
            .strip_prefix("license:")
            .map(|v| v.trim().trim_matches('"').to_string())
    })
}

pub fn delete(st: &AppState, id: &str, delete_files: bool) -> AppResult<()> {
    let m = get(st, id)?;
    if delete_files && m.source == "hf" {
        let p = PathBuf::from(&m.local_path);
        if p.starts_with(st.paths.models()) && p.exists() {
            std::fs::remove_dir_all(&p)?;
        }
    }
    st.db
        .with(|c| c.execute("DELETE FROM models WHERE id = ?1", [id]))?;
    Ok(())
}

/* ---------------- download ---------------- */

pub fn submit_download(st: &AppState, repo: String, revision: Option<String>) -> AppResult<String> {
    if !crate::hub::valid_repo_id(&repo) || !repo.contains('/') {
        return Err(AppError::invalid(
            "Use the form owner/name, e.g. HuggingFaceTB/SmolLM2-135M-Instruct",
        ));
    }
    let existing: Option<String> = st.db.with(|c| {
        c.query_row(
            "SELECT id FROM models WHERE repo_id = ?1 AND source = 'hf'",
            [&repo],
            |r| r.get(0),
        )
        .optional()
    })?;
    let model_id = existing.unwrap_or_else(new_id);
    let dir = st.paths.models().join(repo.replace('/', "__"));
    st.db.with(|c| {
        c.execute(
            "INSERT INTO models (id, source, repo_id, local_path, name, status, created_at) VALUES (?1, 'hf', ?2, ?3, ?4, 'downloading', ?5)
             ON CONFLICT(id) DO UPDATE SET status = 'downloading'",
            rusqlite::params![model_id, repo, dir.to_string_lossy(), repo.split('/').next_back().unwrap_or(&repo), now_ms()],
        )
    })?;
    let st2 = st.clone();
    let mid = model_id.clone();
    let title = format!("Download {repo}");
    st.jobs.submit(
        NewJob {
            kind: "download",
            title,
            model_id: Some(model_id.clone()),
            format: None,
            params: json!({ "repo_id": repo, "revision": revision }),
            stages: vec![
                StageDef::new("resolve", "Resolve files", 0.3),
                StageDef::new("download", "Download weights", 10.0),
                StageDef::new("inspect", "Inspect model", 0.3),
            ],
            lane: Lane::Free,
        },
        move |ctx| async move {
            let r = run_download(&st2, &ctx, &mid, &repo, revision.as_deref(), &dir).await;
            if r.is_err() {
                let _ = st2.db.with(|c| {
                    c.execute("UPDATE models SET status = 'error' WHERE id = ?1", [&mid])
                });
            }
            st2.hub.emit("models:changed", json!({ "id": mid }));
            r
        },
    )
}

async fn run_download(
    st: &AppState,
    ctx: &JobCtx,
    model_id: &str,
    repo: &str,
    revision: Option<&str>,
    dir: &Path,
) -> AppResult<Value> {
    ctx.stage("resolve")?;
    let info = crate::hub::model_info(st, repo, revision).await?;
    let sha = info["revision"].as_str().unwrap_or("main").to_string();
    let files: Vec<Value> = info["download_files"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    if !files.iter().any(|f| {
        f["path"]
            .as_str()
            .map(|p| p.ends_with(".safetensors") || p.ends_with(".bin"))
            .unwrap_or(false)
    }) {
        return Err(
            AppError::invalid("This repository has no model weights to download")
                .with_hint("Pick the original (non-quantized) model repository."),
        );
    }
    let total: u64 = files.iter().filter_map(|f| f["size"].as_u64()).sum();
    if let Some(free) = crate::paths::free_space(dir) {
        if free < total + 1_000_000_000 {
            return Err(AppError::new(
                "disk",
                format!(
                    "Not enough free space: need {}, have {}",
                    crate::toolchain::download::human(total),
                    crate::toolchain::download::human(free)
                ),
            )
            .with_hint("Free some space or move the workspace to a larger drive in Settings."));
        }
    }
    ctx.log(format!(
        "{} files · {} · revision {}",
        files.len(),
        crate::toolchain::download::human(total),
        &sha[..sha.len().min(12)]
    ));

    ctx.stage("download")?;
    std::fs::create_dir_all(dir)?;
    let done = Arc::new(AtomicU64::new(0));
    let token = st
        .secrets
        .get(crate::secrets::HF_TOKEN)
        .ok()
        .flatten()
        .map(|t| t.to_string());
    let reporter = {
        let done = done.clone();
        let ctx = ctx.clone();
        tokio::spawn(async move {
            let start = std::time::Instant::now();
            let mut last = 0u64;
            let mut last_t = std::time::Instant::now();
            let mut rate = 0f64;
            loop {
                tokio::time::sleep(std::time::Duration::from_millis(250)).await;
                let d = done.load(Ordering::Relaxed);
                let dt = last_t.elapsed().as_secs_f64();
                if dt > 0.9 {
                    let inst = (d - last) as f64 / dt;
                    rate = if rate == 0.0 {
                        inst
                    } else {
                        rate * 0.7 + inst * 0.3
                    };
                    last = d;
                    last_t = std::time::Instant::now();
                }
                let eta = if rate > 0.0 {
                    ((total.saturating_sub(d)) as f64 / rate) as u64
                } else {
                    0
                };
                ctx.stage_progress_extra(
                    if total > 0 { d as f64 / total as f64 } else { 0.0 },
                    Some(format!("{} / {} · {}/s", crate::toolchain::download::human(d), crate::toolchain::download::human(total), crate::toolchain::download::human(rate as u64))),
                    Some(json!({ "bytes": d, "total": total, "rate": rate, "eta_s": eta, "elapsed_s": start.elapsed().as_secs() })),
                );
            }
        })
    };
    let results: Vec<AppResult<()>> =
        futures_util::stream::iter(files.iter().cloned())
            .map(|f| {
                let st = st.clone();
                let ctx = ctx.clone();
                let done = done.clone();
                let token = token.clone();
                let sha = sha.clone();
                let repo = repo.to_string();
                let dir = dir.to_path_buf();
                async move {
                    download_one(&st, &ctx, &repo, &sha, &f, &dir, &done, token.as_deref()).await
                }
            })
            .buffer_unordered(4)
            .collect()
            .await;
    reporter.abort();
    for r in results {
        r?;
    }

    ctx.stage("inspect")?;
    let name = repo.split('/').next_back().unwrap_or(repo).to_string();
    upsert_ready(
        st,
        model_id,
        dir,
        &name,
        "hf",
        Some(repo),
        Some(&sha),
        info["license"].as_str(),
        json!({ "gated": info["gated"], "tags": info["tags"], "license_name": info["license_name"], "base_model": info["base_model"] }),
    )?;
    Ok(json!({ "model_id": model_id, "bytes": total, "revision": sha }))
}

#[allow(clippy::too_many_arguments)]
async fn download_one(
    st: &AppState,
    ctx: &JobCtx,
    repo: &str,
    sha: &str,
    f: &Value,
    dir: &Path,
    done: &AtomicU64,
    token: Option<&str>,
) -> AppResult<()> {
    let rel = f["path"]
        .as_str()
        .ok_or_else(|| AppError::invalid("bad file entry"))?;
    if rel.contains("..") {
        return Err(AppError::invalid(format!("Refusing suspicious path {rel}")));
    }
    let size = f["size"].as_u64();
    let expected = f["sha256"].as_str().map(str::to_string);
    let dest = dir.join(rel);
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent)?;
    }
    if let (Ok(meta), Some(sz)) = (std::fs::metadata(&dest), size) {
        if meta.len() == sz {
            done.fetch_add(sz, Ordering::Relaxed);
            return Ok(());
        }
    }
    let part = PathBuf::from(format!("{}.part", dest.display()));
    let mut have = std::fs::metadata(&part).map(|m| m.len()).unwrap_or(0);
    if size.map(|s| have > s).unwrap_or(false) {
        have = 0;
    }
    let mut hasher = Sha256::new();
    if have > 0 && expected.is_some() {
        let mut fh = std::fs::File::open(&part)?;
        let mut buf = vec![0u8; 1 << 20];
        loop {
            let n = fh.read(&mut buf)?;
            if n == 0 {
                break;
            }
            hasher.update(&buf[..n]);
        }
    }
    let url = format!(
        "{}/{repo}/resolve/{sha}/{}",
        crate::hub::HF,
        rel.split('/').map(urlencode).collect::<Vec<_>>().join("/")
    );
    let mut req = st.http.get(&url);
    if let Some(t) = token {
        req = req.bearer_auth(t);
    }
    if have > 0 {
        req = req.header(reqwest::header::RANGE, format!("bytes={have}-"));
    }
    let resp = req.send().await?;
    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        let mut e = crate::error::http_status_error("Hugging Face", status, &body);
        if status.as_u16() == 401 || status.as_u16() == 403 {
            e = e.with_hint("This model is gated. Open its page on huggingface.co, accept the license, and add a token in Settings → Accounts.");
        }
        return Err(e);
    }
    let mut file = if status.as_u16() == 206 {
        done.fetch_add(have, Ordering::Relaxed);
        std::fs::OpenOptions::new().append(true).open(&part)?
    } else {
        hasher = Sha256::new();
        std::fs::File::create(&part)?
    };
    let mut stream = resp.bytes_stream();
    let mut writer = std::io::BufWriter::with_capacity(4 << 20, &mut file);
    while let Some(chunk) = stream.next().await {
        ctx.check_cancel()?;
        let chunk = chunk?;
        writer.write_all(&chunk)?;
        if expected.is_some() {
            hasher.update(&chunk);
        }
        done.fetch_add(chunk.len() as u64, Ordering::Relaxed);
    }
    writer.flush()?;
    drop(writer);
    drop(file);
    if let Some(exp) = expected {
        let got = hex::encode(hasher.finalize());
        if got != exp {
            let _ = std::fs::remove_file(&part);
            return Err(
                AppError::new("checksum", format!("{rel} failed its checksum"))
                    .with_hint("Run the download again; corrupted parts are discarded."),
            );
        }
    }
    std::fs::rename(&part, &dest)?;
    Ok(())
}

fn urlencode(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (b as char).to_string()
            }
            _ => format!("%{b:02X}"),
        })
        .collect()
}

/// Tensor list for the model (safetensors headers), for the tensor map.
pub fn model_tensors(st: &AppState, id: &str) -> AppResult<Vec<tensors::TensorInfo>> {
    let m = get(st, id)?;
    tensors::read_safetensors_dir(Path::new(&m.local_path))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn selects_weights_and_tokenizer_but_not_exports() {
        let files: Vec<Value> = [
            "config.json",
            "model-00001-of-00002.safetensors",
            "model.safetensors.index.json",
            "pytorch_model.bin",
            "tokenizer.json",
            "tokenizer_config.json",
            "chat_template.jinja",
            "onnx/model.onnx",
            "original/consolidated.00.pth",
            "README.md",
            "model.gguf",
        ]
        .iter()
        .map(|p| json!({ "path": p }))
        .collect();
        let sel: Vec<String> = select_files(&files)
            .iter()
            .map(|f| f["path"].as_str().unwrap().to_string())
            .collect();
        assert!(sel.contains(&"model-00001-of-00002.safetensors".to_string()));
        assert!(sel.contains(&"chat_template.jinja".to_string()));
        assert!(!sel.contains(&"pytorch_model.bin".to_string()));
        assert!(!sel
            .iter()
            .any(|s| s.starts_with("onnx/") || s.starts_with("original/") || s.ends_with(".gguf")));
    }

    #[test]
    fn reads_license_from_front_matter() {
        assert_eq!(
            readme_license("---\nlicense: apache-2.0\n---\n# x").as_deref(),
            Some("apache-2.0")
        );
        assert_eq!(readme_license("# no front matter"), None);
    }
}
