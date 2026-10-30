//! Quantized outputs ("artifacts"), their per-tensor breakdown, evaluation results and the
//! cache of reusable intermediates (base GGUF, importance matrix, reference logits).

use crate::db::{json_col, new_id, now_ms};
use crate::error::{AppError, AppResult};
use crate::models::tensors;
use crate::state::AppState;
use rusqlite::OptionalExtension;
use serde::Serialize;
use serde_json::{json, Value};
use std::io::Read;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize)]
pub struct ArtifactRow {
    pub id: String,
    pub job_id: Option<String>,
    pub model_id: Option<String>,
    pub format: String,
    pub variant: String,
    pub role: String,
    pub path: String,
    pub size_bytes: Option<i64>,
    pub sha256: Option<String>,
    pub bpw: Option<f64>,
    pub meta: Value,
    pub created_at: i64,
    pub metrics: Value,
    pub exists: bool,
}

const SELECT: &str = "SELECT id, job_id, model_id, format, variant, role, path, size_bytes, sha256, bpw, meta_json, created_at FROM artifacts";

fn row(r: &rusqlite::Row) -> rusqlite::Result<ArtifactRow> {
    let path: String = r.get(6)?;
    Ok(ArtifactRow {
        id: r.get(0)?,
        job_id: r.get(1)?,
        model_id: r.get(2)?,
        format: r.get(3)?,
        variant: r.get(4)?,
        role: r.get(5)?,
        exists: Path::new(&path).exists(),
        path,
        size_bytes: r.get(7)?,
        sha256: r.get(8)?,
        bpw: r.get(9)?,
        meta: json_col(r.get(10)?),
        created_at: r.get(11)?,
        metrics: Value::Null,
    })
}

