//! ONNX pipeline: ONNX Runtime GenAI model builder (Engine A) or Optimum export + ORT
//! quantization (Engine B), followed by optional perplexity/KLD evaluation.

use super::artifacts;
use super::calib;
use super::parse::{self, BuilderEvent};
use super::recipe::{EvalSpec, OnnxRecipe, OnnxVariant};
use crate::error::{AppError, AppResult};
use crate::jobs::{JobCtx, Lane, NewJob, StageDef};
use crate::models::ModelRow;
use crate::process::Spawn;
use crate::state::AppState;
use crate::toolchain;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

fn builder_caps(st: &AppState) -> Value {
    toolchain::capability(st, "env_onnx", "caps")
        .map(|c| c["builder"].clone())
        .unwrap_or(Value::Null)
}

fn has_option(caps: &Value, key: &str) -> bool {
    caps["extra_option_keys"]
        .as_array()
        .map(|a| a.iter().any(|k| k.as_str() == Some(key)))
        .unwrap_or(true)
}

pub fn submit(st: &AppState, m: ModelRow, rec: OnnxRecipe, eval: EvalSpec) -> AppResult<String> {
    if !toolchain::is_installed(st, "env_onnx") {
        return Err(AppError::missing_tool("ONNX Runtime GenAI environment"));
    }
    if rec.variants.is_empty() {
        return Err(AppError::invalid("Add at least one ONNX variant"));
    }
    let caps = builder_caps(st);
    if let Some(err) = caps["error"].as_str() {
        if rec.engine == "builder" {
            return Err(AppError::new(
                "onnx",
                format!("The ONNX model builder could not be loaded: {err}"),
            )
            .with_hint("Repair the ONNX Runtime GenAI component in Environment."));
        }
    }
    let do_eval = eval.ppl || eval.kld;
    if do_eval && !toolchain::is_installed(st, "env_core") {
        return Err(AppError::missing_tool("Hub & data tools"));
    }
    let mut stages = vec![];
    for v in &rec.variants {
        stages.push(StageDef::new(
            &format!("build:{}", v.label()),
            format!("Build {}", v.label()),
            4.0,
        ));
    }
    if do_eval {
        stages.push(StageDef::new(
            "build:reference",
            "Build full-precision reference",
            2.0,
        ));
        stages.push(StageDef::new("eval:reference", "Measure the original", 1.0));
        for v in &rec.variants {
            stages.push(StageDef::new(
                &format!("eval:{}", v.label()),
                format!("Evaluate {}", v.label()),
                1.0,
            ));
        }
    }
    stages.push(StageDef::new("finalize", "Register outputs", 0.2));
    let title = format!(
        "ONNX · {} · {}",
        m.name,
        rec.variants
            .iter()
            .map(|v| v.label())
            .collect::<Vec<_>>()
            .join(", ")
    );
    let params = json!({ "recipe": { "format": "onnx", "onnx": rec, "eval": eval } });
    let st2 = st.clone();
    let mid = m.id.clone();
    st.jobs.submit(
        NewJob {
            kind: "quantize",
            title,
            model_id: Some(mid),
            format: Some("onnx".into()),
            params,
            stages,
            lane: Lane::Heavy,
        },
        move |ctx| async move { run(&st2, &ctx, &m, &rec, &eval).await },
    )
}

