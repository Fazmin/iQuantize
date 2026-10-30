//! GGUF pipeline: convert → (calibration → importance matrix) → quantize ×N → evaluate.
//! Intermediates are cached so re-runs and extra variants skip finished work.

use super::artifacts;
use super::calib;
use super::catalog;
use super::parse;
use super::recipe::{CalibSpec, EvalSpec, GgufRecipe};
use crate::error::{AppError, AppResult};
use crate::jobs::{JobCtx, Lane, NewJob, StageDef};
use crate::models::ModelRow;
use crate::process::{Spawn, Stream};
use crate::state::AppState;
use crate::toolchain;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

pub fn gpu_args(st: &AppState) -> Vec<String> {
    match toolchain::llama_accel(st).as_str() {
        "cpu" => vec![],
        _ => vec!["-ngl".into(), "99".into()],
    }
}

pub fn thread_args(st: &AppState) -> Vec<String> {
    match st.setting_or("threads", "0").parse::<u32>().unwrap_or(0) {
        0 => vec![],
        n => vec!["-t".into(), n.to_string()],
    }
}

fn require_tools(st: &AppState, needs_core: bool) -> AppResult<()> {
    if !toolchain::is_installed(st, "llama_cpp") {
        return Err(AppError::missing_tool("llama.cpp tools"));
    }
    if !toolchain::is_installed(st, "env_gguf") {
        return Err(AppError::missing_tool("GGUF converter"));
    }
    if needs_core && !toolchain::is_installed(st, "env_core") {
        return Err(AppError::missing_tool("Hub & data tools"));
    }
    Ok(())
}

pub fn submit(
    st: &AppState,
    m: ModelRow,
    mut rec: GgufRecipe,
    calib_spec: CalibSpec,
    eval: EvalSpec,
) -> AppResult<String> {
    rec.types.retain(|t| !t.trim().is_empty());
    rec.types.dedup();
    if rec.types.is_empty() {
        return Err(AppError::invalid("Pick at least one quantization type"));
    }
    let known: Vec<String> = catalog::gguf_types(st)
        .into_iter()
        .map(|t| t.name)
        .collect();
    if let Some(bad) = rec
        .types
        .iter()
        .find(|t| !known.iter().any(|k| k.eq_ignore_ascii_case(t)))
    {
        return Err(AppError::invalid(format!(
            "{bad} is not supported by the installed llama.cpp"
        )));
    }
    let forced: Vec<&String> = rec
        .types
        .iter()
        .filter(|t| catalog::requires_imatrix(t))
        .collect();
    let need_imatrix = rec.imatrix.enabled || !forced.is_empty();
    let do_eval = eval.ppl || eval.kld;
    require_tools(st, need_imatrix || do_eval)?;

    let mut stages = vec![StageDef::new("convert", "Convert to GGUF", 3.0)];
    if need_imatrix {
        stages.push(StageDef::new(
            "calibration",
            "Prepare calibration text",
            0.5,
        ));
        stages.push(StageDef::new("imatrix", "Compute importance matrix", 3.0));
    }
    for t in &rec.types {
        stages.push(StageDef::new(
            &format!("quantize:{t}"),
            format!("Quantize {t}"),
            2.0,
        ));
    }
    if do_eval {
        stages.push(StageDef::new("eval:reference", "Measure the original", 1.0));
        for t in &rec.types {
            stages.push(StageDef::new(
                &format!("eval:{t}"),
                format!("Evaluate {t}"),
                1.0,
            ));
        }
    }
    stages.push(StageDef::new("finalize", "Index and checksum outputs", 0.3));
    if rec.imatrix.enabled != need_imatrix {
        rec.imatrix.enabled = true;
    }
    let params = json!({ "recipe": { "format": "gguf", "gguf": rec, "calibration": calib_spec, "eval": eval }, "forced_imatrix": forced });
    let title = format!("GGUF · {} · {}", m.name, rec.types.join(", "));
    let st2 = st.clone();
    let model_id = m.id.clone();
    st.jobs.submit(
        NewJob {
            kind: "quantize",
            title,
            model_id: Some(model_id),
            format: Some("gguf".into()),
            params,
            stages,
            lane: Lane::Heavy,
        },
        move |ctx| async move { run(&st2, &ctx, &m, &rec, &calib_spec, &eval).await },
    )
}

