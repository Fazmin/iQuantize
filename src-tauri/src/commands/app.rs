//! Window, shell and system commands. The frontend never touches plugin JS APIs; it calls
//! these instead.

use crate::error::{AppError, AppResult};
use crate::state::AppState;
use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager, State, Theme, WebviewWindow};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

fn main_window(app: &AppHandle) -> AppResult<WebviewWindow> {
    app.get_webview_window("main")
        .ok_or_else(|| AppError::not_found("Main window"))
}

#[tauri::command]
pub fn app_info(state: State<'_, AppState>) -> AppResult<Value> {
    let first_run = state.db.setting("onboarded")?.is_none();
    Ok(json!({
        "version": env!("CARGO_PKG_VERSION"),
        "platform": state.platform(),
        "memory_budget": crate::platform::memory_budget(&state.platform()),
        "paths": {
            "data": state.paths.data,
            "workspace": state.paths.workspace(),
            "models": state.paths.models(),
            "outputs": state.paths.outputs(),
        },
        "secrets_backend": state.secrets.backend(),
        "first_run": first_run,
        "active_jobs": state.jobs.active_ids(),
    }))
}

#[tauri::command]
pub fn app_ready(app: AppHandle) -> AppResult<()> {
    let w = main_window(&app)?;
    w.show()?;
    w.set_focus()?;
    Ok(())
}

#[tauri::command]
pub fn window_action(app: AppHandle, action: String) -> AppResult<Value> {
    let w = main_window(&app)?;
    match action.as_str() {
        "minimize" => w.minimize()?,
        "toggle_maximize" => {
            if w.is_maximized()? {
                w.unmaximize()?
            } else {
                w.maximize()?
            }
        }
        "close" => w.close()?,
        "fullscreen" => w.set_fullscreen(!w.is_fullscreen()?)?,
        _ => return Err(AppError::invalid(format!("Unknown window action {action}"))),
    }
    Ok(json!({ "maximized": w.is_maximized().unwrap_or(false) }))
}

#[tauri::command]
pub fn set_theme(app: AppHandle, state: State<'_, AppState>, theme: String) -> AppResult<()> {
    let t = match theme.as_str() {
        "light" => Some(Theme::Light),
        "dark" => Some(Theme::Dark),
        "system" => None,
        _ => return Err(AppError::invalid("Theme must be light, dark or system")),
    };
    main_window(&app)?.set_theme(t)?;
    state.db.set_setting("theme", &theme)?;
    Ok(())
}

#[tauri::command]
pub fn open_external(app: AppHandle, url: String) -> AppResult<()> {
    if !url.starts_with("https://") {
        return Err(AppError::invalid("Only https links can be opened"));
    }
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|e| AppError::new("opener", e.to_string()))
}

#[tauri::command]
pub fn reveal_path(app: AppHandle, path: String) -> AppResult<()> {
    let p = std::path::PathBuf::from(&path);
    if !p.exists() {
        return Err(AppError::not_found(path));
    }
    app.opener()
        .reveal_item_in_dir(p)
        .map_err(|e| AppError::new("opener", e.to_string()))
}

#[tauri::command]
pub async fn pick_folder(app: AppHandle, title: Option<String>) -> AppResult<Option<String>> {
    let mut d = app.dialog().file();
    if let Some(t) = title {
        d = d.set_title(t);
    }
    let picked = tauri::async_runtime::spawn_blocking(move || d.blocking_pick_folder())
        .await
        .map_err(|e| AppError::new("dialog", e.to_string()))?;
    Ok(picked
        .and_then(|p| p.into_path().ok())
        .map(|p| p.to_string_lossy().to_string()))
}

#[tauri::command]
pub async fn pick_file(
    app: AppHandle,
    title: Option<String>,
    extensions: Option<Vec<String>>,
) -> AppResult<Option<String>> {
    let mut d = app.dialog().file();
    if let Some(t) = title {
        d = d.set_title(t);
    }
    if let Some(exts) = extensions.filter(|e| !e.is_empty()) {
        let refs: Vec<&str> = exts.iter().map(String::as_str).collect();
        d = d.add_filter("Supported files", &refs);
    }
    let picked = tauri::async_runtime::spawn_blocking(move || d.blocking_pick_file())
        .await
        .map_err(|e| AppError::new("dialog", e.to_string()))?;
    Ok(picked
        .and_then(|p| p.into_path().ok())
        .map(|p| p.to_string_lossy().to_string()))
}

