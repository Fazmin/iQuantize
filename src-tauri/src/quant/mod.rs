//! Quantization: catalog, estimates, recommendations and the per-format pipelines.

pub mod artifacts;
pub mod calib;
pub mod catalog;
pub mod estimate;
pub mod gguf;
pub mod mlx;
pub mod onnx;
pub mod parse;
pub mod recipe;
pub mod recommend;

use crate::error::{AppError, AppResult};
use crate::models::{self, tensors::TensorInfo};
use crate::state::AppState;
use recipe::Recipe;
use serde_json::{json, Value};
use std::path::Path;

/// Tensor list for estimates: real headers if downloaded, otherwise synthetic from config.
pub fn tensors_for(
    st: &AppState,
    model_id: &str,
) -> AppResult<(models::ModelRow, Vec<TensorInfo>)> {
    let m = models::get(st, model_id)?;
    let mut tensors =
        models::tensors::read_safetensors_dir(Path::new(&m.local_path)).unwrap_or_default();
    if tensors.is_empty() {
        tensors = estimate::synthetic_tensors(&models::config::analyze(&m.config));
    }
    Ok((m, tensors))
}

/// Static + probed option catalog for the wizard.
pub fn catalog_json(st: &AppState) -> Value {
    let caps = crate::toolchain::capabilities(st).unwrap_or(Value::Null);
    let p = st.platform();
    let mut eps = vec!["cpu"];
    if p.accelerators.iter().any(|a| a == "cuda") {
        eps.push("cuda");
    }
    eps.push("webgpu");
    if p.os == "windows" {
        eps.push("dml");
    }
    json!({
        "gguf": {
            "types": catalog::gguf_types(st),
            "flags": caps["llama_cpp"]["quantize_flags"],
            "outtypes": caps["env_gguf"]["caps"]["outtypes"],
        },
        "mlx": {
            "supported": p.mlx_supported,
            "convert": caps["env_mlx"]["caps"]["convert"],
            "methods": caps["env_mlx"]["caps"]["methods"],
        },
        "onnx": {
            "builder": caps["env_onnx"]["caps"]["builder"],
            "execution_providers": eps,
            "optimum": caps["env_onnx"]["caps"]["optimum"],
        },
        "installed": {
            "gguf": crate::toolchain::is_installed(st, "llama_cpp") && crate::toolchain::is_installed(st, "env_gguf"),
            "mlx": crate::toolchain::is_installed(st, "env_mlx"),
            "onnx": crate::toolchain::is_installed(st, "env_onnx"),
            "core": crate::toolchain::is_installed(st, "env_core"),
        },
        "memory_budget": crate::platform::memory_budget(&p),
    })
}

/// Size estimates for every variant in a recipe.
pub fn estimate_json(st: &AppState, model_id: &str, recipe: &Recipe) -> AppResult<Value> {
    let (m, tensors) = tensors_for(st, model_id)?;
    let types = catalog::gguf_types(st);
    let arch = models::config::analyze(&m.config);
    let params = m.params.unwrap_or(0) as f64;
    let penalty = catalog::size_penalty(params);
    let mut items = vec![];
    match recipe {
        Recipe::Gguf { gguf, .. } => {
            for t in &gguf.types {
                let e = estimate::gguf(&tensors, t, gguf, &types);
                let ppl = types
                    .iter()
                    .find(|x| &x.name == t)
                    .and_then(|x| x.ppl_delta_8b)
                    .map(|p| p * penalty);
                items.push(json!({ "variant": t, "estimate": e, "ppl_delta": ppl, "tier": ppl.map(|p| catalog::quality_tier(p).0) }));
            }
        }
        Recipe::Mlx { mlx, .. } => {
            let rules = mlx::rule_regexes(&mlx.rules);
            for v in &mlx.variants {
                let e = estimate::mlx(&tensors, v, &rules);
                let ppl = catalog::generic_ppl(
                    &types,
                    e.bpw,
                    if v.mode == "affine" { 1.15 } else { 1.9 },
                )
                .map(|p| p * penalty);
                items.push(json!({ "variant": v.label(), "estimate": e, "ppl_delta": ppl, "tier": ppl.map(|p| catalog::quality_tier(p).0) }));
            }
        }
        Recipe::Onnx { onnx, .. } => {
            for v in &onnx.variants {
                let e = estimate::onnx(&tensors, v);
                let body = match v.precision.as_str() {
                    "int4" => 4.5,
                    "int8" => 8.5,
                    _ => 16.0,
                };
                let ppl = if body >= 16.0 {
                    Some(0.0)
                } else {
                    catalog::generic_ppl(
                        &types,
                        body,
                        if v.algo == "rtn" || v.algo == "default" {
                            1.3
                        } else {
                            1.0
                        },
                    )
                    .map(|p| p * penalty)
                };
                items.push(json!({ "variant": v.label(), "estimate": e, "ppl_delta": ppl, "tier": ppl.map(|p| catalog::quality_tier(p).0) }));
            }
        }
    }
    Ok(json!({
        "items": items,
        "source_bytes": tensors.iter().map(|t| t.bytes).sum::<u64>(),
        "params": m.params,
        "kv_8k": models::config::kv_cache_bytes(&arch, 8192, 2.0),
        "row_widths": row_widths(&tensors),
    }))
}

/// Distinct row widths not divisible by 256 (k-quant fallback warning).
fn row_widths(tensors: &[TensorInfo]) -> Value {
    let mut odd: Vec<u64> = tensors
        .iter()
        .filter(|t| t.shape.len() == 2)
        .filter_map(|t| t.shape.last().copied())
        .filter(|w| w % 256 != 0)
        .collect();
    odd.sort();
    odd.dedup();
    json!({ "not_256_aligned": odd })
}

pub fn recommend_json(st: &AppState, model_id: &str, goal: &recommend::Goal) -> AppResult<Value> {
    let (m, tensors) = tensors_for(st, model_id)?;
    let arch = models::config::analyze(&m.config);
    let types = catalog::gguf_types(st);
    let mlx_ok = st.platform().mlx_supported;
    Ok(recommend::recommend(
        goal,
        &arch,
        &tensors,
        m.params.unwrap_or(0) as u64,
        &types,
        mlx_ok,
    ))
}

/// Starts a quantization job for one format.
pub fn submit(st: &AppState, model_id: &str, recipe: Recipe) -> AppResult<String> {
    let m = models::get(st, model_id)?;
    if m.status != "ready" {
        return Err(AppError::invalid(
            "This model isn't ready yet (still downloading or failed).",
        ));
    }
    match recipe {
        Recipe::Gguf {
            gguf,
            calibration,
            eval,
        } => gguf::submit(st, m, gguf, calibration, eval),
        Recipe::Mlx {
            mlx,
            calibration,
            eval,
        } => mlx::submit(st, m, mlx, calibration, eval),
        Recipe::Onnx { onnx, eval } => onnx::submit(st, m, onnx, eval),
    }
}

/// Short, filesystem-safe name.
pub fn slug(s: &str) -> String {
    s.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '.' || c == '_' {
                c
            } else {
                '-'
            }
        })
        .collect::<String>()
        .trim_matches('-')
        .to_string()
}

/// Stable cache key from parts.
pub fn cache_key(parts: &[&str]) -> String {
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    for p in parts {
        h.update(p.as_bytes());
        h.update([0u8]);
    }
    hex::encode(h.finalize())[..16].to_string()
}
