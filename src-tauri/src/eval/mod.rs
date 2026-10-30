//! Testing: side-by-side arena, prompt suites, speed benchmarks and quality (PPL/KLD) jobs.

pub mod runner;
pub mod similarity;

use crate::db::{json_col, new_id, now_ms};
use crate::error::{AppError, AppResult};
use crate::jobs::{JobCtx, Lane, NewJob, StageDef};
use crate::process::Spawn;
use crate::quant::artifacts::{self, ArtifactRow};
use crate::quant::recipe::EvalSpec;
use crate::state::AppState;
use runner::GenParams;
use serde_json::{json, Value};
use std::path::PathBuf;

/* ---------------- arena ---------------- */

fn ram_free(st: &AppState) -> u64 {
    let mut sys = st.sys.lock().unwrap_or_else(|e| e.into_inner());
    sys.refresh_memory();
    sys.available_memory()
}

#[allow(clippy::too_many_arguments)]
pub fn arena_run(
    st: &AppState,
    a_id: String,
    b_id: String,
    system: Option<String>,
    prompt: String,
    history: Vec<Value>,
    params: GenParams,
    sequential: bool,
) -> AppResult<String> {
    let a = artifacts::get(st, &a_id)?;
    let b = artifacts::get(st, &b_id)?;
    let stream = new_id();
    let cancel = st.register_stream(&stream);
    let st2 = st.clone();
    let sid = stream.clone();
    tauri::async_runtime::spawn(async move {
        let mut messages: Vec<Value> = vec![];
        if let Some(s) = system.filter(|s| !s.trim().is_empty()) {
            messages.push(json!({ "role": "system", "content": s }));
        }
        messages.extend(history);
        messages.push(json!({ "role": "user", "content": prompt }));
        let need = (a.size_bytes.unwrap_or(0) + b.size_bytes.unwrap_or(0)) as u64;
        let seq = sequential || need as f64 * 1.3 > ram_free(&st2) as f64;
        st2.hub
            .emit("arena:status", json!({ "stream": sid, "sequential": seq }));
        let run_side = |art: ArtifactRow, side: &'static str| {
            let st = st2.clone();
            let sid = sid.clone();
            let messages = messages.clone();
            let params = params.clone();
            let cancel = cancel.clone();
            async move {
                st.hub.emit(
                    "arena:status",
                    json!({ "stream": sid, "side": side, "status": "loading" }),
                );
                let r = async {
                    let runner = st.runners.ensure(&st, &art, &params).await?;
                    st.hub.emit(
                        "arena:status",
                        json!({ "stream": sid, "side": side, "status": "generating" }),
                    );
                    let hub = st.hub.clone();
                    let sid2 = sid.clone();
                    runner::generate(&st, &runner, &messages, &params, &cancel, move |t| {
                        hub.emit(
                            "arena:delta",
                            json!({ "stream": sid2, "side": side, "text": t }),
                        )
                    })
                    .await
                }
                .await;
                match &r {
                    Ok((text, m)) => st.hub.emit("arena:done", json!({ "stream": sid, "side": side, "metrics": m, "chars": text.len() })),
                    Err(e) => st.hub.emit("arena:error", json!({ "stream": sid, "side": side, "message": e.message, "hint": e.hint })),
                }
                r.ok()
            }
        };
        let (ra, rb) = if seq {
            let ra = run_side(a.clone(), "a").await;
            if a.id != b.id {
                st2.runners.stop(&a.id).await;
            }
            let rb = run_side(b.clone(), "b").await;
            (ra, rb)
        } else {
            tokio::join!(run_side(a.clone(), "a"), run_side(b.clone(), "b"))
        };
        let turn = save_turn(&st2, &a, &b, &messages, &params, ra, rb);
        st2.hub.emit(
            "arena:saved",
            json!({ "stream": sid, "turn_id": turn.ok() }),
        );
        st2.end_stream(&sid);
    });
    Ok(stream)
}

