//! Model cards: provenance bundle → deterministic template → (optional) AI drafting,
//! with a guard that flags numbers the AI wrote that don't come from the provenance.

pub mod card;
pub mod guard;

use crate::db::{json_col, new_id, now_ms};
use crate::error::{AppError, AppResult};
use crate::quant::artifacts;
use crate::state::AppState;
use regex::Regex;
use serde_json::{json, Value};
use std::sync::LazyLock;

/// Replaces local paths with placeholders so nothing personal leaks into published docs.
pub fn scrub(st: &AppState, s: &str) -> String {
    let mut out = s
        .replace(
            &st.paths.workspace().to_string_lossy().to_string(),
            "<workspace>",
        )
        .replace(&st.paths.data.to_string_lossy().to_string(), "<app>");
    if let Ok(home) = std::env::var("HOME") {
        if !home.is_empty() {
            out = out.replace(&home, "~");
        }
    }
    out
}

fn tensor_histogram(st: &AppState, artifact_id: &str) -> Value {
    let rows: Vec<(String, i64, i64)> = st
        .db
        .with(|c| {
            let mut s = c.prepare("SELECT dtype, SUM(n_elements), SUM(bytes) FROM artifact_tensors WHERE artifact_id = ?1 GROUP BY dtype ORDER BY 2 DESC")?;
            let r = s.query_map([artifact_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?;
            r.collect()
        })
        .unwrap_or_default();
    let total: i64 = rows.iter().map(|r| r.1).sum::<i64>().max(1);
    Value::Array(rows.into_iter().map(|(d, n, b)| json!({ "type": d, "share": n as f64 / total as f64, "bits": if n > 0 { b as f64 * 8.0 / n as f64 } else { 0.0 } })).collect())
}

fn job_commands(st: &AppState, job_id: &str) -> Vec<String> {
    st.db
        .with(|c| {
            let mut s = c.prepare(
                "SELECT line FROM job_logs WHERE job_id = ?1 AND stream = 'cmd' ORDER BY id",
            )?;
            let r = s.query_map([job_id], |r| r.get::<_, String>(0))?;
            r.collect::<Result<Vec<_>, _>>()
        })
        .unwrap_or_default()
        .into_iter()
        .map(|l| scrub(st, l.trim_start_matches("$ ")))
        .collect()
}

/// Everything known about how these outputs were produced.
pub fn provenance(st: &AppState, model_id: &str, artifact_ids: &[String]) -> AppResult<Value> {
    let m = crate::models::get(st, model_id)?;
    let arch = &m.info["arch"];
    let mut outputs = vec![];
    let mut refs = vec![];
    let mut commands = vec![];
    let mut eval_meta = Value::Null;
    for id in artifact_ids {
        let a = artifacts::get(st, id)?;
        if a.model_id.as_deref() != Some(model_id) {
            return Err(AppError::invalid(
                "All outputs in a model card must come from the same model",
            ));
        }
        let files: Vec<Value> = artifacts::shard_paths(std::path::Path::new(&a.path))
            .iter()
            .flat_map(|p| {
                if p.is_dir() {
                    std::fs::read_dir(p).map(|rd| rd.flatten().filter(|e| e.path().is_file()).map(|e| json!({ "name": e.file_name().to_string_lossy(), "bytes": e.metadata().map(|m| m.len()).unwrap_or(0) })).collect::<Vec<_>>()).unwrap_or_default()
                } else {
                    vec![json!({ "name": p.file_name().map(|n| n.to_string_lossy().to_string()), "bytes": std::fs::metadata(p).map(|m| m.len()).unwrap_or(0) })]
                }
            })
            .collect();
        if let Some(job) = &a.job_id {
            for c in job_commands(st, job) {
                if !commands.contains(&c) {
                    commands.push(c);
                }
            }
            if eval_meta.is_null() {
                eval_meta = st
                    .db
                    .with(|c| {
                        rusqlite::OptionalExtension::optional(c.query_row(
                            "SELECT params_json FROM eval_runs WHERE job_id = ?1 AND kind = 'kld'",
                            [job],
                            |r| r.get::<_, String>(0),
                        ))
                    })
                    .ok()
                    .flatten()
                    .and_then(|s| serde_json::from_str(&s).ok())
                    .unwrap_or(Value::Null);
            }
        }
        let entry = json!({
            "id": a.id, "format": a.format, "variant": a.variant, "role": a.role,
            "size_bytes": a.size_bytes, "bits_per_weight": a.bpw.map(|b| (b * 100.0).round() / 100.0), "sha256": a.sha256, "files": files,
            "metrics": a.metrics, "recipe": a.meta["recipe"].clone().as_object().map(|_| a.meta["recipe"].clone()).unwrap_or(a.meta["variant"].clone()),
            "method": a.meta["method"], "engine": a.meta["engine"], "imatrix": a.meta["imatrix"], "tensor_types": tensor_histogram(st, &a.id),
            "fallback_tensors": a.meta["reported"]["fallback_tensors"],
        });
        if a.role == "reference" {
            refs.push(entry);
        } else {
            outputs.push(entry);
        }
    }
    // Include the matching references (original measured in the same runtime).
    for f in outputs
        .iter()
        .filter_map(|o| o["format"].as_str())
        .collect::<std::collections::BTreeSet<_>>()
    {
        if refs.iter().any(|r| r["format"] == f) {
            continue;
        }
        if let Some(r) = artifacts::list(st, Some(model_id))?
            .into_iter()
            .find(|a| a.role == "reference" && a.format == f)
        {
            refs.push(json!({ "format": r.format, "variant": r.variant, "metrics": r.metrics, "size_bytes": r.size_bytes }));
        }
    }
    let caps = crate::toolchain::capabilities(st).unwrap_or(Value::Null);
    let p = st.platform();
    Ok(json!({
        "generated_at": now_ms(),
        "app": { "name": "iQuantize", "version": env!("CARGO_PKG_VERSION") },
        "quantized_by": st.setting_or("quantized_by", &st.setting_or("hf_username", "")),
        "model": {
            "name": m.name, "repo_id": m.repo_id, "revision": m.revision, "license": m.license, "license_name": m.info["license_name"],
            "architecture": m.architecture, "model_type": m.model_type, "parameters": m.params, "dtype": m.dtype, "context_length": m.context_length,
            "layers": arch["layers"], "hidden_size": arch["hidden_size"], "vocab_size": arch["vocab_size"], "tied_embeddings": arch["tied_embeddings"],
            "experts": arch["experts"], "gated": m.info["gated"],
        },
        "outputs": outputs,
        "references": refs,
        "evaluation": if eval_meta.is_null() { json!(null) } else { json!({ "dataset": "WikiText-2 (test split)", "chunks": eval_meta["chunks"], "tokens_per_chunk": eval_meta["ctx"], "kld_method": eval_meta["approximation"].as_str().unwrap_or("full distribution (llama-perplexity)") }) },
        "toolchain": {
            "llama_cpp": crate::toolchain::MANIFEST.llama_cpp.tag, "llama_cpp_backend": crate::toolchain::llama_accel(st),
            "mlx_lm": caps["env_mlx"]["packages"]["mlx-lm"], "mlx": caps["env_mlx"]["packages"]["mlx"],
            "onnxruntime_genai": caps["env_onnx"]["packages"]["onnxruntime-genai"], "onnxruntime": caps["env_onnx"]["packages"]["onnxruntime"],
            "python": caps["env_core"]["python"],
        },
        "hardware": { "os": p.os, "arch": p.arch, "cpu": p.cpu_brand, "ram_bytes": p.total_ram, "accelerators": p.accelerators },
        "commands": commands,
    }))
}

/* ---------------- documents ---------------- */

static FRONT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?s)\A---\n(.*?)\n---\n?").unwrap());

pub fn create(
    st: &AppState,
    model_id: &str,
    artifact_ids: Vec<String>,
    title: Option<String>,
) -> AppResult<String> {
    if artifact_ids.is_empty() {
        return Err(AppError::invalid("Pick at least one quantized output"));
    }
    let prov = provenance(st, model_id, &artifact_ids)?;
    let md = card::template(&prov, None);
    let id = new_id();
    let title = title.unwrap_or_else(|| {
        let formats: std::collections::BTreeSet<String> = prov["outputs"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|o| o["format"].as_str().map(|f| f.to_uppercase()))
            .collect();
        format!(
            "{} · {}",
            prov["model"]["name"].as_str().unwrap_or("Model"),
            formats.into_iter().collect::<Vec<_>>().join(" + ")
        )
    });
    let ts = now_ms();
    st.db.tx(|tx| {
        tx.execute(
            "INSERT INTO documents (id, title, model_id, artifact_ids_json, markdown, provenance_json, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)",
            rusqlite::params![id, title, model_id, json!(artifact_ids).to_string(), md, prov.to_string(), ts],
        )?;
        tx.execute("INSERT INTO document_versions (document_id, markdown, source, created_at) VALUES (?1, ?2, 'template', ?3)", rusqlite::params![id, md, ts])?;
        Ok(())
    })?;
    Ok(id)
}

pub fn get(st: &AppState, id: &str) -> AppResult<Value> {
    st.db
        .with(|c| {
            rusqlite::OptionalExtension::optional(c.query_row(
                "SELECT id, title, model_id, artifact_ids_json, markdown, provenance_json, repo_id, created_at, updated_at, (SELECT COUNT(*) FROM document_versions v WHERE v.document_id = d.id) FROM documents d WHERE id = ?1",
                [id],
                |r| {
                    Ok(json!({
                        "id": r.get::<_, String>(0)?, "title": r.get::<_, String>(1)?, "model_id": r.get::<_, Option<String>>(2)?,
                        "artifact_ids": json_col(r.get(3)?), "markdown": r.get::<_, String>(4)?, "provenance": json_col(r.get(5)?),
                        "repo_id": r.get::<_, Option<String>>(6)?, "created_at": r.get::<_, i64>(7)?, "updated_at": r.get::<_, i64>(8)?, "versions": r.get::<_, i64>(9)?,
                    }))
                },
            ))
        })?
        .ok_or_else(|| AppError::not_found("Document"))
}

pub fn list(st: &AppState) -> AppResult<Vec<Value>> {
    st.db.with(|c| {
        let mut s = c.prepare("SELECT id, title, model_id, repo_id, updated_at, length(markdown) FROM documents ORDER BY updated_at DESC")?;
        let r = s.query_map([], |r| Ok(json!({ "id": r.get::<_, String>(0)?, "title": r.get::<_, String>(1)?, "model_id": r.get::<_, Option<String>>(2)?, "repo_id": r.get::<_, Option<String>>(3)?, "updated_at": r.get::<_, i64>(4)?, "chars": r.get::<_, i64>(5)? })))?;
        r.collect()
    })
}

pub fn save(
    st: &AppState,
    id: &str,
    markdown: &str,
    source: &str,
    ai_model: Option<&str>,
) -> AppResult<()> {
    let ts = now_ms();
    st.db.tx(|tx| {
        tx.execute("UPDATE documents SET markdown = ?1, updated_at = ?2 WHERE id = ?3", rusqlite::params![markdown, ts, id])?;
        let last: Option<String> = rusqlite::OptionalExtension::optional(tx.query_row("SELECT markdown FROM document_versions WHERE document_id = ?1 ORDER BY id DESC LIMIT 1", [id], |r| r.get(0)))?;
        if last.as_deref() != Some(markdown) {
            tx.execute("INSERT INTO document_versions (document_id, markdown, source, ai_model, created_at) VALUES (?1, ?2, ?3, ?4, ?5)", rusqlite::params![id, markdown, source, ai_model, ts])?;
        }
        Ok(())
    })
}

pub fn set_repo(st: &AppState, id: &str, repo: &str) -> AppResult<()> {
    st.db.with(|c| {
        c.execute(
            "UPDATE documents SET repo_id = ?1 WHERE id = ?2",
            [repo, id],
        )
    })?;
    Ok(())
}

pub fn versions(st: &AppState, id: &str) -> AppResult<Vec<Value>> {
    st.db.with(|c| {
        let mut s = c.prepare("SELECT id, source, ai_model, created_at, length(markdown), markdown FROM document_versions WHERE document_id = ?1 ORDER BY id DESC LIMIT 100")?;
        let r = s.query_map([id], |r| Ok(json!({ "id": r.get::<_, i64>(0)?, "source": r.get::<_, String>(1)?, "ai_model": r.get::<_, Option<String>>(2)?, "created_at": r.get::<_, i64>(3)?, "chars": r.get::<_, i64>(4)?, "markdown": r.get::<_, String>(5)? })))?;
        r.collect()
    })
}

pub fn delete(st: &AppState, id: &str) -> AppResult<()> {
    st.db
        .with(|c| c.execute("DELETE FROM documents WHERE id = ?1", [id]))?;
    Ok(())
}

/// Refreshes provenance (e.g. after new evaluations) and returns a fresh template.
pub fn regenerate(st: &AppState, id: &str, repo: Option<&str>) -> AppResult<String> {
    let d = get(st, id)?;
    let ids: Vec<String> = d["artifact_ids"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|x| x.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    let prov = provenance(st, d["model_id"].as_str().unwrap_or_default(), &ids)?;
    st.db.with(|c| {
        c.execute(
            "UPDATE documents SET provenance_json = ?1 WHERE id = ?2",
            [prov.to_string(), id.to_string()],
        )
    })?;
    Ok(card::template(&prov, repo.or(d["repo_id"].as_str())))
}

fn escape_html(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

/// Markdown → sanitized HTML. YAML front matter is shown as a separate block.
pub fn render(markdown: &str) -> String {
    use pulldown_cmark::{html, Options, Parser};
    let (front, body) = match FRONT.captures(markdown) {
        Some(c) => (
            Some(c[1].to_string()),
            &markdown[c.get(0).map(|m| m.end()).unwrap_or(0)..],
        ),
        None => (None, markdown),
    };
    let mut opts = Options::empty();
    opts.insert(Options::ENABLE_TABLES);
    opts.insert(Options::ENABLE_STRIKETHROUGH);
    opts.insert(Options::ENABLE_TASKLISTS);
    let mut out = String::new();
    html::push_html(&mut out, Parser::new_ext(body, opts));
    let clean = ammonia::Builder::default()
        .add_generic_attributes(["align"])
        .link_rel(Some("noopener noreferrer"))
        .url_schemes(["https"].into())
        .clean(&out)
        .to_string();
    match front {
        Some(f) => format!(
            "<pre class=\"frontmatter\">{}</pre>{}",
            escape_html(&f),
            clean
        ),
        None => clean,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn render_sanitizes_and_shows_front_matter() {
        let html = render("---\nlicense: mit\n---\n# Title\n\n<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n[x](javascript:alert(1)) [ok](https://hf.co)\n\n| a | b |\n|---|---|\n| 1 | 2 |\n");
        assert!(html.contains("frontmatter") && html.contains("license: mit"));
        assert!(
            !html.contains("<script") && !html.contains("onerror") && !html.contains("javascript:")
        );
        assert!(html.contains("<table>") && html.contains("https://hf.co"));
    }
}