/// Latest value of each metric recorded for an artifact.
pub fn metrics(st: &AppState, id: &str) -> AppResult<Value> {
    let rows: Vec<(String, Option<f64>, Option<String>)> = st.db.with(|c| {
        let mut s = c.prepare("SELECT metric, value, reference_id FROM eval_results WHERE artifact_id = ?1 ORDER BY id")?;
        let r = s.query_map([id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?;
        r.collect()
    })?;
    let mut out = serde_json::Map::new();
    for (m, v, refid) in rows {
        out.insert(m, json!(v));
        if let Some(r) = refid {
            out.insert("reference_id".into(), json!(r));
        }
    }
    Ok(Value::Object(out))
}

pub fn list(st: &AppState, model_id: Option<&str>) -> AppResult<Vec<ArtifactRow>> {
    let mut rows = st.db.with(|c| {
        let mut s = c.prepare(&format!(
            "{SELECT} WHERE (?1 IS NULL OR model_id = ?1) ORDER BY created_at DESC"
        ))?;
        let r = s.query_map([model_id], row)?;
        r.collect::<Result<Vec<_>, _>>()
    })?;
    for a in rows.iter_mut() {
        a.metrics = metrics(st, &a.id)?;
    }
    Ok(rows)
}

pub fn get(st: &AppState, id: &str) -> AppResult<ArtifactRow> {
    let mut a = st
        .db
        .with(|c| {
            c.query_row(&format!("{SELECT} WHERE id = ?1"), [id], row)
                .optional()
        })?
        .ok_or_else(|| AppError::not_found("Artifact"))?;
    a.metrics = metrics(st, id)?;
    Ok(a)
}

pub fn find_by_path(st: &AppState, path: &Path) -> AppResult<Option<String>> {
    st.db.with(|c| {
        c.query_row(
            "SELECT id FROM artifacts WHERE path = ?1",
            [path.to_string_lossy()],
            |r| r.get(0),
        )
        .optional()
    })
}

fn size_of(path: &Path) -> u64 {
    crate::paths::dir_size(path)
}

/// GGUF shards: "x-00001-of-00003.gguf" → all sibling shard paths.
pub fn shard_paths(path: &Path) -> Vec<PathBuf> {
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    if let Some(idx) = name.find("-00001-of-") {
        let prefix = &name[..idx];
        if let Some(dir) = path.parent() {
            let mut v: Vec<PathBuf> = std::fs::read_dir(dir)
                .map(|rd| {
                    rd.flatten()
                        .map(|e| e.path())
                        .filter(|p| {
                            p.file_name()
                                .map(|n| n.to_string_lossy().starts_with(&format!("{prefix}-0")))
                                .unwrap_or(false)
                        })
                        .collect()
                })
                .unwrap_or_default();
            v.sort();
            return v;
        }
    }
    vec![path.to_path_buf()]
}

#[allow(clippy::too_many_arguments)]
pub fn register(
    st: &AppState,
    job_id: Option<&str>,
    model_id: &str,
    format: &str,
    variant: &str,
    role: &str,
    path: &Path,
    params: Option<i64>,
    meta: Value,
) -> AppResult<String> {
    let size: u64 = shard_paths(path).iter().map(|p| size_of(p)).sum();
    let bpw = params
        .filter(|p| *p > 0)
        .map(|p| size as f64 * 8.0 / p as f64);
    if let Some(existing) = find_by_path(st, path)? {
        st.db.with(|c| {
            c.execute(
                "UPDATE artifacts SET job_id = COALESCE(?1, job_id), size_bytes = ?2, bpw = ?3, meta_json = ?4, variant = ?5, role = ?6 WHERE id = ?7",
                rusqlite::params![job_id, size as i64, bpw, meta.to_string(), variant, role, existing],
            )
        })?;
        return Ok(existing);
    }
    let id = new_id();
    st.db.with(|c| {
        c.execute(
            "INSERT INTO artifacts (id, job_id, model_id, format, variant, role, path, size_bytes, bpw, meta_json, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
            rusqlite::params![id, job_id, model_id, format, variant, role, path.to_string_lossy(), size as i64, bpw, meta.to_string(), now_ms()],
        )
    })?;
    Ok(id)
}

/// Stores the per-tensor table (GGUF header or MLX safetensors) for an artifact.
pub fn index_tensors(st: &AppState, id: &str, path: &Path, format: &str) -> AppResult<usize> {
    let list = match format {
        "gguf" => tensors::read_gguf(path)?.tensors,
        "mlx" => mlx_tensors(path)?,
        _ => return Ok(0),
    };
    st.db.tx(|tx| {
        tx.execute("DELETE FROM artifact_tensors WHERE artifact_id = ?1", [id])?;
        let mut s = tx.prepare_cached("INSERT INTO artifact_tensors (artifact_id, idx, name, shape, dtype, n_elements, bytes) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)")?;
        for (i, t) in list.iter().enumerate() {
            s.execute(rusqlite::params![id, i as i64, t.name, serde_json::to_string(&t.shape).unwrap_or_default(), t.dtype, t.n_elements as i64, t.bytes as i64])?;
        }
        Ok(())
    })?;
    Ok(list.len())
}

/// MLX stores quantized weights as packed uint32 + scales/biases; fold those into one entry
/// per logical weight with its effective bits.
fn mlx_tensors(dir: &Path) -> AppResult<Vec<tensors::TensorInfo>> {
    let raw = tensors::read_safetensors_dir(dir)?;
    let cfg: Value = std::fs::read_to_string(dir.join("config.json"))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or(Value::Null);
    let default_bits = cfg["quantization"]["bits"].as_u64().unwrap_or(4);
    let mut out: Vec<tensors::TensorInfo> = vec![];
    let extra = |base: &str, suffix: &str| {
        raw.iter()
            .find(|t| t.name == format!("{base}.{suffix}"))
            .map(|t| t.bytes)
            .unwrap_or(0)
    };
    for t in &raw {
        if t.name.ends_with(".scales") || t.name.ends_with(".biases") {
            continue;
        }
        let base = t.name.trim_end_matches(".weight");
        let scales = extra(base, "scales");
        if t.dtype == "U32" && scales > 0 {
            let qcfg = &cfg["quantization"][base];
            let bits = qcfg["bits"].as_u64().unwrap_or(default_bits);
            let n = t.n_elements * 32 / bits.max(1);
            let bytes = t.bytes + scales + extra(base, "biases");
            let mut shape = t.shape.clone();
            if let Some(last) = shape.last_mut() {
                *last = *last * 32 / bits.max(1);
            }
            out.push(tensors::TensorInfo {
                name: t.name.clone(),
                shape,
                dtype: format!("Q{bits}"),
                n_elements: n,
                bytes,
                bits: bytes as f64 * 8.0 / n.max(1) as f64,
            });
        } else {
            out.push(t.clone());
        }
    }
    Ok(out)
}

pub fn tensors_of(st: &AppState, id: &str) -> AppResult<Vec<Value>> {
    st.db.with(|c| {
        let mut s = c.prepare("SELECT name, shape, dtype, n_elements, bytes FROM artifact_tensors WHERE artifact_id = ?1 ORDER BY idx")?;
        let r = s.query_map([id], |r| {
            let n: i64 = r.get(3)?;
            let b: i64 = r.get(4)?;
            Ok(json!({
                "name": r.get::<_, String>(0)?,
                "shape": serde_json::from_str::<Value>(&r.get::<_, String>(1)?).unwrap_or(Value::Null),
                "dtype": r.get::<_, String>(2)?,
                "n_elements": n,
                "bytes": b,
                "bits": if n > 0 { b as f64 * 8.0 / n as f64 } else { 0.0 },
            }))
        })?;
        r.collect()
    })
}

pub fn sha256_file(path: &Path) -> AppResult<String> {
    use sha2::{Digest, Sha256};
    let mut f = std::fs::File::open(path)?;
    let mut h = Sha256::new();
    let mut buf = vec![0u8; 4 << 20];
    loop {
        let n = f.read(&mut buf)?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
    }
    Ok(hex::encode(h.finalize()))
}

pub async fn finalize_hash(st: &AppState, id: &str) -> AppResult<()> {
    let a = get(st, id)?;
    let p = PathBuf::from(&a.path);
    if !p.is_file() {
        return Ok(());
    }
    let hash = tauri::async_runtime::spawn_blocking(move || sha256_file(&p))
        .await
        .map_err(|e| AppError::new("hash", e.to_string()))??;
    st.db.with(|c| {
        c.execute(
            "UPDATE artifacts SET sha256 = ?1 WHERE id = ?2",
            [&hash, id],
        )
    })?;
    Ok(())
}

pub fn delete(st: &AppState, id: &str, delete_files: bool) -> AppResult<()> {
    let a = get(st, id)?;
    if delete_files && a.role != "reference" {
        let p = PathBuf::from(&a.path);
        if p.starts_with(st.paths.outputs()) {
            for s in shard_paths(&p) {
                if s.is_dir() {
                    std::fs::remove_dir_all(&s)?;
                } else if s.exists() {
                    std::fs::remove_file(&s)?;
                }
            }
        }
    }
    st.db
        .with(|c| c.execute("DELETE FROM artifacts WHERE id = ?1", [id]))?;
    Ok(())
}

/* ---------------- evaluations ---------------- */

pub fn new_eval_run(
    st: &AppState,
    job_id: Option<&str>,
    kind: &str,
    model_id: Option<&str>,
    params: &Value,
) -> AppResult<String> {
    let id = new_id();
    st.db.with(|c| {
        c.execute(
            "INSERT INTO eval_runs (id, job_id, kind, model_id, params_json, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            rusqlite::params![id, job_id, kind, model_id, params.to_string(), now_ms()],
        )
    })?;
    Ok(id)
}

pub fn record(
    st: &AppState,
    run_id: &str,
    artifact_id: &str,
    reference_id: Option<&str>,
    values: &[(&str, Option<f64>)],
    detail: &Value,
) -> AppResult<()> {
    st.db.tx(|tx| {
        for (k, v) in values {
            if v.is_none() {
                continue;
            }
            tx.execute(
                "INSERT INTO eval_results (run_id, artifact_id, reference_id, metric, value, detail_json) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                rusqlite::params![run_id, artifact_id, reference_id, k, v, detail.to_string()],
            )?;
        }
        Ok(())
    })
}

/* ---------------- cache ---------------- */

pub fn cache_get(st: &AppState, key: &str) -> Option<PathBuf> {
    let p: Option<String> = st
        .db
        .with(|c| {
            c.query_row(
                "SELECT path FROM cache_entries WHERE key = ?1",
                [key],
                |r| r.get(0),
            )
            .optional()
        })
        .ok()
        .flatten();
    let p = PathBuf::from(p?);
    if p.exists() {
        let _ = st.db.with(|c| {
            c.execute(
                "UPDATE cache_entries SET last_used_at = ?1 WHERE key = ?2",
                rusqlite::params![now_ms(), key],
            )
        });
        Some(p)
    } else {
        let _ = st
            .db
            .with(|c| c.execute("DELETE FROM cache_entries WHERE key = ?1", [key]));
        None
    }
}

pub fn cache_put(st: &AppState, key: &str, kind: &str, path: &Path, meta: Value) -> AppResult<()> {
    let ts = now_ms();
    st.db.with(|c| {
        c.execute(
            "INSERT INTO cache_entries (key, kind, path, size_bytes, meta_json, created_at, last_used_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)
             ON CONFLICT(key) DO UPDATE SET path = excluded.path, size_bytes = excluded.size_bytes, meta_json = excluded.meta_json, last_used_at = excluded.last_used_at",
            rusqlite::params![key, kind, path.to_string_lossy(), size_of(path) as i64, meta.to_string(), ts],
        )
    })?;
    Ok(())
}

pub fn cache_list(st: &AppState) -> AppResult<Vec<Value>> {
    st.db.with(|c| {
        let mut s = c.prepare("SELECT key, kind, path, size_bytes, last_used_at FROM cache_entries ORDER BY last_used_at DESC")?;
        let r = s.query_map([], |r| Ok(json!({ "key": r.get::<_, String>(0)?, "kind": r.get::<_, String>(1)?, "path": r.get::<_, String>(2)?, "size_bytes": r.get::<_, Option<i64>>(3)?, "last_used_at": r.get::<_, i64>(4)? })))?;
        r.collect()
    })
}

pub fn cache_clear(st: &AppState) -> AppResult<u64> {
    let entries = cache_list(st)?;
    let referenced: Vec<String> = st.db.with(|c| {
        let mut s = c.prepare("SELECT path FROM artifacts WHERE role = 'reference'")?;
        let r = s.query_map([], |r| r.get(0))?;
        r.collect()
    })?;
    let mut freed = 0;
    for e in entries {
        let p = e["path"].as_str().unwrap_or_default().to_string();
        if referenced.contains(&p) {
            continue;
        }
        let pb = PathBuf::from(&p);
        freed += size_of(&pb);
        if pb.is_dir() {
            let _ = std::fs::remove_dir_all(&pb);
        } else {
            let _ = std::fs::remove_file(&pb);
        }
        st.db.with(|c| {
            c.execute(
                "DELETE FROM cache_entries WHERE key = ?1",
                [e["key"].as_str().unwrap_or_default()],
            )
        })?;
    }
    Ok(freed)
}