fn save_turn(
    st: &AppState,
    a: &ArtifactRow,
    b: &ArtifactRow,
    messages: &[Value],
    params: &GenParams,
    ra: Option<(String, runner::GenMetrics)>,
    rb: Option<(String, runner::GenMetrics)>,
) -> AppResult<i64> {
    let session: Option<String> = st.db.with(|c| {
        rusqlite::OptionalExtension::optional(c.query_row(
            "SELECT id FROM arena_sessions WHERE a_artifact = ?1 AND b_artifact = ?2",
            [&a.id, &b.id],
            |r| r.get(0),
        ))
    })?;
    let session = match session {
        Some(s) => s,
        None => {
            let id = new_id();
            st.db.with(|c| {
                c.execute(
                    "INSERT INTO arena_sessions (id, a_artifact, b_artifact, params_json, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
                    rusqlite::params![id, a.id, b.id, json!({ "temperature": params.temperature, "seed": params.seed }).to_string(), now_ms()],
                )
            })?;
            id
        }
    };
    let system = messages
        .iter()
        .find(|m| m["role"] == "system")
        .and_then(|m| m["content"].as_str())
        .map(str::to_string);
    let prompt = messages
        .last()
        .and_then(|m| m["content"].as_str())
        .unwrap_or("")
        .to_string();
    st.db.with(|c| {
        c.execute(
            "INSERT INTO arena_turns (session_id, system, prompt, a_output, b_output, a_metrics_json, b_metrics_json, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            rusqlite::params![
                session,
                system,
                prompt,
                ra.as_ref().map(|r| r.0.clone()),
                rb.as_ref().map(|r| r.0.clone()),
                ra.as_ref().map(|r| json!(r.1).to_string()),
                rb.as_ref().map(|r| json!(r.1).to_string()),
                now_ms()
            ],
        )?;
        Ok(c.last_insert_rowid())
    })
}

pub fn arena_vote(st: &AppState, turn_id: i64, vote: &str) -> AppResult<()> {
    if !["a", "b", "tie", ""].contains(&vote) {
        return Err(AppError::invalid("Vote must be a, b or tie"));
    }
    st.db.with(|c| {
        c.execute(
            "UPDATE arena_turns SET vote = ?1 WHERE id = ?2",
            rusqlite::params![if vote.is_empty() { None } else { Some(vote) }, turn_id],
        )
    })?;
    Ok(())
}

pub fn arena_history(st: &AppState, a_id: &str, b_id: &str) -> AppResult<Vec<Value>> {
    st.db.with(|c| {
        let mut s = c.prepare(
            "SELECT t.id, t.system, t.prompt, t.a_output, t.b_output, t.a_metrics_json, t.b_metrics_json, t.vote, t.created_at
             FROM arena_turns t JOIN arena_sessions s ON s.id = t.session_id WHERE s.a_artifact = ?1 AND s.b_artifact = ?2 ORDER BY t.id",
        )?;
        let r = s.query_map([a_id, b_id], |r| {
            Ok(json!({ "id": r.get::<_, i64>(0)?, "system": r.get::<_, Option<String>>(1)?, "prompt": r.get::<_, String>(2)?, "a_output": r.get::<_, Option<String>>(3)?, "b_output": r.get::<_, Option<String>>(4)?,
                "a_metrics": json_col(r.get(5)?), "b_metrics": json_col(r.get(6)?), "vote": r.get::<_, Option<String>>(7)?, "created_at": r.get::<_, i64>(8)? }))
        })?;
        r.collect()
    })
}

/* ---------------- prompt suites ---------------- */

pub fn suites(st: &AppState) -> AppResult<Vec<Value>> {
    let mut out: Vec<Value> = crate::embedded::SUITES
        .iter()
        .filter_map(|(_, body)| serde_json::from_str::<Value>(body).ok())
        .map(|mut s| {
            s["builtin"] = json!(true);
            s
        })
        .collect();
    let user: Vec<Value> = st.db.with(|c| {
        let mut s = c.prepare("SELECT id, name, description, extra_json FROM prompt_suites WHERE builtin = 0 ORDER BY created_at")?;
        let r = s.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, Option<String>>(2)?, r.get::<_, Option<String>>(3)?)))?;
        r.collect::<Result<Vec<_>, _>>()
    })?
    .into_iter()
    .map(|(id, name, desc, _)| {
        let prompts: Vec<Value> = st
            .db
            .with(|c| {
                let mut s = c.prepare("SELECT category, system, prompt, reference FROM prompts WHERE suite_id = ?1 ORDER BY idx")?;
                let r = s.query_map([&id], |r| Ok(json!({ "category": r.get::<_, Option<String>>(0)?, "system": r.get::<_, Option<String>>(1)?, "prompt": r.get::<_, String>(2)?, "reference": r.get::<_, Option<String>>(3)? })))?;
                r.collect()
            })
            .unwrap_or_default();
        json!({ "id": id, "name": name, "description": desc, "prompts": prompts, "builtin": false })
    })
    .collect();
    out.extend(user);
    Ok(out)
}