async fn run(
    st: &AppState,
    ctx: &JobCtx,
    m: &ModelRow,
    rec: &GgufRecipe,
    calib_spec: &CalibSpec,
    eval: &EvalSpec,
) -> AppResult<Value> {
    let model_dir = PathBuf::from(&m.local_path);
    if !model_dir.join("config.json").exists() {
        return Err(AppError::not_found(format!(
            "Model folder {}",
            model_dir.display()
        )));
    }
    let name = super::slug(&m.name);
    let out_dir = st.paths.outputs().join(&name).join("gguf");
    std::fs::create_dir_all(&out_dir)?;
    let tag = toolchain::MANIFEST.llama_cpp.tag.clone();

    // 1. Convert to a full-precision GGUF (cached).
    let base_key = super::cache_key(&[
        "gguf-base",
        &m.id,
        m.revision.as_deref().unwrap_or("local"),
        &rec.base,
        &tag,
    ]);
    let base_path = match artifacts::cache_get(st, &base_key) {
        Some(p) => {
            ctx.stage_cached(
                "convert",
                &p.file_name()
                    .map(|n| n.to_string_lossy().to_string())
                    .unwrap_or_default(),
            );
            p
        }
        None => {
            ctx.stage("convert")?;
            let p = convert(
                st,
                ctx,
                m,
                &model_dir,
                &rec.base,
                rec.use_temp_file,
                &base_key,
            )
            .await?;
            artifacts::cache_put(
                st,
                &base_key,
                "base_gguf",
                &p,
                json!({ "model_id": m.id, "outtype": rec.base, "llama_tag": tag }),
            )?;
            p
        }
    };
    let base_info = crate::models::tensors::read_gguf(&base_path)?;
    let base_type = dominant_type(&base_info.tensors);
    let reference_id = artifacts::register(
        st,
        Some(&ctx.id),
        &m.id,
        "gguf",
        &base_type,
        "reference",
        &base_path,
        m.params,
        json!({ "quant_type": base_type, "llama_tag": tag, "source_revision": m.revision }),
    )?;
    ctx.log(format!(
        "Reference GGUF: {base_type}, {}",
        crate::toolchain::download::human(base_info.file_size)
    ));

    // 2. Importance matrix.
    let mut imatrix: Option<(PathBuf, Value)> = None;
    if rec.imatrix.enabled {
        ctx.stage("calibration")?;
        let tokens = rec.imatrix.chunks as u64 * rec.imatrix.ctx as u64;
        let (text, calib_meta) =
            calib::ensure_text(st, ctx, calib_spec, calib::chars_for_tokens(tokens)).await?;
        let im_key = super::cache_key(&[
            "imatrix",
            &base_key,
            calib_meta["sha256"]
                .as_str()
                .unwrap_or(&text.to_string_lossy()),
            &rec.imatrix.chunks.to_string(),
            &rec.imatrix.ctx.to_string(),
        ]);
        let im_path = match artifacts::cache_get(st, &im_key) {
            Some(p) => {
                ctx.stage_cached("imatrix", "importance matrix");
                p
            }
            None => {
                ctx.stage("imatrix")?;
                let p = compute_imatrix(
                    st,
                    ctx,
                    &base_path,
                    &text,
                    rec.imatrix.chunks,
                    rec.imatrix.ctx,
                    &im_key,
                )
                .await?;
                artifacts::cache_put(st, &im_key, "imatrix", &p, calib_meta.clone())?;
                p
            }
        };
        imatrix = Some((
            im_path,
            json!({ "calibration": calib_meta, "chunks": rec.imatrix.chunks, "ctx": rec.imatrix.ctx }),
        ));
    }

    // 3. Quantize each type.
    let mut produced: Vec<(String, String, PathBuf, Value)> = vec![];
    for t in &rec.types {
        ctx.stage(&format!("quantize:{t}"))?;
        ctx.tensor(json!({ "t": "reset", "variant": t }));
        let out = out_dir.join(format!("{}-{}.gguf", m.name.replace(' ', "-"), t));
        let summary = quantize(
            st,
            ctx,
            &base_path,
            &out,
            t,
            rec,
            imatrix.as_ref().map(|i| i.0.as_path()),
        )
        .await?;
        let final_path = maybe_split(st, ctx, &out, rec.split_max_size_gb).await?;
        let meta = json!({
            "quant_type": t,
            "base_type": base_type,
            "imatrix": imatrix.as_ref().map(|i| i.1.clone()),
            "recipe": rec,
            "llama_tag": tag,
            "reported": summary,
            "source_repo": m.repo_id,
            "source_revision": m.revision,
        });
        let id = artifacts::register(
            st,
            Some(&ctx.id),
            &m.id,
            "gguf",
            t,
            "quantized",
            &final_path,
            m.params,
            meta.clone(),
        )?;
        ctx.log(format!(
            "✓ {t}: {} ({:.2} bits/weight)",
            crate::toolchain::download::human(crate::paths::dir_size(&final_path)),
            summary["quant_bpw"].as_f64().unwrap_or(0.0)
        ));
        produced.push((id, t.clone(), final_path, summary));
    }

    // 4. Evaluate against the reference with the same tokens.
    let mut evals = serde_json::Map::new();
    if eval.ppl || eval.kld {
        let tokens = eval.chunks as u64 * eval.ctx as u64;
        ctx.stage("eval:reference")?;
        let (text, text_meta) = calib::eval_text(st, ctx, tokens).await?;
        let run_id = artifacts::new_eval_run(
            st,
            Some(&ctx.id),
            "kld",
            Some(&m.id),
            &json!({ "chunks": eval.chunks, "ctx": eval.ctx, "text": text_meta }),
        )?;
        let kld_key = super::cache_key(&[
            "kld-base",
            &base_key,
            text_meta["sha256"].as_str().unwrap_or(""),
            &eval.chunks.to_string(),
            &eval.ctx.to_string(),
        ]);
        let kld_path = st
            .paths
            .cache()
            .join("gguf")
            .join(&base_key)
            .join(format!("kld-{kld_key}.bin"));
        let ref_stats = if let (Some(_), true) =
            (artifacts::cache_get(st, &kld_key), kld_path.exists())
        {
            ctx.log("Reusing saved reference logits");
            None
        } else {
            let s = perplexity(st, ctx, &base_path, &text, eval, Some((&kld_path, false))).await?;
            artifacts::cache_put(st, &kld_key, "kld_base", &kld_path, json!({ "ppl": s.ppl }))?;
            Some(s)
        };
        if let Some(s) = &ref_stats {
            artifacts::record(
                st,
                &run_id,
                &reference_id,
                None,
                &[("ppl", s.ppl), ("ppl_err", s.ppl_err)],
                &json!({ "chunks": eval.chunks, "ctx": eval.ctx }),
            )?;
        }
        for (id, t, path, _) in &produced {
            ctx.stage(&format!("eval:{t}"))?;
            let s = perplexity(st, ctx, path, &text, eval, Some((&kld_path, true))).await?;
            if ref_stats.is_none() {
                artifacts::record(
                    st,
                    &run_id,
                    &reference_id,
                    None,
                    &[("ppl", s.ppl_base)],
                    &json!({}),
                )?;
            }
            artifacts::record(
                st,
                &run_id,
                id,
                Some(&reference_id),
                &[
                    ("ppl", s.ppl),
                    ("ppl_err", s.ppl_err),
                    ("ppl_base", s.ppl_base),
                    ("ppl_ratio", s.ppl_ratio),
                    ("kld_mean", s.kld_mean),
                    ("kld_median", s.kld_median),
                    ("kld_p99", s.kld_p99),
                    ("kld_max", s.kld_max),
                    ("top1", s.top1),
                    ("delta_p_mean", s.delta_p_mean),
                    ("rms_delta_p", s.rms_delta_p),
                ],
                &json!({ "chunks": eval.chunks, "ctx": eval.ctx, "method": "llama-perplexity --kl-divergence" }),
            )?;
            ctx.log(format!(
                "✓ {t}: PPL {:.3} vs {:.3} · KLD {:.4} · same top token {:.1}%",
                s.ppl.unwrap_or(0.0),
                s.ppl_base.unwrap_or(0.0),
                s.kld_mean.unwrap_or(0.0),
                s.top1.unwrap_or(0.0) * 100.0
            ));
            evals.insert(t.clone(), serde_json::to_value(&s)?);
        }
    }

    // 5. Index tensors and checksums.
    ctx.stage("finalize")?;
    for (id, _, path, _) in &produced {
        let first = artifacts::shard_paths(path)
            .into_iter()
            .next()
            .unwrap_or(path.clone());
        if let Err(e) = artifacts::index_tensors(st, id, &first, "gguf") {
            ctx.log(format!("⚠ Could not index tensors: {}", e.message));
        }
        artifacts::finalize_hash(st, id).await?;
    }
    let _ = artifacts::index_tensors(st, &reference_id, &base_path, "gguf");
    st.hub
        .emit("artifacts:changed", json!({ "model_id": m.id }));
    Ok(json!({
        "reference_id": reference_id,
        "artifacts": produced.iter().map(|(id, t, p, s)| json!({ "id": id, "variant": t, "path": p, "summary": s, "eval": evals.get(t) })).collect::<Vec<_>>(),
        "imatrix": imatrix.map(|i| i.0),
    }))
}

