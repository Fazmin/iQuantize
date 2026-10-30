//! Calibration and evaluation text: presets fetched once via the core environment, HF
//! datasets, or the user's own file. Reused across jobs.

use super::recipe::CalibSpec;
use crate::db::{new_id, now_ms};
use crate::error::{AppError, AppResult};
use crate::jobs::JobCtx;
use crate::state::AppState;
use rusqlite::OptionalExtension;
use serde_json::{json, Value};
use std::path::PathBuf;

/// Roughly 4.2 characters per token for English text, plus margin.
pub fn chars_for_tokens(tokens: u64) -> u64 {
    (tokens as f64 * 4.2 * 1.2) as u64 + 20_000
}

fn source_key(spec: &CalibSpec) -> String {
    match spec.source.as_str() {
        "hf" => format!(
            "hf:{}:{}:{}:{}",
            spec.dataset.clone().unwrap_or_default(),
            spec.config.clone().unwrap_or_default(),
            spec.split.clone().unwrap_or_default(),
            spec.column.clone().unwrap_or_default()
        ),
        s => s.to_string(),
    }
}

pub fn describe(spec: &CalibSpec) -> String {
    match spec.source.as_str() {
        "wikitext2-train" => "WikiText-2 (train split)".into(),
        "wikitext2-test" => "WikiText-2 (test split)".into(),
        "pile-val" => "The Pile (validation sample)".into(),
        "c4-en" => "C4 English (validation)".into(),
        "file" => format!("Custom file {}", spec.path.clone().unwrap_or_default()),
        "hf" => format!(
            "Hugging Face dataset {}",
            spec.dataset.clone().unwrap_or_default()
        ),
        s => s.to_string(),
    }
}

/// Returns a UTF-8 text file with at least `min_chars` characters for the spec.
pub async fn ensure_text(
    st: &AppState,
    ctx: &JobCtx,
    spec: &CalibSpec,
    min_chars: u64,
) -> AppResult<(PathBuf, Value)> {
    if spec.source == "file" {
        let p = PathBuf::from(
            spec.path
                .clone()
                .ok_or_else(|| AppError::invalid("Choose a calibration text file"))?,
        );
        if !p.exists() {
            return Err(AppError::not_found(p.display().to_string()));
        }
        let ext = p
            .extension()
            .map(|e| e.to_string_lossy().to_lowercase())
            .unwrap_or_default();
        if ext == "jsonl" || ext == "json" {
            let text = jsonl_to_text(&std::fs::read_to_string(&p)?);
            let out = st.paths.calibration().join(format!(
                "file-{}.txt",
                super::cache_key(&[&p.to_string_lossy()])
            ));
            std::fs::write(&out, text)?;
            return Ok((
                out.clone(),
                json!({ "source": "file", "path": p, "converted": out }),
            ));
        }
        return Ok((
            p.clone(),
            json!({ "source": "file", "path": p, "bytes": std::fs::metadata(&p)?.len() }),
        ));
    }
    let key = source_key(spec);
    let existing: Option<(String, i64, Option<String>)> = st.db.with(|c| {
        c.query_row(
            "SELECT path, bytes, sha256 FROM calibration_sets WHERE source = ?1 AND bytes >= ?2 ORDER BY bytes ASC LIMIT 1",
            rusqlite::params![key, min_chars as i64],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()
    })?;
    if let Some((p, bytes, sha)) = existing {
        if std::path::Path::new(&p).exists() {
            ctx.log(format!("Reusing {} ({} characters)", describe(spec), bytes));
            return Ok((
                PathBuf::from(p),
                json!({ "source": key, "description": describe(spec), "chars": bytes, "sha256": sha }),
            ));
        }
    }
    let out = st.paths.calibration().join(format!(
        "{}-{}.txt",
        super::slug(&key.replace(':', "_")),
        min_chars
    ));
    let mut args = json!({ "max_chars": min_chars, "out_path": out });
    if spec.source == "hf" {
        args["dataset"] = json!(spec.dataset);
        args["config"] = json!(spec.config);
        args["split"] = json!(spec.split.clone().unwrap_or_else(|| "train".into()));
        args["column"] = json!(spec.column.clone().unwrap_or_else(|| "text".into()));
    } else {
        args["preset"] = json!(spec.source);
    }
    ctx.log(format!("Fetching {} …", describe(spec)));
    let spawn = crate::driver::spawn(st, "core", "calib_fetch.py", &args, true)?;
    let res = crate::driver::run(ctx, &spawn, |_| {}).await?;
    let chars = res["chars"].as_i64().unwrap_or(0);
    st.db.with(|c| {
        c.execute(
            "INSERT INTO calibration_sets (id, name, source, path, bytes, sha256, meta_json, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            rusqlite::params![new_id(), describe(spec), key, out.to_string_lossy(), chars, res["sha256"].as_str(), res.to_string(), now_ms()],
        )
    })?;
    Ok((
        out,
        json!({ "source": key, "description": describe(spec), "chars": chars, "rows": res["rows"], "sha256": res["sha256"] }),
    ))
}

/// WikiText-2 test split, the standard perplexity text.
pub async fn eval_text(st: &AppState, ctx: &JobCtx, tokens: u64) -> AppResult<(PathBuf, Value)> {
    let spec = CalibSpec {
        source: "wikitext2-test".into(),
        ..Default::default()
    };
    ensure_text(st, ctx, &spec, chars_for_tokens(tokens)).await
}

fn jsonl_to_text(s: &str) -> String {
    let mut out = String::new();
    let push = |v: &Value, out: &mut String| {
        for k in ["text", "content", "prompt", "completion", "response"] {
            if let Some(t) = v.get(k).and_then(|x| x.as_str()) {
                out.push_str(t);
                out.push_str("\n\n");
            }
        }
        if let Some(msgs) = v.get("messages").and_then(|m| m.as_array()) {
            for m in msgs {
                if let Some(t) = m.get("content").and_then(|x| x.as_str()) {
                    out.push_str(t);
                    out.push_str("\n\n");
                }
            }
        }
    };
    if let Ok(Value::Array(items)) = serde_json::from_str::<Value>(s) {
        for v in &items {
            push(v, &mut out);
        }
        return out;
    }
    for line in s.lines() {
        if let Ok(v) = serde_json::from_str::<Value>(line) {
            push(&v, &mut out);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn converts_jsonl_and_chat_records() {
        let t = jsonl_to_text("{\"text\":\"hello\"}\n{\"messages\":[{\"role\":\"user\",\"content\":\"hi\"},{\"role\":\"assistant\",\"content\":\"yo\"}]}\n");
        assert!(t.contains("hello") && t.contains("hi") && t.contains("yo"));
        assert!(chars_for_tokens(128 * 512) > 300_000);
    }
}
