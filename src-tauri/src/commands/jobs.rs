use crate::error::{AppError, AppResult};
use crate::jobs::{get_job, job_logs as read_logs, list_jobs, JobRow};
use crate::state::AppState;
use serde_json::Value;
use tauri::State;

#[tauri::command]
pub fn jobs_list(
    state: State<'_, AppState>,
    kind: Option<String>,
    limit: Option<i64>,
) -> AppResult<Vec<JobRow>> {
    list_jobs(&state.db, kind.as_deref(), limit.unwrap_or(200))
}

#[tauri::command]
pub fn job_get(state: State<'_, AppState>, id: String) -> AppResult<JobRow> {
    get_job(&state.db, &id)
}

#[tauri::command]
pub fn job_logs(
    state: State<'_, AppState>,
    id: String,
    after: Option<i64>,
    limit: Option<i64>,
) -> AppResult<Vec<Value>> {
    read_logs(&state.db, &id, after.unwrap_or(0), limit.unwrap_or(5000))
}

#[tauri::command]
pub fn job_cancel(state: State<'_, AppState>, id: String) -> AppResult<bool> {
    Ok(state.jobs.cancel(&id))
}

#[tauri::command]
pub fn job_delete(state: State<'_, AppState>, id: String) -> AppResult<()> {
    if state.jobs.is_active(&id) {
        return Err(AppError::invalid("Cancel the job before deleting it"));
    }
    state
        .db
        .with(|c| c.execute("DELETE FROM jobs WHERE id = ?1", [&id]))?;
    let _ = std::fs::remove_dir_all(state.paths.job_dir(&id));
    Ok(())
}