pub fn suite_save(
    st: &AppState,
    name: &str,
    description: &str,
    prompts: &[Value],
) -> AppResult<String> {
    if name.trim().is_empty() || prompts.is_empty() {
        return Err(AppError::invalid(
            "A suite needs a name and at least one prompt",
        ));
    }
    let id = new_id();
    st.db.tx(|tx| {
        tx.execute("INSERT INTO prompt_suites (id, name, description, created_at) VALUES (?1, ?2, ?3, ?4)", rusqlite::params![id, name.trim(), description, now_ms()])?;
        for (i, p) in prompts.iter().enumerate() {
            tx.execute(
                "INSERT INTO prompts (suite_id, idx, category, system, prompt, reference) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                rusqlite::params![id, i as i64, p["category"].as_str(), p["system"].as_str(), p["prompt"].as_str().unwrap_or(""), p["reference"].as_str()],
            )?;
        }
        Ok(())
    })?;
    Ok(id)
}

pub fn suite_delete(st: &AppState, id: &str) -> AppResult<()> {
    st.db.with(|c| {
        c.execute(
            "DELETE FROM prompt_suites WHERE id = ?1 AND builtin = 0",
            [id],
        )
    })?;
    Ok(())
}

pub fn submit_suite(
    st: &AppState,
    suite_id: String,
    artifact_ids: Vec<String>,
    params: GenParams,
) -> AppResult<String> {
    let suite = suites(st)?
        .into_iter()
        .find(|s| s["id"] == suite_id.as_str())
        .ok_or_else(|| AppError::not_found("Suite"))?;
    let arts: Vec<ArtifactRow> = artifact_ids
        .iter()
        .map(|id| artifacts::get(st, id))
        .collect::<AppResult<_>>()?;
    if arts.is_empty() {
        return Err(AppError::invalid("Pick at least one model to test"));
    }
    let stages: Vec<StageDef> = arts
        .iter()
        .map(|a| {
            StageDef::new(
                &a.id,
                format!("Run {} {}", a.format.to_uppercase(), a.variant),
                1.0,
            )
        })
        .chain([StageDef::new("score", "Score answers", 0.1)])
        .collect();
    let title = format!(
        "Suite · {} · {}",
        suite["name"].as_str().unwrap_or("prompts"),
        arts.iter()
            .map(|a| a.variant.clone())
            .collect::<Vec<_>>()
            .join(" vs ")
    );
    let st2 = st.clone();
    let model_id = arts[0].model_id.clone();
    st.jobs.submit(
        NewJob {
            kind: "suite",
            title,
            model_id,
            format: None,
            params: json!({ "suite": suite_id, "artifacts": artifact_ids }),
            stages,
            lane: Lane::Heavy,
        },
        move |ctx| async move { run_suite(&st2, &ctx, &suite, &arts, &params).await },
    )
}

