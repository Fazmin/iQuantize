use crate::error::{AppError, AppResult};
use crate::eval::{self, runner::GenParams};
use crate::quant::recipe::EvalSpec;
use crate::state::AppState;
use serde_json::Value;
use tauri::State;

fn params(v: Option<Value>) -> AppResult<GenParams> {
    serde_json::from_value(v.unwrap_or_else(|| serde_json::json!({})))
        .map_err(|e| AppError::invalid(format!("Invalid parameters: {e}")))
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn arena_run(
    state: State<'_, AppState>,
    a: String,
    b: String,
    prompt: String,
    system: Option<String>,
    history: Option<Vec<Value>>,
    params_json: Option<Value>,
    sequential: Option<bool>,
) -> AppResult<String> {
    if prompt.trim().is_empty() {
        return Err(AppError::invalid("Type a prompt first"));
    }
    eval::arena_run(
        &state,
        a,
        b,
        system,
        prompt,
        history.unwrap_or_default(),
        params(params_json)?,
        sequential.unwrap_or(false),
    )
}

#[tauri::command]
pub fn arena_cancel(state: State<'_, AppState>, stream: String) -> bool {
    state.cancel_stream(&stream)
}

#[tauri::command]
pub fn arena_vote(state: State<'_, AppState>, turn_id: i64, vote: String) -> AppResult<()> {
    eval::arena_vote(&state, turn_id, &vote)
}

#[tauri::command]
pub fn arena_history(state: State<'_, AppState>, a: String, b: String) -> AppResult<Vec<Value>> {
    eval::arena_history(&state, &a, &b)
}

#[tauri::command]
pub async fn runners_list(state: State<'_, AppState>) -> AppResult<Vec<eval::runner::RunnerInfo>> {
    Ok(state.runners.list().await)
}

#[tauri::command]
pub async fn runner_stop(state: State<'_, AppState>, artifact_id: Option<String>) -> AppResult<()> {
    match artifact_id {
        Some(id) => state.runners.stop(&id).await,
        None => state.runners.stop_all().await,
    }
    Ok(())
}

#[tauri::command]
pub fn suites_list(state: State<'_, AppState>) -> AppResult<Vec<Value>> {
    eval::suites(&state)
}

#[tauri::command]
pub fn suite_save(
    state: State<'_, AppState>,
    name: String,
    description: Option<String>,
    prompts: Vec<Value>,
) -> AppResult<String> {
    eval::suite_save(
        &state,
        &name,
        description.as_deref().unwrap_or(""),
        &prompts,
    )
}

#[tauri::command]
pub fn suite_delete(state: State<'_, AppState>, id: String) -> AppResult<()> {
    eval::suite_delete(&state, &id)
}

#[tauri::command]
pub fn suite_run(
    state: State<'_, AppState>,
    suite_id: String,
    artifact_ids: Vec<String>,
    params_json: Option<Value>,
) -> AppResult<String> {
    eval::submit_suite(&state, suite_id, artifact_ids, params(params_json)?)
}

#[tauri::command]
pub fn eval_speed(
    state: State<'_, AppState>,
    artifact_ids: Vec<String>,
    prompt_tokens: Option<u32>,
    gen_tokens: Option<u32>,
    repeats: Option<u32>,
) -> AppResult<String> {
    eval::submit_speed(
        &state,
        artifact_ids,
        prompt_tokens.unwrap_or(512),
        gen_tokens.unwrap_or(128),
        repeats.unwrap_or(3),
    )
}

#[tauri::command]
pub fn eval_quality(
    state: State<'_, AppState>,
    artifact_ids: Vec<String>,
    reference_id: String,
    chunks: Option<u32>,
    ctx: Option<u32>,
) -> AppResult<String> {
    let spec = EvalSpec {
        chunks: chunks.unwrap_or(40),
        ctx: ctx.unwrap_or(512),
        ..Default::default()
    };
    eval::submit_quality(&state, artifact_ids, reference_id, spec)
}
