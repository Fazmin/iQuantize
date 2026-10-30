use crate::error::AppResult;
use crate::jobs::{Lane, NewJob, StageDef};
use crate::state::AppState;
use crate::toolchain::{self, MANIFEST};
use serde_json::{json, Value};
use tauri::State;

#[tauri::command]
pub fn toolchain_status(state: State<'_, AppState>) -> AppResult<Value> {
    Ok(json!({
        "components": toolchain::status(&state)?,
        "platform_key": toolchain::platform_key(&state),
        "llama_tag": MANIFEST.llama_cpp.tag,
        "uv_version": MANIFEST.uv.version,
        "python_version": MANIFEST.python.version,
    }))
}

#[tauri::command]
pub fn toolchain_install(
    state: State<'_, AppState>,
    components: Vec<String>,
    variant: Option<String>,
    force: Option<bool>,
) -> AppResult<String> {
    toolchain::submit_install(&state, components, variant, force.unwrap_or(false))
}

/// Installs every required component plus the optional ones this machine supports.
#[tauri::command]
pub fn toolchain_install_all(state: State<'_, AppState>) -> AppResult<String> {
    let targets: Vec<String> = toolchain::status(&state)?
        .into_iter()
        .filter(|c| c.supported && c.status != "installed")
        .map(|c| c.id)
        .collect();
    toolchain::submit_install(&state, targets, None, false)
}

#[tauri::command]
pub fn toolchain_remove(state: State<'_, AppState>, id: String) -> AppResult<()> {
    toolchain::remove(&state, &id)
}

#[tauri::command]
pub fn toolchain_capabilities(state: State<'_, AppState>) -> AppResult<Value> {
    toolchain::capabilities(&state)
}

#[tauri::command]
pub async fn toolchain_doctor(state: State<'_, AppState>) -> AppResult<Value> {
    toolchain::doctor(&state).await
}

/// Re-runs every capability probe (e.g. after a manual repair).
#[tauri::command]
pub fn toolchain_reprobe(state: State<'_, AppState>) -> AppResult<String> {
    let st = state.inner().clone();
    let envs: Vec<String> = ["gguf", "mlx", "onnx", "core"]
        .iter()
        .filter(|e| toolchain::is_installed(&st, &format!("env_{e}")))
        .map(|e| e.to_string())
        .collect();
    let mut stages = vec![StageDef::new("llama", "Probe llama.cpp", 1.0)];
    stages.extend(
        envs.iter()
            .map(|e| StageDef::new(e, format!("Probe {e} environment"), 1.0)),
    );
    state.jobs.submit(
        NewJob {
            kind: "install",
            title: "Re-probe tool capabilities".into(),
            model_id: None,
            format: None,
            params: json!({ "components": [] }),
            stages,
            lane: Lane::Install,
        },
        move |ctx| async move {
            if toolchain::is_installed(&st, "llama_cpp") {
                ctx.stage("llama")?;
                toolchain::probe_llama(&st, &ctx).await?;
            }
            for e in &envs {
                ctx.stage(e)?;
                if let Err(err) = toolchain::probe_env(&st, &ctx, e).await {
                    ctx.log(format!("⚠ {e}: {}", err.message));
                }
            }
            toolchain::emit_changed(&st);
            Ok(json!({}))
        },
    )
}