async fn run_suite(
    st: &AppState,
    ctx: &JobCtx,
    suite: &Value,
    arts: &[ArtifactRow],
    params: &GenParams,
) -> AppResult<Value> {
    let haystack = suite["haystack"].as_str().unwrap_or("");
    let prompts: Vec<Value> = suite["prompts"].as_array().cloned().unwrap_or_default();
    let mut outputs: Vec<Vec<(String, runner::GenMetrics)>> = vec![];
    for a in arts {
        ctx.stage(&a.id)?;
        ctx.log(format!(
            "Loading {} {}…",
            a.format.to_uppercase(),
            a.variant
        ));
        let runner = st.runners.ensure(st, a, params).await?;
        let mut outs = vec![];
        for (i, p) in prompts.iter().enumerate() {
            ctx.check_cancel()?;
            let mut messages = vec![];
            if let Some(s) = p["system"].as_str() {
                messages.push(json!({ "role": "system", "content": s }));
            }
            messages.push(json!({ "role": "user", "content": p["prompt"].as_str().unwrap_or("").replace("{{haystack}}", haystack) }));
            let (text, m) =
                runner::generate(st, &runner, &messages, params, &ctx.cancel, |_| {}).await?;
            ctx.stage_progress(
                (i + 1) as f64 / prompts.len().max(1) as f64,
                Some(format!(
                    "Prompt {} of {} · {:.0} tok/s",
                    i + 1,
                    prompts.len(),
                    m.tok_per_s
                )),
            );
            outs.push((text, m));
        }
        st.runners.stop(&a.id).await;
        outputs.push(outs);
    }
    ctx.stage("score")?;
    let run_id = artifacts::new_eval_run(
        st,
        Some(&ctx.id),
        "suite",
        arts[0].model_id.as_deref(),
        &json!({ "suite": suite["id"], "name": suite["name"] }),
    )?;
    let mut rows = vec![];
    for (i, p) in prompts.iter().enumerate() {
        let reference = p["reference"].as_str();
        let per: Vec<Value> = arts
            .iter()
            .enumerate()
            .map(|(k, _)| {
                let (text, m) = &outputs[k][i];
                json!({
                    "output": text, "metrics": m,
                    "exact": reference.map(|r| similarity::exact_match(text, r)),
                    "rouge_l": reference.map(|r| similarity::rouge_l(text, r)),
                })
            })
            .collect();
        let agreement = if arts.len() >= 2 {
            Some(similarity::rouge_l(&outputs[0][i].0, &outputs[1][i].0))
        } else {
            None
        };
        rows.push(json!({ "category": p["category"], "prompt": p["prompt"], "reference": reference, "results": per, "agreement": agreement }));
    }
    let mut summary = vec![];
    for (k, a) in arts.iter().enumerate() {
        let scored: Vec<&Value> = rows.iter().filter(|r| !r["reference"].is_null()).collect();
        let exact = if scored.is_empty() {
            None
        } else {
            Some(
                scored
                    .iter()
                    .filter(|r| r["results"][k]["exact"] == true)
                    .count() as f64
                    / scored.len() as f64,
            )
        };
        let rouge = if scored.is_empty() {
            None
        } else {
            Some(
                scored
                    .iter()
                    .filter_map(|r| r["results"][k]["rouge_l"].as_f64())
                    .sum::<f64>()
                    / scored.len() as f64,
            )
        };
        let tps =
            outputs[k].iter().map(|o| o.1.tok_per_s).sum::<f64>() / outputs[k].len().max(1) as f64;
        let agreement = if arts.len() >= 2 && k > 0 {
            Some(
                rows.iter()
                    .filter_map(|r| r["agreement"].as_f64())
                    .sum::<f64>()
                    / rows.len().max(1) as f64,
            )
        } else {
            None
        };
        artifacts::record(
            st,
            &run_id,
            &a.id,
            arts.first().filter(|_| k > 0).map(|x| x.id.as_str()),
            &[
                ("suite_exact", exact),
                ("suite_rouge_l", rouge),
                ("suite_tok_s", Some(tps)),
                ("suite_agreement", agreement),
            ],
            &json!({ "suite": suite["id"] }),
        )?;
        summary.push(json!({ "artifact_id": a.id, "variant": a.variant, "format": a.format, "exact": exact, "rouge_l": rouge, "tok_s": tps, "agreement": agreement }));
    }
    Ok(json!({ "suite": suite["name"], "summary": summary, "rows": rows }))
}

/* ---------------- speed ---------------- */