#[derive(Serialize)]
pub struct SystemStats {
    cpu: f32,
    ram_used: u64,
    ram_total: u64,
    disk_free: Option<u64>,
    children_rss: u64,
}

#[tauri::command]
pub fn system_stats(state: State<'_, AppState>) -> AppResult<SystemStats> {
    let mut sys = state
        .sys
        .lock()
        .map_err(|_| AppError::new("sys", "lock poisoned"))?;
    sys.refresh_memory();
    sys.refresh_cpu_usage();
    sys.refresh_processes(sysinfo::ProcessesToUpdate::All, true);
    let me = sysinfo::Pid::from_u32(std::process::id());
    // Sum RSS of every descendant process (quantizers, servers, drivers).
    let mut children_rss = 0u64;
    for p in sys.processes().values() {
        let mut parent = p.parent();
        let mut depth = 0;
        while let Some(pp) = parent {
            if pp == me {
                children_rss += p.memory();
                break;
            }
            depth += 1;
            if depth > 8 {
                break;
            }
            parent = sys.process(pp).and_then(|x| x.parent());
        }
    }
    Ok(SystemStats {
        cpu: sys.global_cpu_usage(),
        ram_used: sys.used_memory(),
        ram_total: sys.total_memory(),
        disk_free: crate::paths::free_space(&state.paths.workspace()),
        children_rss,
    })
}

#[tauri::command]
pub async fn platform_refresh(
    state: State<'_, AppState>,
) -> AppResult<crate::platform::PlatformInfo> {
    let info = tauri::async_runtime::spawn_blocking(crate::platform::detect)
        .await
        .map_err(|e| AppError::new("platform", e.to_string()))?;
    if let Ok(mut p) = state.platform.write() {
        *p = info.clone();
    }
    Ok(info)
}

#[tauri::command]
pub async fn notify(app: AppHandle, title: String, body: String) -> AppResult<()> {
    use tauri_plugin_notification::NotificationExt;
    let focused = main_window(&app)
        .and_then(|w| Ok(w.is_focused()?))
        .unwrap_or(false);
    if !focused {
        let _ = app.notification().builder().title(title).body(body).show();
    }
    Ok(())
}

/// Frontend log/error forwarding (so WebView errors show up in the app's log).
#[tauri::command]
pub fn dev_log(level: String, message: String) {
    let msg: String = message.chars().take(4000).collect();
    match level.as_str() {
        "error" => tracing::error!(target: "frontend", "{msg}"),
        "warn" => tracing::warn!(target: "frontend", "{msg}"),
        _ => tracing::info!(target: "frontend", "{msg}"),
    }
}

/// Debug builds only: returns the automation script named by IQUANTIZE_DEV_SCRIPT.
#[tauri::command]
pub fn dev_script() -> Option<Value> {
    if !cfg!(debug_assertions) {
        return None;
    }
    let path = std::env::var("IQUANTIZE_DEV_SCRIPT").ok()?;
    let text = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&text).ok()
}

/// Debug builds only: saves a JSON value to IQUANTIZE_DEV_DUMP/<name>.json (UI fixtures).
#[tauri::command]
pub fn dev_dump(name: String, value: Value) -> AppResult<()> {
    if !cfg!(debug_assertions) {
        return Ok(());
    }
    let Ok(dir) = std::env::var("IQUANTIZE_DEV_DUMP") else {
        return Ok(());
    };
    let safe: String = name
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-')
        .collect();
    std::fs::create_dir_all(&dir)?;
    std::fs::write(
        std::path::Path::new(&dir).join(format!("{safe}.json")),
        serde_json::to_string_pretty(&value)?,
    )?;
    Ok(())
}