fn dominant_type(tensors: &[crate::models::tensors::TensorInfo]) -> String {
    let mut by: std::collections::HashMap<&str, u64> = std::collections::HashMap::new();
    for t in tensors.iter().filter(|t| t.shape.len() > 1) {
        *by.entry(t.dtype.as_str()).or_default() += t.n_elements;
    }
    by.into_iter()
        .max_by_key(|(_, n)| *n)
        .map(|(k, _)| k.to_string())
        .unwrap_or_else(|| "F16".into())
}

async fn convert(
    st: &AppState,
    ctx: &JobCtx,
    m: &ModelRow,
    model_dir: &Path,
    outtype: &str,
    temp_file: bool,
    key: &str,
) -> AppResult<PathBuf> {
    let dir = st.paths.cache().join("gguf").join(key);
    std::fs::create_dir_all(&dir)?;
    let final_path = dir.join(format!(
        "{}-{}.gguf",
        super::slug(&m.name),
        outtype.to_uppercase()
    ));
    let tmp = dir.join("convert.tmp.gguf");
    let need =
        (m.size_bytes.unwrap_or(0) as f64 * if outtype == "f32" { 2.2 } else { 1.15 }) as u64;
    if let Some(free) = crate::paths::free_space(&dir) {
        if free < need {
            return Err(AppError::new(
                "disk",
                format!(
                    "Converting needs about {} free; only {} available",
                    crate::toolchain::download::human(need),
                    crate::toolchain::download::human(free)
                ),
            )
            .with_hint("Free disk space or move the workspace in Settings."));
        }
    }
    let total_tensors = crate::models::tensors::read_safetensors_dir(model_dir)
        .map(|t| t.len())
        .unwrap_or(0)
        .max(1) as f64;
    let mut spec = Spawn::new(st.paths.env_python("gguf"))
        .arg("-u")
        .arg(st.paths.convert_script())
        .arg(model_dir)
        .arg("--outfile")
        .arg(&tmp)
        .args(["--outtype", outtype])
        .cwd(st.paths.llama_src());
    if temp_file {
        spec = spec.arg("--use-temp-file");
    }
    for (k, v) in st.python_env(false) {
        spec = spec.env(&k, v);
    }
    let mut seen = 0.0;
    let outcome = ctx
        .exec(&spec, |_, line| {
            if let Some((name, from, to, shape)) = parse::convert_tensor(line) {
                seen += 1.0;
                ctx.stage_progress(
                    (seen / total_tensors).min(1.0) * 0.5,
                    Some(format!("Reading {name}")),
                );
                ctx.tensor(
                    json!({ "t": "convert", "name": name, "from": from, "to": to, "shape": shape }),
                );
            } else if line.contains("Writing") {
                if let Some(p) = parse::tqdm_percent(line) {
                    ctx.stage_progress(
                        0.5 + p * 0.5,
                        Some(format!("Writing GGUF {:.0}%", p * 100.0)),
                    );
                }
            }
        })
        .await?;
    outcome.ensure_success("Conversion").map_err(|e| {
        let tail = outcome.tail.join("\n");
        if tail.contains("NotImplementedError")
            || tail.contains("not supported")
            || tail.contains("Model ") && tail.contains("is not supported")
        {
            AppError::new(
                "unsupported",
                format!(
                    "llama.cpp cannot convert this architecture yet.\n{}",
                    e.message
                ),
            )
            .with_hint("Try MLX or ONNX, or check for a newer llama.cpp build.")
        } else {
            e
        }
    })?;
    std::fs::rename(&tmp, &final_path)?;
    Ok(final_path)
}

