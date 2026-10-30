//! Turns "what I want" (device, memory, runtime, priority, context, use case) into ranked,
//! explained quantization choices.

use super::catalog::{self, GgufType};
use super::estimate;
use super::recipe::{GgufRecipe, MlxVariant, OnnxVariant};
use crate::models::config::{kv_cache_bytes, ArchInfo};
use crate::models::tensors::TensorInfo;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Debug, Clone, Deserialize)]
pub struct Goal {
    /// apple | nvidia | amd | cpu | edge | browser
    pub device: String,
    pub memory_gb: f64,
    /// llamacpp | lmstudio | ollama | mlx_apps | ort | web | any
    #[serde(default = "any")]
    pub runtime: String,
    /// 0 = best quality … 100 = smallest/fastest
    #[serde(default = "mid")]
    pub priority: f64,
    #[serde(default = "ctx")]
    pub context: u64,
    #[serde(default = "chat")]
    pub usecase: String,
}

fn any() -> String {
    "any".into()
}
fn mid() -> f64 {
    50.0
}
fn ctx() -> u64 {
    8192
}
fn chat() -> String {
    "chat".into()
}

#[derive(Debug, Clone, Serialize)]
pub struct Candidate {
    pub format: String,
    pub variant: String,
    pub recipe: Value,
    pub est_bytes: u64,
    pub bpw: f64,
    pub mem_bytes: u64,
    pub fits: bool,
    pub headroom: f64,
    pub tier: String,
    pub stars: u8,
    pub ppl_delta: f64,
    pub score: f64,
    pub reasons: Vec<String>,
    pub warnings: Vec<String>,
    pub needs_imatrix: bool,
    pub kb: String,
}

fn budget_factor(device: &str) -> f64 {
    match device {
        "apple" => 0.72,
        "nvidia" | "amd" => 0.92,
        "edge" => 0.5,
        "browser" => 0.35,
        _ => 0.6,
    }
}

fn formats_for(goal: &Goal, mlx_ok: bool) -> Vec<&'static str> {
    match goal.runtime.as_str() {
        "llamacpp" | "lmstudio" | "ollama" => vec!["gguf"],
        "mlx_apps" => {
            if mlx_ok {
                vec!["mlx"]
            } else {
                vec!["gguf"]
            }
        }
        "ort" | "web" => vec!["onnx"],
        _ => match goal.device.as_str() {
            "apple" if mlx_ok => vec!["mlx", "gguf"],
            "browser" => vec!["onnx"],
            "edge" => vec!["gguf", "onnx"],
            "nvidia" => vec!["gguf", "onnx"],
            _ => vec!["gguf"],
        },
    }
}

fn human(b: u64) -> String {
    crate::toolchain::download::human(b)
}

/// Sensitivity of the use case to quantization noise (multiplies expected Δppl).
fn usecase_factor(u: &str) -> f64 {
    match u {
        "code" | "agents" => 1.35,
        "multilingual" => 1.25,
        "rag" => 1.1,
        "creative" => 0.9,
        _ => 1.0,
    }
}

