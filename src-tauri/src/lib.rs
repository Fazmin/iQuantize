//! iQuantize: Rust core of the desktop quantization workspace.

mod ai;
mod commands;
mod db;
mod docs;
mod driver;
mod embedded;
mod error;
mod eval;
mod events;
mod hub;
mod jobs;
mod models;
mod paths;
mod platform;
mod process;
mod publish;
mod quant;
mod secrets;
mod state;
mod toolchain;

use tauri::Manager;

pub fn run() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "iquantize_lib=info,frontend=info,warn".into()),
        )
        .init();

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.show();
                let _ = w.set_focus();
            }
        }))
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(
                    tauri_plugin_window_state::StateFlags::all()
                        - tauri_plugin_window_state::StateFlags::VISIBLE,
                )
                .build(),
        )
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            let state = state::AppState::init(app.handle())?;
            if let Some(w) = app.get_webview_window("main") {
                let theme = match state.setting_or("theme", "system").as_str() {
                    "light" => Some(tauri::Theme::Light),
                    "dark" => Some(tauri::Theme::Dark),
                    _ => None,
                };
                let _ = w.set_theme(theme);
            }
            // Free memory held by idle inference servers.
            let runners = state.runners.clone();
            tauri::async_runtime::spawn(async move {
                loop {
                    tokio::time::sleep(std::time::Duration::from_secs(60)).await;
                    runners.reap(std::time::Duration::from_secs(600)).await;
                }
            });
            app.manage(state);
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                let state = window.state::<state::AppState>().inner().clone();
                tauri::async_runtime::block_on(state.runners.stop_all());
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::app::app_info,
            commands::app::app_ready,
            commands::app::window_action,
            commands::app::set_theme,
            commands::app::open_external,
            commands::app::reveal_path,
            commands::app::pick_folder,
            commands::app::pick_file,
            commands::app::system_stats,
            commands::app::platform_refresh,
            commands::app::notify,
            commands::app::dev_log,
            commands::app::dev_script,
            commands::app::dev_dump,
            commands::settings::settings_get,
            commands::settings::settings_set,
            commands::settings::secret_set,
            commands::settings::secret_delete,
            commands::settings::secrets_status,
            commands::jobs::jobs_list,
            commands::jobs::job_get,
            commands::jobs::job_logs,
            commands::jobs::job_cancel,
            commands::jobs::job_delete,
            commands::toolchain::toolchain_status,
            commands::toolchain::toolchain_install,
            commands::toolchain::toolchain_install_all,
            commands::toolchain::toolchain_remove,
            commands::toolchain::toolchain_capabilities,
            commands::toolchain::toolchain_doctor,
            commands::toolchain::toolchain_reprobe,
            commands::models::hf_whoami,
            commands::models::hub_search,
            commands::models::hub_model_info,
            commands::models::hub_repo_status,
            commands::models::models_list,
            commands::models::model_get,
            commands::models::model_delete,
            commands::models::model_import_local,
            commands::models::model_download,
            commands::models::model_tensors,
            commands::quant::quant_catalog,
            commands::quant::quant_estimate,
            commands::quant::quant_recommend,
            commands::quant::quant_start,
            commands::quant::recipes_list,
            commands::quant::recipe_save,
            commands::quant::recipe_delete,
            commands::quant::artifacts_list,
            commands::quant::artifact_get,
            commands::quant::artifact_tensors,
            commands::quant::artifact_delete,
            commands::quant::job_tensor_events,
            commands::quant::cache_list,
            commands::quant::cache_clear,
            commands::quant::calibration_list,
            commands::eval::arena_run,
            commands::eval::arena_cancel,
            commands::eval::arena_vote,
            commands::eval::arena_history,
            commands::eval::runners_list,
            commands::eval::runner_stop,
            commands::eval::suites_list,
            commands::eval::suite_save,
            commands::eval::suite_delete,
            commands::eval::suite_run,
            commands::eval::eval_speed,
            commands::eval::eval_quality,
            commands::docs::docs_list,
            commands::docs::doc_create,
            commands::docs::doc_get,
            commands::docs::doc_save,
            commands::docs::doc_versions,
            commands::docs::doc_delete,
            commands::docs::doc_render,
            commands::docs::doc_template,
            commands::docs::doc_guard,
            commands::docs::ai_models,
            commands::docs::ai_generate,
            commands::docs::ai_cancel,
            commands::docs::publish_prepare,
            commands::docs::publish_start,
            commands::docs::uploads_list,
        ])
        .run(tauri::generate_context!())
        .expect("error while running iQuantize");
}
