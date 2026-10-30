//! Runs embedded Python drivers and decodes their `@@IQ {json}` event protocol.

use crate::error::{AppError, AppResult};
use crate::jobs::JobCtx;
use crate::process::Spawn;
use crate::state::AppState;
use serde_json::Value;

pub const PREFIX: &str = "@@IQ ";

pub fn env_label(env: &str) -> &'static str {
    match env {
        "gguf" => "GGUF converter environment",
        "mlx" => "MLX environment",
        "onnx" => "ONNX environment",
        _ => "Hub & data tools environment",
    }
}

/// Builds the command for `<env python> -u -I -X utf8 <drivers>/<name> '<json>'`.
pub fn spawn(
    st: &AppState,
    env: &str,
    driver: &str,
    args: &Value,
    with_hf_token: bool,
) -> AppResult<Spawn> {
    let py = st.paths.env_python(env);
    if !py.exists() {
        return Err(AppError::missing_tool(env_label(env)));
    }
    let script = st.paths.driver(driver);
    if !script.exists() {
        crate::embedded::install_drivers(&st.paths)?;
        if !script.exists() {
            return Err(AppError::new(
                "missing_driver",
                format!("Driver {driver} is missing from this build"),
            ));
        }
    }
    let mut spec = Spawn::new(py)
        .args(["-u", "-I", "-X", "utf8"])
        .arg(script)
        .arg(args.to_string());
    for (k, v) in st.python_env(with_hf_token) {
        spec = spec.env(&k, v);
    }
    Ok(spec)
}

/// Parses one output line into a driver event, if it is one.
pub fn parse_event(line: &str) -> Option<Value> {
    line.strip_prefix(PREFIX)
        .and_then(|rest| serde_json::from_str(rest).ok())
}

/// Default mapping of driver events onto job progress/log/tensor/metric streams.
pub fn forward_event(ctx: &JobCtx, v: &Value) {
    match v["t"].as_str() {
        Some("progress") => {
            let done = v["done"].as_f64().unwrap_or(0.0);
            let total = v["total"].as_f64().unwrap_or(0.0);
            let label = v["label"].as_str().unwrap_or("");
            let unit = v["unit"].as_str().unwrap_or("");
            let detail = if total > 0.0 {
                if unit == "bytes" {
                    format!(
                        "{label} {} / {}",
                        crate::toolchain::download::human(done as u64),
                        crate::toolchain::download::human(total as u64)
                    )
                } else {
                    format!("{label} {} / {} {unit}", done as u64, total as u64)
                }
            } else {
                label.to_string()
            };
            let frac = if total > 0.0 { done / total } else { 0.0 };
            ctx.stage_progress(frac, Some(detail.trim().to_string()));
        }
        Some("stage") => {
            if let Some(l) = v["label"].as_str() {
                ctx.log(format!("· {l}"));
                ctx.stage_detail(l);
            }
        }
        Some("log") => {
            if let Some(m) = v["message"].as_str() {
                let lvl = v["level"].as_str().unwrap_or("info");
                ctx.log(if lvl == "warn" {
                    format!("⚠ {m}")
                } else {
                    m.to_string()
                });
            }
        }
        Some("tensor") | Some("layout") => ctx.tensor(v.clone()),
        Some("metric") => {
            if let (Some(n), Some(val)) = (v["name"].as_str(), v["value"].as_f64()) {
                ctx.metric(n, val, v["step"].as_i64());
            }
        }
        _ => {}
    }
}

/// Runs a driver to completion inside a job, returning its `result` event.
pub async fn run(ctx: &JobCtx, spec: &Spawn, mut on_event: impl FnMut(&Value)) -> AppResult<Value> {
    let mut result: Option<Value> = None;
    let mut error: Option<Value> = None;
    let outcome = ctx
        .exec(spec, |_, line| {
            if let Some(v) = parse_event(line) {
                match v["t"].as_str() {
                    Some("result") => result = Some(v.clone()),
                    Some("error") => error = Some(v.clone()),
                    _ => {}
                }
                forward_event(ctx, &v);
                on_event(&v);
            }
        })
        .await?;
    if let Some(e) = error {
        let mut err = AppError::new(
            "driver",
            e["message"]
                .as_str()
                .unwrap_or("The driver reported an error")
                .to_string(),
        );
        if let Some(h) = e["hint"].as_str() {
            err = err.with_hint(h.to_string());
        }
        return Err(err);
    }
    let name = spec
        .args
        .get(4)
        .map(|a| a.to_string_lossy().to_string())
        .unwrap_or_default();
    outcome.ensure_success(
        std::path::Path::new(&name)
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .as_deref()
            .unwrap_or("Driver"),
    )?;
    result.ok_or_else(|| AppError::new("driver", "The driver finished without a result"))
}
