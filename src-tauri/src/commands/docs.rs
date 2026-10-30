use crate::error::{AppError, AppResult};
use crate::state::AppState;
use serde_json::{json, Value};
use tauri::State;

#[tauri::command]
pub fn docs_list(state: State<'_, AppState>) -> AppResult<Vec<Value>> {
    crate::docs::list(&state)
}

#[tauri::command]
pub fn doc_create(
    state: State<'_, AppState>,
    model_id: String,
    artifact_ids: Vec<String>,
    title: Option<String>,
) -> AppResult<String> {
    crate::docs::create(&state, &model_id, artifact_ids, title)
}

#[tauri::command]
pub fn doc_get(state: State<'_, AppState>, id: String) -> AppResult<Value> {
    crate::docs::get(&state, &id)
}

#[tauri::command]
pub fn doc_save(
    state: State<'_, AppState>,
    id: String,
    markdown: String,
    source: Option<String>,
    ai_model: Option<String>,
) -> AppResult<()> {
    crate::docs::save(
        &state,
        &id,
        &markdown,
        source.as_deref().unwrap_or("manual"),
        ai_model.as_deref(),
    )
}

#[tauri::command]
pub fn doc_versions(state: State<'_, AppState>, id: String) -> AppResult<Vec<Value>> {
    crate::docs::versions(&state, &id)
}

#[tauri::command]
pub fn doc_delete(state: State<'_, AppState>, id: String) -> AppResult<()> {
    crate::docs::delete(&state, &id)
}

#[tauri::command]
pub fn doc_render(markdown: String) -> String {
    crate::docs::render(&markdown)
}

#[tauri::command]
pub fn doc_template(
    state: State<'_, AppState>,
    id: String,
    repo_id: Option<String>,
) -> AppResult<String> {
    crate::docs::regenerate(&state, &id, repo_id.as_deref())
}

/// Numbers in `text` that don't appear in the provenance or the template.
#[tauri::command]
pub fn doc_guard(
    state: State<'_, AppState>,
    id: String,
    text: String,
) -> AppResult<Vec<crate::docs::guard::Flag>> {
    let d = crate::docs::get(&state, &id)?;
    let template = crate::docs::card::template(&d["provenance"], d["repo_id"].as_str());
    Ok(crate::docs::guard::check(
        &text,
        &d["provenance"],
        &template,
    ))
}

#[tauri::command]
pub async fn ai_models(state: State<'_, AppState>, refresh: Option<bool>) -> AppResult<Value> {
    crate::ai::models(&state, refresh.unwrap_or(false)).await
}

/// Starts an AI writing action; text streams as `ai:delta` events. Returns the stream id.
#[tauri::command]
pub fn ai_generate(
    state: State<'_, AppState>,
    document_id: String,
    action: String,
    model: String,
    effort: Option<String>,
    selection: Option<String>,
    markdown: Option<String>,
) -> AppResult<String> {
    let d = crate::docs::get(&state, &document_id)?;
    if state.secrets.get(crate::secrets::OPENAI_KEY)?.is_none() {
        return Err(
            AppError::new("missing_secret", "No OpenAI API key is configured")
                .with_hint("Add one in Settings → Accounts."),
        );
    }
    let template = crate::docs::card::template(&d["provenance"], d["repo_id"].as_str());
    let current =
        markdown.unwrap_or_else(|| d["markdown"].as_str().unwrap_or_default().to_string());
    let input = format!(
        "PROVENANCE JSON:\n{}\n\nTEMPLATE:\n{}\n\nCURRENT DOCUMENT:\n{}\n\nSELECTION:\n{}",
        serde_json::to_string_pretty(&d["provenance"])?,
        template,
        current,
        selection.unwrap_or_default()
    );
    let stream = crate::db::new_id();
    let cancel = state.register_stream(&stream);
    let st = state.inner().clone();
    let sid = stream.clone();
    tauri::async_runtime::spawn(async move {
        let r = crate::ai::generate(
            &st,
            &sid,
            &model,
            effort.as_deref(),
            &action,
            &input,
            Some(&document_id),
            cancel,
        )
        .await;
        if let Err(e) = r {
            st.hub.emit(
                "ai:error",
                json!({ "stream": sid, "message": e.message, "hint": e.hint, "code": e.code }),
            );
        }
        st.end_stream(&sid);
    });
    Ok(stream)
}

#[tauri::command]
pub fn ai_cancel(state: State<'_, AppState>, stream: String) -> bool {
    state.cancel_stream(&stream)
}

#[tauri::command]
pub async fn publish_prepare(
    state: State<'_, AppState>,
    document_id: String,
    repo_id: String,
) -> AppResult<Value> {
    crate::publish::prepare(&state, &document_id, repo_id.trim()).await
}

#[tauri::command]
pub fn publish_start(
    state: State<'_, AppState>,
    document_id: String,
    repo_id: String,
    private: bool,
    message: Option<String>,
) -> AppResult<String> {
    crate::publish::submit(
        &state,
        document_id,
        repo_id.trim().to_string(),
        private,
        message.unwrap_or_default(),
    )
}

#[tauri::command]
pub fn uploads_list(state: State<'_, AppState>) -> AppResult<Vec<Value>> {
    crate::publish::uploads(&state)
}