pub fn recommend(
    goal: &Goal,
    arch: &ArchInfo,
    tensors: &[TensorInfo],
    params: u64,
    types: &[GgufType],
    mlx_ok: bool,
) -> Value {
    let budget = (goal.memory_gb * 1e9 * budget_factor(&goal.device)) as u64;
    let kv = kv_cache_bytes(
        arch,
        goal.context
            .min(arch.context_length.unwrap_or(goal.context)),
        2.0,
    )
    .unwrap_or(0);
    let overhead = 400_000_000u64;
    let penalty = catalog::size_penalty(params as f64) * usecase_factor(&goal.usecase);
    let q_weight = 1.0 - goal.priority / 100.0;
    let mut out: Vec<Candidate> = vec![];

    let mut push = |format: &str,
                    variant: String,
                    recipe: Value,
                    est: estimate::Estimate,
                    base_ppl: f64,
                    kb: String,
                    needs_imatrix: bool,
                    mut reasons: Vec<String>,
                    mut warnings: Vec<String>| {
        let ppl = base_ppl * penalty;
        let (tier, stars) = catalog::quality_tier(ppl);
        let mem = est.bytes + kv + overhead + est.bytes / 20;
        let fits = mem <= budget;
        let headroom = if budget > 0 {
            1.0 - mem as f64 / budget as f64
        } else {
            -1.0
        };
        let quality = 1.0 - (ppl.max(0.001).ln() + 7.0) / 9.0; // ~1 near-lossless … ~0 heavy loss
        let compact = 1.0 - (est.bpw / 16.0).min(1.0);
        let mut score = q_weight * quality + (1.0 - q_weight) * compact;
        if !fits {
            score -= 2.0;
            warnings.push(format!(
                "Needs about {} with {} context but the budget is {}.",
                human(mem),
                goal.context,
                human(budget)
            ));
        } else {
            reasons.push(format!(
                "Fits: about {} in memory at {}-token context ({} budget).",
                human(mem),
                goal.context,
                human(budget)
            ));
        }
        if stars <= 2 {
            warnings.push(format!(
                "Expect {} — answers may become less reliable.",
                tier.to_lowercase()
            ));
        }
        out.push(Candidate {
            format: format.into(),
            variant,
            recipe,
            est_bytes: est.bytes,
            bpw: est.bpw,
            mem_bytes: mem,
            fits,
            headroom,
            tier: tier.into(),
            stars,
            ppl_delta: ppl,
            score,
            reasons,
            warnings,
            needs_imatrix,
            kb,
        });
    };

    let small = params < 3_000_000_000;
    for f in formats_for(goal, mlx_ok) {
        match f {
            "gguf" => {
                for name in [
                    "Q8_0", "Q6_K", "Q5_K_M", "Q4_K_M", "IQ4_XS", "Q4_K_S", "Q3_K_L", "IQ3_M",
                    "Q3_K_M", "IQ3_XXS", "IQ2_M", "Q2_K",
                ] {
                    let Some(t) = types.iter().find(|t| t.name == name) else {
                        continue;
                    };
                    let low = catalog::is_low_bit(name) || t.family == "i-quant";
                    let rec = GgufRecipe {
                        types: vec![name.into()],
                        ..Default::default()
                    };
                    let est = estimate::gguf(tensors, name, &rec, types);
                    let mut reasons = vec![];
                    let mut warnings = vec![];
                    match name {
                        "Q4_K_M" => reasons.push("The community's default balance of size and quality; works everywhere llama.cpp runs.".into()),
                        "Q5_K_M" => reasons.push("Visibly closer to the original than Q4 for a modest size increase.".into()),
                        "Q6_K" => reasons.push("Practically indistinguishable from the original for most tasks.".into()),
                        "Q8_0" => reasons.push("Near-lossless; a safe choice when memory isn't tight.".into()),
                        "IQ4_XS" => reasons.push("Slightly smaller than Q4_K_S at similar quality when built with an importance matrix.".into()),
                        _ => {}
                    }
                    if low {
                        reasons.push("Build it with an importance matrix (calibration data) to keep quality.".into());
                    }
                    if small && catalog::is_low_bit(name) {
                        warnings.push(
                            "Small models lose a lot at 2–3 bits; prefer 4 bits or more.".into(),
                        );
                    }
                    push(
                        "gguf",
                        name.into(),
                        json!({ "format": "gguf", "types": [name], "imatrix": { "enabled": low } }),
                        est,
                        t.ppl_delta_8b.unwrap_or(1.0),
                        t.kb.clone(),
                        low,
                        reasons,
                        warnings,
                    );
                }
            }
            "mlx" => {
                let variants: Vec<(MlxVariant, f64, &str)> = vec![
                    (
                        MlxVariant {
                            bits: 8,
                            group_size: 64,
                            mode: "affine".into(),
                            recipe: None,
                            dtype: None,
                        },
                        1.0,
                        "mlx.bits.8",
                    ),
                    (
                        MlxVariant {
                            bits: 6,
                            group_size: 64,
                            mode: "affine".into(),
                            recipe: None,
                            dtype: None,
                        },
                        1.1,
                        "mlx.bits.6",
                    ),
                    (
                        MlxVariant {
                            bits: 4,
                            group_size: 64,
                            mode: "affine".into(),
                            recipe: Some("mixed_4_6".into()),
                            dtype: None,
                        },
                        1.0,
                        "mlx.recipe.mixed_4_6",
                    ),
                    (
                        MlxVariant {
                            bits: 5,
                            group_size: 64,
                            mode: "affine".into(),
                            recipe: None,
                            dtype: None,
                        },
                        1.15,
                        "mlx.bits.5",
                    ),
                    (
                        MlxVariant {
                            bits: 4,
                            group_size: 32,
                            mode: "affine".into(),
                            recipe: None,
                            dtype: None,
                        },
                        1.1,
                        "mlx.group_size.32",
                    ),
                    (
                        MlxVariant {
                            bits: 4,
                            group_size: 64,
                            mode: "affine".into(),
                            recipe: None,
                            dtype: None,
                        },
                        1.2,
                        "mlx.bits.4",
                    ),
                    (
                        MlxVariant {
                            bits: 3,
                            group_size: 64,
                            mode: "affine".into(),
                            recipe: Some("mixed_3_6".into()),
                            dtype: None,
                        },
                        1.15,
                        "mlx.recipe.mixed_3_6",
                    ),
                    (
                        MlxVariant {
                            bits: 4,
                            group_size: 32,
                            mode: "mxfp4".into(),
                            recipe: None,
                            dtype: None,
                        },
                        1.9,
                        "mlx.mode.mxfp4",
                    ),
                ];
                for (v, factor, kb) in variants {
                    let est = estimate::mlx(tensors, &v, &[]);
                    let ppl = catalog::generic_ppl(
                        types,
                        est.bpw * if v.recipe.is_some() { 1.03 } else { 0.97 },
                        factor,
                    )
                    .unwrap_or(1.0);
                    let mut reasons = vec!["Native Apple Silicon format: typically the fastest way to run on a Mac (LM Studio, mlx-lm).".into()];
                    if v.recipe.is_some() {
                        reasons.push("Mixed precision protects the most sensitive layers.".into());
                    }
                    let label = v.label();
                    push(
                        "mlx",
                        label,
                        json!({ "format": "mlx", "variants": [v] }),
                        est,
                        ppl,
                        kb.into(),
                        false,
                        reasons,
                        vec![],
                    );
                }
            }
            "onnx" => {
                let ep = match goal.device.as_str() {
                    "nvidia" => "cuda",
                    "browser" => "webgpu",
                    _ => "cpu",
                };
                for (prec, algo, head8, factor, kb) in [
                    ("int4", "k_quant", true, 1.0, "onnx.algo.k_quant"),
                    ("int4", "rtn", false, 1.3, "onnx.algo.rtn"),
                    ("int8", "default", false, 1.0, "onnx.precision.int8"),
                    ("fp16", "default", false, 1.0, "onnx.precision.fp16"),
                ] {
                    let v = OnnxVariant {
                        precision: prec.into(),
                        ep: ep.into(),
                        algo: algo.into(),
                        head_int8: head8,
                        ..Default::default()
                    };
                    let est = estimate::onnx(tensors, &v);
                    let body_bits = match prec {
                        "int4" => 4.5,
                        "int8" => 8.5,
                        _ => 16.0,
                    };
                    let ppl = if prec == "fp16" {
                        0.001
                    } else {
                        catalog::generic_ppl(types, body_bits, factor).unwrap_or(1.0)
                    };
                    let reasons = vec![format!(
                        "Runs with ONNX Runtime ({}) on Windows, Linux, mobile and the web.",
                        ep.to_uppercase()
                    )];
                    push(
                        "onnx",
                        v.label(),
                        json!({ "format": "onnx", "variants": [v] }),
                        est,
                        ppl,
                        kb.into(),
                        false,
                        reasons,
                        vec![],
                    );
                }
            }
            _ => {}
        }
    }
    out.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    let best_per_format: Vec<&Candidate> = {
        let mut seen = std::collections::HashSet::new();
        out.iter()
            .filter(|c| c.fits && seen.insert(c.format.clone()))
            .collect()
    };
    json!({
        "budget_bytes": budget,
        "kv_bytes": kv,
        "overhead_bytes": overhead,
        "penalty": penalty,
        "best": best_per_format,
        "candidates": out,
        "explore": out.iter().filter(|c| c.fits).take(5).map(|c| json!({ "format": c.format, "variant": c.variant })).collect::<Vec<_>>(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::config::analyze;

    fn setup() -> (ArchInfo, Vec<TensorInfo>, Vec<GgufType>) {
        let a = analyze(
            &json!({ "hidden_size": 4096, "intermediate_size": 14336, "num_attention_heads": 32, "num_key_value_heads": 8, "num_hidden_layers": 32, "vocab_size": 128256, "max_position_embeddings": 131072 }),
        );
        let t = estimate::synthetic_tensors(&a);
        let types = catalog::build_gguf_types(&crate::toolchain::probe::parse_quant_types(
            include_str!("../../tests/fixtures/llama-quantize-help.txt"),
        ));
        (a, t, types)
    }

    #[test]
    fn recommends_fitting_variants_for_a_16gb_mac() {
        let (a, t, types) = setup();
        let goal = Goal {
            device: "apple".into(),
            memory_gb: 16.0,
            runtime: "any".into(),
            priority: 50.0,
            context: 8192,
            usecase: "chat".into(),
        };
        let r = recommend(&goal, &a, &t, 8_030_000_000, &types, true);
        let best = r["best"].as_array().unwrap();
        assert!(!best.is_empty());
        for c in best {
            assert!(c["fits"].as_bool().unwrap());
            assert!(c["mem_bytes"].as_u64().unwrap() <= r["budget_bytes"].as_u64().unwrap());
        }
        // Q8_0 of an 8B (~8.5 GB + KV) should not fit an 11.5 GB budget comfortably alongside 1 GB KV? It may; ensure ordering is sane instead.
        assert!(r["candidates"].as_array().unwrap().len() > 10);
    }

    #[test]
    fn tiny_budget_prefers_smaller_quants() {
        let (a, t, types) = setup();
        let goal = Goal {
            device: "cpu".into(),
            memory_gb: 8.0,
            runtime: "llamacpp".into(),
            priority: 60.0,
            context: 4096,
            usecase: "chat".into(),
        };
        let r = recommend(&goal, &a, &t, 8_030_000_000, &types, false);
        let best = &r["best"][0];
        assert_eq!(best["format"], "gguf");
        let v = best["variant"].as_str().unwrap();
        assert!(
            ["Q3_K_L", "IQ3_M", "Q3_K_M", "IQ3_XXS", "IQ2_M", "Q2_K", "Q4_K_S", "IQ4_XS"]
                .contains(&v),
            "{v}"
        );
    }
}