async fn run(
    st: &AppState,
    ctx: &JobCtx,
    m: &ModelRow,
    rec: &OnnxRecipe,
    eval: &EvalSpec,
) -> AppResult<Value> {
    let model_dir = PathBuf::from(&m.local_path);
    let name = super::slug(&m.name);
    let out_root = st.paths.outputs().join(&name).join("onnx");
    std::fs::create_dir_all(&out_root)?;
    let layers = crate::models::config::analyze(&m.config)
        .layers
        .unwrap_or(1);
    let genai_version = toolchain::capability(st, "env_onnx", "packages")
        .and_then(|p| p["onnxruntime-genai"].as_str().map(str::to_string));
    let mut produced: Vec<(String, String, PathBuf)> = vec![];
    for v in &rec.variants {
        let label = v.label();
        ctx.stage(&format!("build:{label}"))?;
        ctx.tensor(json!({ "t": "reset", "variant": label }));
        let out = out_root.join(format!("{}-ONNX-{}", m.name.replace(' ', "-"), label));
        if out.exists() {
            std::fs::remove_dir_all(&out)?;
        }
        let res = if rec.engine == "optimum" {
            optimum(st, ctx, &model_dir, &out, v, rec).await?
        } else {
            build(st, ctx, &model_dir, &out, v, layers).await?
        };
        let meta = json!({ "engine": rec.engine, "variant": v, "onnxruntime_genai": genai_version, "result": res, "source_repo": m.repo_id, "source_revision": m.revision });
        let id = artifacts::register(
            st,
            Some(&ctx.id),
            &m.id,
            "onnx",
            &label,
            "quantized",
            &out,
            m.params,
            meta,
        )?;
        ctx.log(format!(
            "✓ {label}: {}",
            crate::toolchain::download::human(crate::paths::dir_size(&out))
        ));
        produced.push((id, label, out));
    }

    let mut evals = serde_json::Map::new();
    if eval.ppl || eval.kld {
        // Same runtime, full precision: isolates the effect of quantization.
        let ep = rec
            .variants
            .first()
            .map(|v| v.ep.clone())
            .unwrap_or_else(|| "cpu".into());
        let ref_variant = OnnxVariant {
            precision: if ep == "cpu" {
                "fp32".into()
            } else {
                "fp16".into()
            },
            ep: ep.clone(),
            ..Default::default()
        };
        let ref_key = super::cache_key(&[
            "onnx-ref",
            &m.id,
            m.revision.as_deref().unwrap_or("local"),
            &ref_variant.label(),
            genai_version.as_deref().unwrap_or(""),
        ]);
        let ref_dir = match artifacts::cache_get(st, &ref_key) {
            Some(p) => {
                ctx.stage_cached("build:reference", &ref_variant.label());
                p
            }
            None => {
                ctx.stage("build:reference")?;
                let dir = st.paths.cache().join("onnx").join(&ref_key);
                build(st, ctx, &model_dir, &dir, &ref_variant, layers).await?;
                artifacts::cache_put(
                    st,
                    &ref_key,
                    "onnx_ref",
                    &dir,
                    json!({ "variant": ref_variant.label() }),
                )?;
                dir
            }
        };
        let reference_id = artifacts::register(
            st,
            Some(&ctx.id),
            &m.id,
            "onnx",
            &ref_variant.label(),
            "reference",
            &ref_dir,
            m.params,
            json!({ "variant": ref_variant }),
        )?;
        ctx.stage("eval:reference")?;
        let (text, text_meta) =
            calib::eval_text(st, ctx, eval.chunks as u64 * eval.ctx as u64).await?;
        let run_id = artifacts::new_eval_run(
            st,
            Some(&ctx.id),
            "kld",
            Some(&m.id),
            &json!({ "chunks": eval.chunks, "ctx": eval.ctx, "text": text_meta, "approximation": "top-64 + tail" }),
        )?;
        let npz_key = super::cache_key(&[
            "onnx-logits",
            &ref_key,
            text_meta["sha256"].as_str().unwrap_or(""),
            &eval.chunks.to_string(),
            &eval.ctx.to_string(),
        ]);
        let npz = st
            .paths
            .cache()
            .join("onnx")
            .join(format!("ref-{npz_key}.npz"));
        if artifacts::cache_get(st, &npz_key).is_none() {
            let r =
                super::mlx::logits_eval(st, ctx, "onnx", &ref_dir, &text, eval, "save_ref", &npz)
                    .await?;
            artifacts::cache_put(st, &npz_key, "onnx_logits", &npz, r.clone())?;
            artifacts::record(
                st,
                &run_id,
                &reference_id,
                None,
                &[("ppl", r["ppl"].as_f64())],
                &json!({}),
            )?;
        }
        for (id, label, out) in &produced {
            ctx.stage(&format!("eval:{label}"))?;
            match super::mlx::logits_eval(st, ctx, "onnx", out, &text, eval, "kld", &npz).await {
                Ok(r) => {
                    super::mlx::record_kld(st, &run_id, id, &reference_id, &r)?;
                    evals.insert(label.clone(), r);
                }
                Err(e) => ctx.log(format!("⚠ Could not evaluate {label}: {}", e.message)),
            }
        }
    }
    ctx.stage("finalize")?;
    st.hub
        .emit("artifacts:changed", json!({ "model_id": m.id }));
    Ok(
        json!({ "artifacts": produced.iter().map(|(id, l, p)| json!({ "id": id, "variant": l, "path": p, "eval": evals.get(l) })).collect::<Vec<_>>() }),
    )
}

fn extra_options(st: &AppState, v: &OnnxVariant) -> Vec<String> {
    let caps = builder_caps(st);
    let mut opts = vec![];
    if v.precision == "int4" || v.precision == "int8" {
        if has_option(&caps, "block_size") {
            opts.push(format!("block_size={}", v.block_size));
        }
        if has_option(&caps, "accuracy_level") {
            opts.push(format!("accuracy_level={}", v.accuracy_level));
        }
        if v.algo != "default" && has_option(&caps, "algo_config") {
            opts.push(format!("algo_config={}", v.algo));
        }
        if has_option(&caps, "is_symmetric") {
            opts.push(format!("is_symmetric={}", v.is_symmetric));
        }
        if v.head_int8 && v.precision == "int4" {
            if has_option(&caps, "matmul_mixed_precision") {
                opts.push("matmul_mixed_precision=last_matmul:int8".into());
            } else if has_option(&caps, "nodes_to_exclude") {
                opts.push("nodes_to_exclude=/lm_head/MatMul".into());
            }
        }
    }
    opts.push("hf_token=false".into());
    opts
}

