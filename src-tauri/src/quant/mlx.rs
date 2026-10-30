//! MLX pipeline: mlx-lm conversion (with per-layer rules) or one of its calibration-based
//! methods (AWQ, GPTQ, DWQ, dynamic), followed by optional perplexity/KLD evaluation.

use super::artifacts;
use super::calib;
use super::parse;
use super::recipe::{CalibSpec, EvalSpec, MlxRecipe, MlxRule, MlxVariant};
use crate::error::{AppError, AppResult};
use crate::jobs::{JobCtx, Lane, NewJob, StageDef};
use crate::models::ModelRow;
use crate::process::Spawn;
use crate::state::AppState;
use crate::toolchain;
use regex::Regex;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

pub fn rule_regexes(rules: &[MlxRule]) -> Vec<(Regex, u32)> {
    rules
        .iter()
        .filter_map(|r| Some((Regex::new(&r.pattern).ok()?, r.bits)))
        .collect()
}

pub fn submit(
    st: &AppState,
    m: ModelRow,
    rec: MlxRecipe,
    calib_spec: CalibSpec,
    eval: EvalSpec,
) -> AppResult<String> {
    if !st.platform().mlx_supported {
        return Err(AppError::invalid("MLX needs a Mac with Apple Silicon."));
    }
    if !toolchain::is_installed(st, "env_mlx") {
        return Err(AppError::missing_tool("MLX environment"));
    }
    if rec.variants.is_empty() {
        return Err(AppError::invalid("Add at least one MLX variant"));
    }
    for r in &rec.rules {
        Regex::new(&r.pattern).map_err(|e| {
            AppError::invalid(format!("Rule pattern \"{}\" is invalid: {e}", r.pattern))
        })?;
    }
    if rec.method != "convert" {
        let caps = toolchain::capability(st, "env_mlx", "caps").unwrap_or(Value::Null);
        if !caps["methods"][&rec.method]["available"]
            .as_bool()
            .unwrap_or(false)
        {
            return Err(AppError::invalid(format!(
                "The installed mlx-lm does not provide {}",
                rec.method
            )));
        }
    }
    let do_eval = eval.ppl || eval.kld;
    if do_eval && !toolchain::is_installed(st, "env_core") {
        return Err(AppError::missing_tool("Hub & data tools"));
    }
    let mut stages = vec![];
    for v in &rec.variants {
        stages.push(StageDef::new(
            &format!("quantize:{}", v.label()),
            format!("Quantize {}", v.label()),
            3.0,
        ));
    }
    if do_eval {
        stages.push(StageDef::new("eval:reference", "Measure the original", 1.5));
        for v in &rec.variants {
            stages.push(StageDef::new(
                &format!("eval:{}", v.label()),
                format!("Evaluate {}", v.label()),
                1.0,
            ));
        }
    }
    stages.push(StageDef::new("finalize", "Index outputs", 0.2));
    let title = format!(
        "MLX · {} · {}",
        m.name,
        rec.variants
            .iter()
            .map(|v| v.label())
            .collect::<Vec<_>>()
            .join(", ")
    );
    let params = json!({ "recipe": { "format": "mlx", "mlx": rec, "calibration": calib_spec, "eval": eval } });
    let st2 = st.clone();
    let mid = m.id.clone();
    st.jobs.submit(
        NewJob {
            kind: "quantize",
            title,
            model_id: Some(mid),
            format: Some("mlx".into()),
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
    rec: &MlxRecipe,
    eval: &EvalSpec,
) -> AppResult<Value> {
    let model_dir = PathBuf::from(&m.local_path);
    let name = super::slug(&m.name);
    let out_root = st.paths.outputs().join(&name).join("mlx");
    std::fs::create_dir_all(&out_root)?;
    let mlx_version = toolchain::capability(st, "env_mlx", "packages")
        .and_then(|p| p["mlx-lm"].as_str().map(str::to_string));
    let reference_id = artifacts::register(
        st,
        Some(&ctx.id),
        &m.id,
        "mlx",
        &format!(
            "{} (original)",
            m.dtype
                .clone()
                .unwrap_or_else(|| "bf16".into())
                .to_lowercase()
        ),
        "reference",
        &model_dir,
        m.params,
        json!({ "note": "Original weights loaded directly by mlx-lm" }),
    )?;

    let mut produced: Vec<(String, String, PathBuf)> = vec![];
    for v in &rec.variants {
        let label = v.label();
        ctx.stage(&format!("quantize:{label}"))?;
        ctx.tensor(json!({ "t": "reset", "variant": label }));
        let out = out_root.join(format!("{}-MLX-{}", m.name.replace(' ', "-"), label));
        if out.exists() {
            std::fs::remove_dir_all(&out)?;
        }
        let res = if rec.method == "convert" {
            convert(st, ctx, &model_dir, &out, v, rec).await?
        } else {
            method(st, ctx, &model_dir, &out, v, rec).await?
        };
        let meta = json!({ "method": rec.method, "variant": v, "rules": rec.rules, "mlx_lm": mlx_version, "result": res, "source_repo": m.repo_id, "source_revision": m.revision });
        let id = artifacts::register(
            st,
            Some(&ctx.id),
            &m.id,
            "mlx",
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
        let key = super::cache_key(&[
            "mlx-ref",
            &m.id,
            m.revision.as_deref().unwrap_or("local"),
            text_meta["sha256"].as_str().unwrap_or(""),
            &eval.chunks.to_string(),
            &eval.ctx.to_string(),
        ]);
        let ref_path = st.paths.cache().join("mlx").join(format!("ref-{key}.npz"));
        if artifacts::cache_get(st, &key).is_none() {
            std::fs::create_dir_all(ref_path.parent().unwrap_or(Path::new(".")))?;
            let r = logits_eval(
                st, ctx, "mlx", &model_dir, &text, eval, "save_ref", &ref_path,
            )
            .await?;
            artifacts::cache_put(st, &key, "mlx_ref", &ref_path, r.clone())?;
            artifacts::record(
                st,
                &run_id,
                &reference_id,
                None,
                &[("ppl", r["ppl"].as_f64())],
                &json!({}),
            )?;
        } else {
            ctx.log("Reusing saved reference logits");
        }
        for (id, label, out) in &produced {
            ctx.stage(&format!("eval:{label}"))?;
            let r = logits_eval(st, ctx, "mlx", out, &text, eval, "kld", &ref_path).await?;
            record_kld(st, &run_id, id, &reference_id, &r)?;
            evals.insert(label.clone(), r);
        }
    }
    ctx.stage("finalize")?;
    for (id, _, out) in &produced {
        if let Err(e) = artifacts::index_tensors(st, id, out, "mlx") {
            ctx.log(format!("⚠ Could not index tensors: {}", e.message));
        }
    }
    st.hub
        .emit("artifacts:changed", json!({ "model_id": m.id }));
    Ok(
        json!({ "reference_id": reference_id, "artifacts": produced.iter().map(|(id, l, p)| json!({ "id": id, "variant": l, "path": p, "eval": evals.get(l) })).collect::<Vec<_>>() }),
    )
}

async fn convert(
    st: &AppState,
    ctx: &JobCtx,
    model_dir: &Path,
    out: &Path,
    v: &MlxVariant,
    rec: &MlxRecipe,
) -> AppResult<Value> {
    let rules: Vec<Value> = rec
        .rules
        .iter()
        .map(|r| if r.bits == 0 { json!({ "pattern": r.pattern, "skip": true }) } else { json!({ "pattern": r.pattern, "bits": r.bits, "group_size": r.group_size.unwrap_or(v.group_size) }) })
        .collect();
    let args = json!({
        "hf_path": model_dir, "mlx_path": out, "bits": v.bits, "group_size": v.group_size, "mode": v.mode,
        "dtype": v.dtype, "recipe": if v.mode == "affine" { v.recipe.clone() } else { None }, "rules": rules,
        "trust_remote_code": rec.trust_remote_code,
    });
    let spec = crate::driver::spawn(st, "mlx", "mlx_quantize.py", &args, false)?;
    crate::driver::run(ctx, &spec, |_| {}).await
}

/// AWQ / GPTQ / DWQ / dynamic quant via `python -m mlx_lm <method>` using only probed flags.
async fn method(
    st: &AppState,
    ctx: &JobCtx,
    model_dir: &Path,
    out: &Path,
    v: &MlxVariant,
    rec: &MlxRecipe,
) -> AppResult<Value> {
    let caps = toolchain::capability(st, "env_mlx", "caps").unwrap_or(Value::Null);
    let m = &caps["methods"][&rec.method];
    let flags: Vec<String> = m["flags"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|f| f.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    let has = |f: &str| flags.iter().any(|x| x == f);
    let module = m["module"].as_str().unwrap_or("mlx_lm").to_string();
    let mut spec = Spawn::new(st.paths.env_python("mlx"))
        .args(["-u", "-I", "-m"])
        .args(module.split_whitespace());
    spec = spec
        .arg(if has("--model") {
            "--model"
        } else {
            "--hf-path"
        })
        .arg(model_dir)
        .arg("--mlx-path")
        .arg(out);
    if has("--bits") {
        spec = spec.args(["--bits", &v.bits.to_string()]);
    }
    if has("--group-size") {
        spec = spec.args(["--group-size", &v.group_size.to_string()]);
    }
    if let (Some(n), true) = (rec.num_samples, has("--num-samples")) {
        spec = spec.args(["--num-samples", &n.to_string()]);
    }
    if let Some(s) = rec.sequence_length {
        if has("--sequence-length") {
            spec = spec.args(["--sequence-length", &s.to_string()]);
        } else if has("--max-seq-length") {
            spec = spec.args(["--max-seq-length", &s.to_string()]);
        }
    }
    if let (Some(b), true) = (rec.target_bpw, has("--target-bpw")) {
        spec = spec.args(["--target-bpw", &b.to_string()]);
    }
    if rec.trust_remote_code && has("--trust-remote-code") {
        spec = spec.arg("--trust-remote-code");
    }
    for (k, val) in st.python_env(true) {
        spec = spec.env(&k, val);
    }
    let outcome = ctx
        .exec(&spec, |_, line| {
            if let Some(p) = parse::tqdm_percent(line) {
                ctx.stage_progress(p, Some(line.chars().take(120).collect()));
            }
        })
        .await?;
    outcome.ensure_success(&format!("mlx_lm {}", rec.method))?;
    Ok(json!({ "method": rec.method, "module": module }))
}

#[allow(clippy::too_many_arguments)]
pub async fn logits_eval(
    st: &AppState,
    ctx: &JobCtx,
    backend: &str,
    model: &Path,
    text: &Path,
    eval: &EvalSpec,
    mode: &str,
    ref_path: &Path,
) -> AppResult<Value> {
    let args = json!({ "backend": backend, "model": model, "text_path": text, "ctx": eval.ctx, "chunks": eval.chunks, "mode": mode, "ref_path": ref_path, "top_k": 64, "use_ref_tokens": true });
    let spec = crate::driver::spawn(st, backend, "logits_eval.py", &args, false)?;
    crate::driver::run(ctx, &spec, |_| {}).await
}

pub fn record_kld(
    st: &AppState,
    run_id: &str,
    id: &str,
    reference_id: &str,
    r: &Value,
) -> AppResult<()> {
    artifacts::record(
        st,
        run_id,
        id,
        Some(reference_id),
        &[
            ("ppl", r["ppl"].as_f64()),
            ("ppl_base", r["ref_ppl"].as_f64()),
            ("kld_mean", r["kld_mean"].as_f64()),
            ("kld_median", r["kld_median"].as_f64()),
            ("kld_p99", r["kld_p99"].as_f64()),
            ("kld_max", r["kld_max"].as_f64()),
            ("top1", r["top1_agreement"].as_f64()),
            ("delta_p_mean", r["delta_p_mean"].as_f64()),
        ],
        &json!({ "approximation": r["approximation"] }),
    )
}