async fn compute_imatrix(
    st: &AppState,
    ctx: &JobCtx,
    base: &Path,
    text: &Path,
    chunks: u32,
    n_ctx: u32,
    key: &str,
) -> AppResult<PathBuf> {
    let out = st
        .paths
        .cache()
        .join("gguf")
        .join(format!("imatrix-{key}.gguf"));
    let spec = Spawn::new(st.paths.llama_bin("llama-imatrix"))
        .arg("-m")
        .arg(base)
        .arg("-f")
        .arg(text)
        .arg("-o")
        .arg(&out)
        .args(["--chunks", &chunks.to_string(), "-c", &n_ctx.to_string()])
        .args(gpu_args(st))
        .args(thread_args(st));
    let mut total = chunks as f64;
    let outcome = ctx
        .exec(&spec, |_, line| {
            if let Some(t) = parse::total_chunks(line) {
                total = t as f64;
            }
            for (n, v) in parse::chunks(line) {
                if let Some(v) = v {
                    ctx.metric("imatrix_ppl", v, Some(n as i64));
                }
                ctx.stage_progress(
                    n as f64 / total.max(1.0),
                    Some(format!("Chunk {n} of {}", total as u64)),
                );
            }
        })
        .await?;
    outcome.ensure_success("Importance matrix")?;
    if !out.exists() {
        return Err(AppError::new(
            "imatrix",
            "llama-imatrix finished without writing a file",
        ));
    }
    Ok(out)
}