pub fn submit_speed(
    st: &AppState,
    artifact_ids: Vec<String>,
    prompt_tokens: u32,
    gen_tokens: u32,
    repeats: u32,
) -> AppResult<String> {
    let arts: Vec<ArtifactRow> = artifact_ids
        .iter()
        .map(|id| artifacts::get(st, id))
        .collect::<AppResult<_>>()?;
    let stages: Vec<StageDef> = arts
        .iter()
        .map(|a| {
            StageDef::new(
                &a.id,
                format!("Benchmark {} {}", a.format.to_uppercase(), a.variant),
                1.0,
            )
        })
        .collect();
    let st2 = st.clone();
    let model_id = arts.first().and_then(|a| a.model_id.clone());
    st.jobs.submit(
        NewJob { kind: "eval", title: format!("Speed · {}", arts.iter().map(|a| a.variant.clone()).collect::<Vec<_>>().join(", ")), model_id: model_id.clone(), format: None, params: json!({ "artifacts": artifact_ids }), stages, lane: Lane::Heavy },
        move |ctx| async move {
            st2.runners.stop_all().await;
            let run_id = artifacts::new_eval_run(&st2, Some(&ctx.id), "speed", model_id.as_deref(), &json!({ "prompt_tokens": prompt_tokens, "gen_tokens": gen_tokens, "repeats": repeats }))?;
            let mut out = vec![];
            for a in &arts {
                ctx.stage(&a.id)?;
                let r = speed_one(&st2, &ctx, a, prompt_tokens, gen_tokens, repeats).await?;
                artifacts::record(&st2, &run_id, &a.id, None, &[("pp_tok_s", r["pp_tok_s"].as_f64()), ("tg_tok_s", r["tg_tok_s"].as_f64()), ("peak_mem_bytes", r["peak_mem_bytes"].as_f64())], &r)?;
                ctx.log(format!("✓ {}: prompt {:.0} tok/s · generate {:.1} tok/s", a.variant, r["pp_tok_s"].as_f64().unwrap_or(0.0), r["tg_tok_s"].as_f64().unwrap_or(0.0)));
                out.push(json!({ "artifact_id": a.id, "variant": a.variant, "result": r }));
            }
            Ok(json!({ "results": out }))
        },
    )
}

async fn speed_one(
    st: &AppState,
    ctx: &JobCtx,
    a: &ArtifactRow,
    pp: u32,
    tg: u32,
    reps: u32,
) -> AppResult<Value> {
    if a.format == "gguf" {
        let path = artifacts::shard_paths(std::path::Path::new(&a.path))
            .into_iter()
            .next()
            .unwrap_or_else(|| PathBuf::from(&a.path));
        let spec = Spawn::new(st.paths.llama_bin("llama-bench"))
            .arg("-m")
            .arg(path)
            .args([
                "-p",
                &pp.to_string(),
                "-n",
                &tg.to_string(),
                "-r",
                &reps.to_string(),
                "-o",
                "json",
            ])
            .args(crate::quant::gguf::gpu_args(st));
        let mut json_text = String::new();
        let out = ctx
            .exec(&spec, |s, l| {
                if s == crate::process::Stream::Stdout {
                    json_text.push_str(l);
                    json_text.push('\n')
                }
            })
            .await?;
        out.ensure_success("llama-bench")?;
        let v: Value = serde_json::from_str(json_text.trim()).map_err(|e| {
            AppError::new("bench", format!("Could not read llama-bench output: {e}"))
        })?;
        let rows = v.as_array().cloned().unwrap_or_default();
        let pick = |key: &str| {
            rows.iter()
                .find(|r| {
                    r[key].as_u64().unwrap_or(0) > 0
                        && r[if key == "n_prompt" {
                            "n_gen"
                        } else {
                            "n_prompt"
                        }]
                        .as_u64()
                        .unwrap_or(1)
                            == 0
                })
                .and_then(|r| r["avg_ts"].as_f64())
        };
        return Ok(
            json!({ "pp_tok_s": pick("n_prompt"), "tg_tok_s": pick("n_gen"), "peak_mem_bytes": Value::Null, "tool": "llama-bench", "raw": rows }),
        );
    }
    let args = json!({ "backend": a.format, "model": a.path, "prompt_tokens": pp, "gen_tokens": tg, "repeats": reps });
    let spec = crate::driver::spawn(st, &a.format, "bench.py", &args, false)?;
    crate::driver::run(ctx, &spec, |_| {}).await
}

/* ---------------- quality ---------------- */