async fn build(
    st: &AppState,
    ctx: &JobCtx,
    model_dir: &Path,
    out: &Path,
    v: &OnnxVariant,
    layers: u64,
) -> AppResult<Value> {
    let cache = st.paths.cache().join("onnx").join("builder-tmp");
    std::fs::create_dir_all(&cache)?;
    let opts = extra_options(st, v);
    let mut spec = Spawn::new(st.paths.env_python("onnx"))
        .args(["-u", "-I", "-m", "onnxruntime_genai.models.builder", "-i"])
        .arg(model_dir)
        .arg("-o")
        .arg(out)
        .args(["-p", v.precision.as_str(), "-e", v.ep.as_str(), "-c"])
        .arg(&cache)
        .arg("--extra_options")
        .args(opts.iter())
        .env("HF_HUB_OFFLINE", "1");
    for (k, val) in st.python_env(false) {
        spec = spec.env(&k, val);
    }
    let bits = match v.precision.as_str() {
        "int4" => 4.0 + 16.0 / v.block_size.max(16) as f64,
        "int8" => 8.5,
        "fp32" => 32.0,
        _ => 16.0,
    };
    let to = v.precision.to_uppercase();
    let total = layers.max(1) as f64;
    let quantizing = v.precision == "int4" || v.precision == "int8";
    let outcome = ctx
        .exec(&spec, |_, line| {
            for ev in parse::builder_events(line) {
                match ev {
                    BuilderEvent::Embedding => {
                        ctx.tensor(json!({ "t": "block", "block": "embed", "to": if v.ep == "cpu" { "FP32" } else { "FP16" }, "bits": if v.ep == "cpu" { 32 } else { 16 } }));
                        ctx.stage_progress(0.02, Some("Reading embedding layer".into()));
                    }
                    BuilderEvent::Layer(n) => {
                        ctx.tensor(json!({ "t": "block", "block": n, "to": to, "bits": bits }));
                        let read_share = if quantizing { 0.35 } else { 0.85 };
                        ctx.stage_progress(0.02 + read_share * (n as f64 + 1.0) / total, Some(format!("Layer {} of {}", n + 1, layers)));
                    }
                    BuilderEvent::LmHead => {
                        ctx.tensor(json!({ "t": "block", "block": "head", "to": if v.head_int8 { "INT8".to_string() } else { to.clone() }, "bits": if v.head_int8 { 8.5 } else { bits } }));
                    }
                    BuilderEvent::FinalNorm => {}
                    BuilderEvent::Quantizing(p) => ctx.stage_progress(0.4 + 0.5 * p, Some(format!("Quantizing weights {:.0}%", p * 100.0))),
                    BuilderEvent::Saving => ctx.stage_progress(0.95, Some("Saving ONNX model".into())),
                }
            }
        })
        .await?;
    outcome.ensure_success("ONNX model builder").map_err(|e| {
        if outcome
            .tail
            .iter()
            .any(|l| l.contains("is not currently supported") || l.contains("NotImplementedError"))
        {
            AppError::new(
                "unsupported",
                "The ONNX Runtime GenAI builder does not support this architecture",
            )
            .with_hint("Try the Optimum engine instead, or GGUF/MLX.")
        } else {
            e
        }
    })?;
    if !out.join("genai_config.json").exists() {
        return Err(AppError::new(
            "onnx",
            "The builder finished but genai_config.json is missing",
        ));
    }
    Ok(json!({ "extra_options": opts, "precision": v.precision, "ep": v.ep }))
}

async fn optimum(
    st: &AppState,
    ctx: &JobCtx,
    model_dir: &Path,
    out: &Path,
    v: &OnnxVariant,
    rec: &OnnxRecipe,
) -> AppResult<Value> {
    let mode = rec.optimum_mode.clone().unwrap_or_else(|| {
        if v.precision == "int8" {
            "int8_dynamic".into()
        } else {
            "int4_weight".into()
        }
    });
    let args = json!({
        "mode": mode, "model": model_dir, "out": out, "per_channel": rec.per_channel, "reduce_range": rec.reduce_range,
        "int4": { "algo": if v.algo == "default" { "rtn" } else { v.algo.as_str() }, "block_size": v.block_size, "is_symmetric": v.is_symmetric, "accuracy_level": v.accuracy_level },
    });
    let spec = crate::driver::spawn(st, "onnx", "onnx_quantize.py", &args, false)?;
    crate::driver::run(ctx, &spec, |_| {}).await
}