async fn quantize(
    st: &AppState,
    ctx: &JobCtx,
    base: &Path,
    out: &Path,
    ftype: &str,
    rec: &GgufRecipe,
    imatrix: Option<&Path>,
) -> AppResult<Value> {
    let mut spec = Spawn::new(st.paths.llama_bin("llama-quantize"));
    if let Some(im) = imatrix {
        spec = spec.arg("--imatrix").arg(im);
    }
    if let Some(t) = &rec.output_tensor_type {
        spec = spec.args(["--output-tensor-type", t.as_str()]);
    }
    if let Some(t) = &rec.token_embedding_type {
        spec = spec.args(["--token-embedding-type", t.as_str()]);
    }
    if rec.leave_output_tensor {
        spec = spec.arg("--leave-output-tensor");
    }
    if rec.pure {
        spec = spec.arg("--pure");
    }
    for r in &rec.tensor_types {
        spec =
            spec.arg("--tensor-type")
                .arg(format!("{}={}", r.pattern, r.type_name.to_lowercase()));
    }
    let threads = st.setting_or("threads", "0");
    spec = spec.arg(base).arg(out).arg(ftype);
    if threads != "0" {
        spec = spec.arg(threads);
    }
    let started = std::time::Instant::now();
    let mut totals: Vec<(String, f64, Option<f64>)> = vec![];
    let mut fallbacks = 0u64;
    let mut types_out: std::collections::BTreeMap<String, u64> = Default::default();
    let mut mib_in_done = 0.0;
    let mut mib_out_done = 0.0;
    let outcome = ctx
        .exec(&spec, |s, line| {
            if let Some(q) = parse::quant_line(line) {
                let n: u64 = q.shape.iter().product::<u64>().max(1);
                let bytes_out = q.mib_out * 1_048_576.0;
                mib_in_done += q.mib_in;
                mib_out_done += q.mib_out;
                *types_out.entry(q.to.to_uppercase()).or_default() += n;
                ctx.tensor(json!({
                    "t": "tensor", "idx": q.idx, "total": q.total, "name": q.name, "shape": q.shape, "from": q.from,
                    "to": q.to.to_uppercase(), "quantized": q.quantized, "bits": bytes_out * 8.0 / n as f64,
                    "bytes_in": q.mib_in * 1_048_576.0, "bytes_out": bytes_out,
                }));
                let elapsed = started.elapsed().as_secs_f64();
                let frac = q.idx as f64 / q.total.max(1) as f64;
                ctx.stage_progress_extra(
                    frac,
                    Some(format!("{} → {} · tensor {} of {}", q.name, q.to.to_uppercase(), q.idx, q.total)),
                    Some(json!({ "mib_in": mib_in_done, "mib_out": mib_out_done, "eta_s": if frac > 0.02 { elapsed / frac - elapsed } else { 0.0 } })),
                );
            } else if let Some(t) = parse::totals(line) {
                totals.push(t);
            } else if parse::fallback(line).is_some() {
                fallbacks += 1;
            } else if s == Stream::Stderr && line.contains("please use an importance matrix") {
                ctx.log("⚠ llama-quantize recommends an importance matrix for this type.");
            }
        })
        .await?;
    outcome
        .ensure_success(&format!("Quantizing {ftype}"))
        .map_err(|e| {
            if outcome
                .tail
                .iter()
                .any(|l| l.contains("imatrix") && l.contains("required"))
            {
                AppError::new(
                    "imatrix_required",
                    format!("{ftype} needs an importance matrix"),
                )
                .with_hint("Turn on the importance matrix in the recipe.")
            } else {
                e
            }
        })?;
    let model = totals.iter().find(|t| t.0 == "model");
    let quant = totals.iter().find(|t| t.0 == "quant");
    if fallbacks > 0 {
        ctx.log(format!("ℹ {fallbacks} tensors used a fallback type because their row width is not a multiple of 256 (common in small models)."));
    }
    Ok(json!({
        "model_mib": model.map(|t| t.1),
        "quant_mib": quant.map(|t| t.1),
        "quant_bpw": quant.and_then(|t| t.2),
        "fallback_tensors": fallbacks,
        "types": types_out,
        "seconds": started.elapsed().as_secs_f64(),
    }))
}