pub fn submit_quality(
    st: &AppState,
    artifact_ids: Vec<String>,
    reference_id: String,
    eval: EvalSpec,
) -> AppResult<String> {
    let reference = artifacts::get(st, &reference_id)?;
    let arts: Vec<ArtifactRow> = artifact_ids
        .iter()
        .filter(|id| **id != reference_id)
        .map(|id| artifacts::get(st, id))
        .collect::<AppResult<_>>()?;
    if let Some(bad) = arts.iter().find(|a| a.format != reference.format) {
        return Err(AppError::invalid(format!("{} is {} but the reference is {}. KL divergence needs the same runtime; compare within one format.", bad.variant, bad.format.to_uppercase(), reference.format.to_uppercase())));
    }
    let mut stages = vec![StageDef::new(
        "reference",
        format!("Measure {}", reference.variant),
        1.0,
    )];
    stages.extend(
        arts.iter()
            .map(|a| StageDef::new(&a.id, format!("Measure {}", a.variant), 1.0)),
    );
    let st2 = st.clone();
    let model_id = reference.model_id.clone();
    st.jobs.submit(
        NewJob {
            kind: "eval",
            title: format!(
                "Quality · {} vs {}",
                arts.iter()
                    .map(|a| a.variant.clone())
                    .collect::<Vec<_>>()
                    .join(", "),
                reference.variant
            ),
            model_id: model_id.clone(),
            format: Some(reference.format.clone()),
            params: json!({ "reference": reference_id, "artifacts": artifact_ids, "eval": eval }),
            stages,
            lane: Lane::Heavy,
        },
        move |ctx| async move {
            st2.runners.stop_all().await;
            ctx.stage("reference")?;
            let (text, meta) =
                crate::quant::calib::eval_text(&st2, &ctx, eval.chunks as u64 * eval.ctx as u64)
                    .await?;
            let run_id = artifacts::new_eval_run(
                &st2,
                Some(&ctx.id),
                "kld",
                model_id.as_deref(),
                &json!({ "chunks": eval.chunks, "ctx": eval.ctx, "text": meta }),
            )?;
            let dir = st2.paths.eval().join(&ctx.id);
            std::fs::create_dir_all(&dir)?;
            let mut out = vec![];
            if reference.format == "gguf" {
                let base = PathBuf::from(&reference.path);
                let kld = dir.join("reference.kld");
                let s = crate::quant::gguf::perplexity(
                    &st2,
                    &ctx,
                    &base,
                    &text,
                    &eval,
                    Some((&kld, false)),
                )
                .await?;
                artifacts::record(
                    &st2,
                    &run_id,
                    &reference.id,
                    None,
                    &[("ppl", s.ppl), ("ppl_err", s.ppl_err)],
                    &json!({}),
                )?;
                for a in &arts {
                    ctx.stage(&a.id)?;
                    let s = crate::quant::gguf::perplexity(
                        &st2,
                        &ctx,
                        &PathBuf::from(&a.path),
                        &text,
                        &eval,
                        Some((&kld, true)),
                    )
                    .await?;
                    artifacts::record(
                        &st2,
                        &run_id,
                        &a.id,
                        Some(&reference.id),
                        &[
                            ("ppl", s.ppl),
                            ("ppl_base", s.ppl_base),
                            ("kld_mean", s.kld_mean),
                            ("kld_median", s.kld_median),
                            ("kld_p99", s.kld_p99),
                            ("top1", s.top1),
                            ("delta_p_mean", s.delta_p_mean),
                        ],
                        &json!({}),
                    )?;
                    out.push(json!({ "artifact_id": a.id, "stats": s }));
                }
                let _ = std::fs::remove_file(&kld);
            } else {
                let npz = dir.join("reference.npz");
                let r = crate::quant::mlx::logits_eval(
                    &st2,
                    &ctx,
                    &reference.format,
                    &PathBuf::from(&reference.path),
                    &text,
                    &eval,
                    "save_ref",
                    &npz,
                )
                .await?;
                artifacts::record(
                    &st2,
                    &run_id,
                    &reference.id,
                    None,
                    &[("ppl", r["ppl"].as_f64())],
                    &json!({}),
                )?;
                for a in &arts {
                    ctx.stage(&a.id)?;
                    let r = crate::quant::mlx::logits_eval(
                        &st2,
                        &ctx,
                        &a.format,
                        &PathBuf::from(&a.path),
                        &text,
                        &eval,
                        "kld",
                        &npz,
                    )
                    .await?;
                    crate::quant::mlx::record_kld(&st2, &run_id, &a.id, &reference.id, &r)?;
                    out.push(json!({ "artifact_id": a.id, "stats": r }));
                }
            }
            st2.hub.emit("artifacts:changed", json!({}));
            Ok(json!({ "results": out }))
        },
    )
}
