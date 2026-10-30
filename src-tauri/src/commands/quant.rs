use crate::db::{json_col, new_id, now_ms};
use crate::error::{AppError, AppResult};
use crate::quant::{self, artifacts, recipe::Recipe, recommend::Goal};
use crate::state::AppState;
use serde_json::{json, Value};
use tauri::State;

#[tauri::command]
pub fn quant_catalog(state: State<'_, AppState>) -> AppResult<Value> {
    Ok(quant::catalog_json(&state))
}

#[tauri::command]
pub async fn quant_estimate(
    state: State<'_, AppState>,
    model_id: String,
    recipe: Value,
) -> AppResult<Value> {
    let recipe: Recipe = serde_json::from_value(recipe)
        .map_err(|e| AppError::invalid(format!("Invalid recipe: {e}")))?;
    let st = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || quant::estimate_json(&st, &model_id, &recipe))
        .await
        .map_err(|e| AppError::new("estimate", e.to_string()))?
}

#[tauri::command]
pub async fn quant_recommend(
    state: State<'_, AppState>,
    model_id: String,
    goal: Value,
) -> AppResult<Value> {
    let goal: Goal = serde_json::from_value(goal)
        .map_err(|e| AppError::invalid(format!("Invalid goal: {e}")))?;
    let st = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || quant::recommend_json(&st, &model_id, &goal))
        .await
        .map_err(|e| AppError::new("recommend", e.to_string()))?
}

/// Starts one job per recipe (one per format). Returns the job ids.
#[tauri::command]
pub fn quant_start(
    state: State<'_, AppState>,
    model_id: String,
    recipes: Vec<Value>,
) -> AppResult<Vec<String>> {
    let parsed: Vec<Recipe> = recipes
        .into_iter()
        .map(|r| {
            serde_json::from_value(r).map_err(|e| AppError::invalid(format!("Invalid recipe: {e}")))
        })
        .collect::<AppResult<_>>()?;
    if parsed.is_empty() {
        return Err(AppError::invalid("Choose at least one format"));
    }
    parsed
        .into_iter()
        .map(|r| quant::submit(&state, &model_id, r))
        .collect()
}

#[tauri::command]
pub fn recipes_list(state: State<'_, AppState>) -> AppResult<Vec<Value>> {
    state.db.with(|c| {
        let mut s = c.prepare("SELECT id, name, format, params_json, builtin, created_at FROM recipes ORDER BY created_at DESC")?;
        let r = s.query_map([], |r| {
            Ok(json!({ "id": r.get::<_, String>(0)?, "name": r.get::<_, String>(1)?, "format": r.get::<_, String>(2)?, "params": json_col(r.get(3)?), "builtin": r.get::<_, i64>(4)? != 0, "created_at": r.get::<_, i64>(5)? }))
        })?;
        r.collect()
    })
}

#[tauri::command]
pub fn recipe_save(state: State<'_, AppState>, name: String, recipe: Value) -> AppResult<String> {
    let parsed: Recipe = serde_json::from_value(recipe.clone())
        .map_err(|e| AppError::invalid(format!("Invalid recipe: {e}")))?;
    let name = name.trim();
    if name.is_empty() {
        return Err(AppError::invalid("Give the recipe a name"));
    }
    let id = new_id();
    state.db.with(|c| {
        c.execute(
            "INSERT INTO recipes (id, name, format, params_json, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
            rusqlite::params![id, name, parsed.format(), recipe.to_string(), now_ms()],
        )
    })?;
    Ok(id)
}

#[tauri::command]
pub fn recipe_delete(state: State<'_, AppState>, id: String) -> AppResult<()> {
    state
        .db
        .with(|c| c.execute("DELETE FROM recipes WHERE id = ?1 AND builtin = 0", [id]))?;
    Ok(())
}

#[tauri::command]
pub fn artifacts_list(
    state: State<'_, AppState>,
    model_id: Option<String>,
) -> AppResult<Vec<artifacts::ArtifactRow>> {
    artifacts::list(&state, model_id.as_deref())
}

#[tauri::command]
pub fn artifact_get(state: State<'_, AppState>, id: String) -> AppResult<artifacts::ArtifactRow> {
    artifacts::get(&state, &id)
}

#[tauri::command]
pub fn artifact_tensors(state: State<'_, AppState>, id: String) -> AppResult<Vec<Value>> {
    artifacts::tensors_of(&state, &id)
}

#[tauri::command]
pub fn artifact_delete(
    state: State<'_, AppState>,
    id: String,
    delete_files: bool,
) -> AppResult<()> {
    artifacts::delete(&state, &id, delete_files)?;
    state.hub.emit("artifacts:changed", json!({}));
    Ok(())
}

#[tauri::command]
pub fn job_tensor_events(state: State<'_, AppState>, id: String) -> Vec<Value> {
    state.hub.tensor_history(&id)
}

#[tauri::command]
pub fn cache_list(state: State<'_, AppState>) -> AppResult<Vec<Value>> {
    artifacts::cache_list(&state)
}

#[tauri::command]
pub fn cache_clear(state: State<'_, AppState>) -> AppResult<u64> {
    artifacts::cache_clear(&state)
}

#[tauri::command]
pub fn calibration_list(state: State<'_, AppState>) -> AppResult<Vec<Value>> {
    state.db.with(|c| {
        let mut s = c.prepare("SELECT id, name, source, path, bytes, created_at FROM calibration_sets ORDER BY created_at DESC")?;
        let r = s.query_map([], |r| {
            Ok(json!({ "id": r.get::<_, String>(0)?, "name": r.get::<_, String>(1)?, "source": r.get::<_, String>(2)?, "path": r.get::<_, String>(3)?, "chars": r.get::<_, Option<i64>>(4)?, "created_at": r.get::<_, i64>(5)? }))
        })?;
        r.collect()
    })
}
