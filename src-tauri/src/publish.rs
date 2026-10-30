//! Publishing to Hugging Face: stage README + outputs (hard links, no copies), upload with
//! huggingface_hub (Xet/LFS aware), then verify sizes through the Hub API.

use crate::db::{new_id, now_ms};
use crate::error::{AppError, AppResult};
use crate::jobs::{JobCtx, Lane, NewJob, StageDef};
use crate::quant::artifacts;
use crate::state::AppState;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

const HF_FILE_LIMIT: u64 = 50_000_000_000;

fn link_or_copy(src: &Path, dst: &Path) -> AppResult<()> {
    if let Some(p) = dst.parent() {
        std::fs::create_dir_all(p)?;
    }
    let _ = std::fs::remove_file(dst);
    if std::fs::hard_link(src, dst).is_ok() {
        return Ok(());
    }
    #[cfg(unix)]
    {
        if std::os::unix::fs::symlink(src, dst).is_ok() {
            return Ok(());
        }
    }
    std::fs::copy(src, dst)?;
    Ok(())
}

/// Files that would be uploaded: (path in repo, source path, size).
pub fn plan_files(st: &AppState, doc: &Value) -> AppResult<Vec<(String, PathBuf, u64)>> {
    let ids: Vec<String> = doc["artifact_ids"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|x| x.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    let arts: Vec<_> = ids
        .iter()
        .map(|id| artifacts::get(st, id))
        .collect::<AppResult<Vec<_>>>()?;
    let mut out = vec![];
    let dir_formats: Vec<&str> = arts
        .iter()
        .filter(|a| a.format != "gguf")
        .map(|a| a.format.as_str())
        .collect();
    for a in &arts {
        if !a.exists {
            return Err(AppError::not_found(format!("Output {} on disk", a.variant)));
        }
        let p = PathBuf::from(&a.path);
        if a.format == "gguf" {
            for s in artifacts::shard_paths(&p) {
                let size = std::fs::metadata(&s)?.len();
                out.push((
                    s.file_name()
                        .unwrap_or_default()
                        .to_string_lossy()
                        .to_string(),
                    s.clone(),
                    size,
                ));
            }
        } else {
            // A single MLX/ONNX output goes to the repo root so it loads by repo id;
            // several go into sub-folders named after the variant.
            let prefix = if dir_formats.len() > 1 {
                format!("{}/", a.variant)
            } else {
                String::new()
            };
            for e in std::fs::read_dir(&p)?.flatten() {
                if e.path().is_file() {
                    let size = e.metadata()?.len();
                    out.push((
                        format!("{prefix}{}", e.file_name().to_string_lossy()),
                        e.path(),
                        size,
                    ));
                }
            }
        }
        if a.format == "gguf" && a.meta["imatrix"].is_object() {
            // Recorded in the report; the matrix itself is optional to share.
        }
    }
    Ok(out)
}

pub async fn prepare(st: &AppState, doc_id: &str, repo: &str) -> AppResult<Value> {
    let doc = crate::docs::get(st, doc_id)?;
    let who = crate::hub::whoami(st).await?;
    let status = crate::hub::repo_status(st, repo).await?;
    let files = plan_files(st, &doc)?;
    let too_big: Vec<&String> = files
        .iter()
        .filter(|f| f.2 > HF_FILE_LIMIT)
        .map(|f| &f.0)
        .collect();
    let owner = repo.split('/').next().unwrap_or_default();
    let can_namespace = who["name"] == owner
        || who["orgs"]
            .as_array()
            .map(|o| o.iter().any(|x| x == owner))
            .unwrap_or(false);
    let mut warnings = vec![];
    if !who["can_write"].as_bool().unwrap_or(false) {
        warnings.push(
            "Your token looks read-only. Create a token with write access to publish.".to_string(),
        );
    }
    if !can_namespace {
        warnings.push(format!(
            "You are not a member of \"{owner}\". Use your username or one of your organizations."
        ));
    }
    if !too_big.is_empty() {
        warnings.push(format!(
            "These files exceed Hugging Face's 50 GB per-file limit: {}",
            too_big
                .iter()
                .map(|s| s.as_str())
                .collect::<Vec<_>>()
                .join(", ")
        ));
    }
    let lic = doc["provenance"]["model"]["license"]
        .as_str()
        .unwrap_or("")
        .to_lowercase();
    if lic.contains("llama") {
        warnings.push("Llama licenses require derivative model names to start with \"Llama\" and the license to be included.".into());
    }
    if lic.contains("gemma") {
        warnings.push("Gemma terms apply to derivatives; keep the license and usage policy links in the card.".into());
    }
    Ok(json!({
        "user": who, "repo": status, "files": files.iter().map(|f| json!({ "path": f.0, "bytes": f.2 })).collect::<Vec<_>>(),
        "total_bytes": files.iter().map(|f| f.2).sum::<u64>(), "warnings": warnings, "blocked": !too_big.is_empty() || !can_namespace,
    }))
}

pub fn submit(
    st: &AppState,
    doc_id: String,
    repo: String,
    private: bool,
    message: String,
) -> AppResult<String> {
    if !crate::hub::valid_repo_id(&repo) || !repo.contains('/') {
        return Err(AppError::invalid("Use the form owner/name"));
    }
    if !crate::toolchain::is_installed(st, "env_core") {
        return Err(AppError::missing_tool("Hub & data tools"));
    }
    let doc = crate::docs::get(st, &doc_id)?;
    let st2 = st.clone();
    let title = format!("Publish {repo}");
    st.jobs.submit(
        NewJob {
            kind: "upload",
            title,
            model_id: doc["model_id"].as_str().map(str::to_string),
            format: None,
            params: json!({ "document_id": doc_id, "repo_id": repo, "private": private }),
            stages: vec![
                StageDef::new("stage", "Prepare files", 0.3),
                StageDef::new("upload", "Upload to Hugging Face", 10.0),
                StageDef::new("verify", "Verify upload", 0.3),
            ],
            lane: Lane::Free,
        },
        move |ctx| async move { run(&st2, &ctx, &doc, &repo, private, &message).await },
    )
}

async fn run(
    st: &AppState,
    ctx: &JobCtx,
    doc: &Value,
    repo: &str,
    private: bool,
    message: &str,
) -> AppResult<Value> {
    ctx.stage("stage")?;
    let doc_id = doc["id"].as_str().unwrap_or_default();
    let staging = st.paths.workspace().join("publish").join(doc_id);
    let _ = std::fs::remove_dir_all(&staging);
    std::fs::create_dir_all(&staging)?;
    let files = plan_files(st, doc)?;
    for (rel, src, _) in &files {
        link_or_copy(src, &staging.join(rel))?;
    }
    let readme = doc["markdown"]
        .as_str()
        .unwrap_or_default()
        .replace("<your-username>/<repo-name>", repo);
    std::fs::write(staging.join("README.md"), &readme)?;
    std::fs::write(
        staging.join("quantization_report.json"),
        serde_json::to_string_pretty(&doc["provenance"])?,
    )?;
    let total: u64 = files.iter().map(|f| f.2).sum();
    ctx.log(format!(
        "{} files · {}",
        files.len() + 2,
        crate::toolchain::download::human(total)
    ));

    ctx.stage("upload")?;
    let args = json!({ "repo_id": repo, "folder": staging, "private": private, "commit_message": if message.trim().is_empty() { "Upload quantized model with iQuantize" } else { message }, "large": total > 20_000_000_000u64 });
    let spec = crate::driver::spawn(st, "core", "hf_upload.py", &args, true)?;
    let res = crate::driver::run(ctx, &spec, |_| {}).await?;

    ctx.stage("verify")?;
    let info: Value = st
        .http
        .get(format!("{}/api/models/{repo}?blobs=true", crate::hub::HF))
        .bearer_auth(
            st.secrets
                .require(crate::secrets::HF_TOKEN, "Hugging Face token")?
                .as_str(),
        )
        .send()
        .await?
        .json()
        .await?;
    let remote: std::collections::HashMap<String, u64> = info["siblings"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|s| {
                    Some((
                        s["rfilename"].as_str()?.to_string(),
                        s["size"]
                            .as_u64()
                            .or_else(|| s["lfs"]["size"].as_u64())
                            .unwrap_or(0),
                    ))
                })
                .collect()
        })
        .unwrap_or_default();
    let mismatched: Vec<&String> = files
        .iter()
        .filter(|(rel, _, size)| remote.get(rel) != Some(size))
        .map(|f| &f.0)
        .collect();
    if !mismatched.is_empty() {
        return Err(AppError::new(
            "verify",
            format!(
                "Uploaded, but these files don't match on the Hub: {}",
                mismatched
                    .iter()
                    .map(|s| s.as_str())
                    .collect::<Vec<_>>()
                    .join(", ")
            ),
        )
        .with_hint("Run publish again; uploads resume where they stopped."));
    }
    ctx.log(format!("✓ Verified {} files on the Hub", files.len()));
    let url = res["url"]
        .as_str()
        .map(str::to_string)
        .unwrap_or_else(|| format!("https://huggingface.co/{repo}"));
    crate::docs::set_repo(st, doc_id, repo)?;
    crate::docs::save(st, doc_id, &readme, "manual", None)?;
    st.db.with(|c| {
        c.execute(
            "INSERT INTO uploads (id, job_id, document_id, repo_id, private, files_json, status, url, commit_sha, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'done', ?7, ?8, ?9)",
            rusqlite::params![new_id(), ctx.id, doc_id, repo, private as i64, json!(files.iter().map(|f| &f.0).collect::<Vec<_>>()).to_string(), url, res["commit_sha"].as_str(), now_ms()],
        )
    })?;
    let _ = std::fs::remove_dir_all(&staging);
    Ok(json!({ "url": url, "commit": res["commit_sha"], "files": files.len() }))
}

pub fn uploads(st: &AppState) -> AppResult<Vec<Value>> {
    st.db.with(|c| {
        let mut s = c.prepare("SELECT id, document_id, repo_id, private, status, url, commit_sha, created_at FROM uploads ORDER BY created_at DESC")?;
        let r = s.query_map([], |r| {
            Ok(json!({ "id": r.get::<_, String>(0)?, "document_id": r.get::<_, Option<String>>(1)?, "repo_id": r.get::<_, String>(2)?, "private": r.get::<_, i64>(3)? != 0, "status": r.get::<_, String>(4)?, "url": r.get::<_, Option<String>>(5)?, "commit": r.get::<_, Option<String>>(6)?, "created_at": r.get::<_, i64>(7)? }))
        })?;
        r.collect()
    })
}
