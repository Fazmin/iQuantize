use crate::error::{AppError, AppResult};
use crate::secrets::{SecretStatus, HF_TOKEN, OPENAI_KEY};
use crate::state::AppState;
use serde_json::{json, Map, Value};
use tauri::State;

/// Known settings with their defaults. Unknown keys are rejected.
pub const DEFAULTS: &[(&str, &str)] = &[
    ("theme", "system"),
    ("workspace", ""),
    ("concurrency", "1"),
    ("threads", "0"),
    ("keep_intermediates", "true"),
    ("notifications", "true"),
    ("accelerator", "auto"),
    ("ai_base_url", "https://api.openai.com/v1"),
    ("ai_default_model", "gpt-5.6-terra"),
    ("ai_effort", "medium"),
    ("hf_username", ""),
    ("sidebar_collapsed", "false"),
    ("nav_folded", ""),
    ("inspector_open", "false"),
    ("onboarded", ""),
    ("quantized_by", ""),
];

#[tauri::command]
pub fn settings_get(state: State<'_, AppState>) -> AppResult<Value> {
    let mut out = Map::new();
    for (k, d) in DEFAULTS {
        out.insert((*k).into(), Value::String((*d).into()));
    }
    let stored: Vec<(String, String)> = state.db.with(|c| {
        let mut st = c.prepare("SELECT key, value FROM settings")?;
        let rows = st.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
        rows.collect()
    })?;
    for (k, v) in stored {
        out.insert(k, Value::String(v));
    }
    out.insert(
        "workspace".into(),
        Value::String(state.paths.workspace().to_string_lossy().to_string()),
    );
    Ok(Value::Object(out))
}

#[tauri::command]
pub fn settings_set(state: State<'_, AppState>, key: String, value: String) -> AppResult<()> {
    if !DEFAULTS.iter().any(|(k, _)| *k == key) {
        return Err(AppError::invalid(format!("Unknown setting {key}")));
    }
    match key.as_str() {
        "workspace" => {
            let p = std::path::PathBuf::from(value.trim());
            if !p.is_absolute() {
                return Err(AppError::invalid("The workspace must be an absolute path"));
            }
            std::fs::create_dir_all(&p)?;
            state.paths.set_workspace(p);
            state.paths.ensure_all()?;
        }
        "concurrency" | "threads" => {
            value
                .parse::<u32>()
                .map_err(|_| AppError::invalid(format!("{key} must be a number")))?;
        }
        "ai_base_url"
            if !value.starts_with("https://")
                && !value.starts_with("http://127.0.0.1")
                && !value.starts_with("http://localhost") =>
        {
            return Err(AppError::invalid(
                "Base URL must use https (or a localhost server)",
            ));
        }
        _ => {}
    }
    state.db.set_setting(&key, value.trim())
}

fn check_secret_name(name: &str) -> AppResult<()> {
    if name != HF_TOKEN && name != OPENAI_KEY {
        return Err(AppError::invalid(format!("Unknown secret {name}")));
    }
    Ok(())
}

#[tauri::command]
pub fn secret_set(
    state: State<'_, AppState>,
    name: String,
    value: String,
) -> AppResult<SecretStatus> {
    check_secret_name(&name)?;
    state.secrets.set(&name, &value)
}

#[tauri::command]
pub fn secret_delete(state: State<'_, AppState>, name: String) -> AppResult<()> {
    check_secret_name(&name)?;
    state.secrets.delete(&name)?;
    if name == HF_TOKEN {
        state.db.set_setting("hf_username", "")?;
    }
    Ok(())
}

#[tauri::command]
pub fn secrets_status(state: State<'_, AppState>) -> AppResult<Value> {
    Ok(json!({ "items": state.secrets.status()?, "backend": state.secrets.backend() }))
}
