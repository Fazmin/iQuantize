use crate::error::AppResult;
use crate::models::{self, tensors::TensorInfo, ModelRow};
use crate::state::AppState;
use serde_json::Value;
use tauri::State;

#[tauri::command]
pub async fn hf_whoami(state: State<'_, AppState>) -> AppResult<Value> {
    crate::hub::whoami(&state).await
}

#[tauri::command]
pub async fn hub_search(
    state: State<'_, AppState>,
    query: String,
    sort: Option<String>,
    limit: Option<u32>,
    cursor: Option<String>,
) -> AppResult<Value> {
    crate::hub::search(
        &state,
        &query,
        sort.as_deref().unwrap_or("downloads"),
        limit.unwrap_or(50),
        cursor.as_deref(),
    )
    .await
}

#[tauri::command]
pub async fn hub_model_info(
    state: State<'_, AppState>,
    repo_id: String,
    revision: Option<String>,
) -> AppResult<Value> {
    crate::hub::model_info(&state, repo_id.trim(), revision.as_deref()).await
}

#[tauri::command]
pub async fn hub_repo_status(state: State<'_, AppState>, repo_id: String) -> AppResult<Value> {
    crate::hub::repo_status(&state, repo_id.trim()).await
}

#[tauri::command]
pub fn models_list(state: State<'_, AppState>) -> AppResult<Vec<ModelRow>> {
    models::list(&state)
}

#[tauri::command]
pub fn model_get(state: State<'_, AppState>, id: String) -> AppResult<Value> {
    models::detail(&state, &id)
}

#[tauri::command]
pub fn model_delete(state: State<'_, AppState>, id: String, delete_files: bool) -> AppResult<()> {
    models::delete(&state, &id, delete_files)
}

#[tauri::command]
pub async fn model_import_local(state: State<'_, AppState>, path: String) -> AppResult<Value> {
    let st = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || models::import_local(&st, &path))
        .await
        .map_err(|e| crate::error::AppError::new("import", e.to_string()))?
}

#[tauri::command]
pub fn model_download(
    state: State<'_, AppState>,
    repo_id: String,
    revision: Option<String>,
) -> AppResult<String> {
    models::submit_download(&state, repo_id.trim().to_string(), revision)
}

#[tauri::command]
pub async fn model_tensors(state: State<'_, AppState>, id: String) -> AppResult<Vec<TensorInfo>> {
    let st = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || models::model_tensors(&st, &id))
        .await
        .map_err(|e| crate::error::AppError::new("tensors", e.to_string()))?
}