async fn maybe_split(st: &AppState, ctx: &JobCtx, path: &Path, max_gb: f64) -> AppResult<PathBuf> {
    let size = std::fs::metadata(path)?.len() as f64;
    if max_gb <= 0.0 || size < max_gb * 1e9 {
        return Ok(path.to_path_buf());
    }
    ctx.log(format!(
        "Splitting into ≤{max_gb} GB shards (Hugging Face rejects files over 50 GB)…"
    ));
    let prefix = path.with_extension("");
    let spec = Spawn::new(st.paths.llama_bin("llama-gguf-split"))
        .args([
            "--split",
            "--split-max-size",
            &format!("{}G", max_gb as u64),
        ])
        .arg(path)
        .arg(&prefix);
    ctx.exec(&spec, |_, _| {})
        .await?
        .ensure_success("Splitting")?;
    std::fs::remove_file(path)?;
    let first = PathBuf::from(format!("{}-00001-of-", prefix.display()));
    let dir = path.parent().unwrap_or(Path::new("."));
    let shard = std::fs::read_dir(dir)?
        .flatten()
        .map(|e| e.path())
        .find(|p| p.to_string_lossy().starts_with(&*first.to_string_lossy()))
        .ok_or_else(|| AppError::new("split", "Split finished but no shards were found"))?;
    Ok(shard)
}

/// Runs llama-perplexity. With `kld = Some((file, false))` it saves reference logits;
/// with `Some((file, true))` it compares against them.
pub async fn perplexity(
    st: &AppState,
    ctx: &JobCtx,
    model: &Path,
    text: &Path,
    eval: &EvalSpec,
    kld: Option<(&Path, bool)>,
) -> AppResult<parse::PerplexityStats> {
    let mut spec = Spawn::new(st.paths.llama_bin("llama-perplexity"))
        .arg("-m")
        .arg(model)
        .args([
            "--chunks",
            &eval.chunks.to_string(),
            "-c",
            &eval.ctx.to_string(),
        ])
        .args(gpu_args(st))
        .args(thread_args(st));
    match kld {
        Some((file, false)) => {
            if let Some(p) = file.parent() {
                std::fs::create_dir_all(p)?;
            }
            spec = spec
                .arg("-f")
                .arg(text)
                .arg("--kl-divergence-base")
                .arg(file);
        }
        Some((file, true)) => {
            spec = spec
                .arg("--kl-divergence-base")
                .arg(file)
                .arg("--kl-divergence")
        }
        None => spec = spec.arg("-f").arg(text),
    }
    let mut collected = String::new();
    let total = eval.chunks as f64;
    let outcome = ctx
        .exec(&spec, |_, line| {
            collected.push_str(line);
            collected.push('\n');
            for (n, v) in parse::chunks(line) {
                if let Some(v) = v {
                    ctx.metric("ppl", v, Some(n as i64));
                }
                ctx.stage_progress(
                    n as f64 / total.max(1.0),
                    Some(format!("Chunk {n} of {}", total as u64)),
                );
            }
            if let Some((n, ppl)) = parse::kld_row(line) {
                ctx.metric("ppl", ppl, Some(n as i64));
                ctx.stage_progress(
                    n as f64 / total.max(1.0),
                    Some(format!("Chunk {n} of {}", total as u64)),
                );
            }
        })
        .await?;
    outcome.ensure_success("Perplexity")?;
    Ok(parse::perplexity(&collected))
}
