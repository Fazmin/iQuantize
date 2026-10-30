//! Shared application state. Cheap to clone (all fields are Arc/handles) so command
//! handlers can move a copy into background tasks.

use crate::db::Db;
use crate::error::AppResult;
use crate::events::EventHub;
use crate::jobs::JobManager;
use crate::paths::Paths;
use crate::platform::{self, PlatformInfo};
use crate::secrets::Secrets;
use std::collections::HashMap;
use std::sync::{Arc, Mutex, RwLock};
use tauri::{AppHandle, Manager};
use tokio_util::sync::CancellationToken;

#[derive(Clone)]
pub struct AppState {
    pub paths: Arc<Paths>,
    pub db: Arc<Db>,
    pub http: reqwest::Client,
    pub secrets: Arc<Secrets>,
    pub hub: EventHub,
    pub jobs: Arc<JobManager>,
    pub platform: Arc<RwLock<PlatformInfo>>,
    pub sys: Arc<Mutex<sysinfo::System>>,
    /// Cancellable streams (AI generation, arena turns) keyed by stream id.
    pub streams: Arc<Mutex<HashMap<String, CancellationToken>>>,
    pub runners: Arc<crate::eval::runner::RunnerManager>,
}

pub const USER_AGENT: &str = concat!("iQuantize/", env!("CARGO_PKG_VERSION"));

impl AppState {
    pub fn init(app: &AppHandle) -> AppResult<Self> {
        let data = app.path().app_data_dir()?;
        std::fs::create_dir_all(&data)?;
        let db = Arc::new(Db::open(&data.join("iquantize.db"))?);
        let workspace = db
            .setting("workspace")?
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|| Paths::default_workspace(&data));
        let paths = Arc::new(Paths::new(data.clone(), workspace));
        paths.ensure_all()?;
        if let Err(e) = crate::embedded::install_drivers(&paths) {
            tracing::warn!("could not write drivers: {e}");
        }
        let jobs_paths = paths.clone();
        let hub = EventHub::start(app.clone(), db.clone(), move || jobs_paths.jobs());
        let concurrency = db
            .setting("concurrency")?
            .and_then(|v| v.parse().ok())
            .unwrap_or(1usize);
        let jobs = Arc::new(JobManager::new(db.clone(), hub.clone(), concurrency));
        jobs.recover_interrupted()?;
        let http = reqwest::Client::builder()
            .user_agent(USER_AGENT)
            .connect_timeout(std::time::Duration::from_secs(20))
            .build()?;
        let secrets = Arc::new(Secrets::new(db.clone(), data));
        let platform = Arc::new(RwLock::new(platform::basic()));
        let detect_target = platform.clone();
        std::thread::spawn(move || {
            let info = platform::detect();
            if let Ok(mut p) = detect_target.write() {
                *p = info;
            }
        });
        let runners = Arc::new(crate::eval::runner::RunnerManager::new(hub.clone()));
        Ok(Self {
            paths,
            db,
            http,
            secrets,
            hub,
            jobs,
            platform,
            sys: Arc::new(Mutex::new(sysinfo::System::new())),
            streams: Arc::new(Mutex::new(HashMap::new())),
            runners,
        })
    }

    pub fn platform(&self) -> PlatformInfo {
        self.platform
            .read()
            .map(|p| p.clone())
            .unwrap_or_else(|_| platform::basic())
    }

    pub fn setting_or(&self, key: &str, default: &str) -> String {
        self.db
            .setting(key)
            .ok()
            .flatten()
            .unwrap_or_else(|| default.to_string())
    }

    pub fn register_stream(&self, id: &str) -> CancellationToken {
        let tok = CancellationToken::new();
        if let Ok(mut m) = self.streams.lock() {
            m.insert(id.to_string(), tok.clone());
        }
        tok
    }

    pub fn end_stream(&self, id: &str) {
        if let Ok(mut m) = self.streams.lock() {
            m.remove(id);
        }
    }

    pub fn cancel_stream(&self, id: &str) -> bool {
        self.streams
            .lock()
            .ok()
            .and_then(|m| m.get(id).cloned())
            .map(|t| t.cancel())
            .is_some()
    }

    /// Standard environment for Python children: isolated HF cache, no telemetry.
    pub fn python_env(&self, with_hf_token: bool) -> Vec<(String, String)> {
        let mut env = vec![
            (
                "HF_HOME".to_string(),
                self.paths.hf_cache().to_string_lossy().to_string(),
            ),
            ("HF_HUB_DISABLE_TELEMETRY".to_string(), "1".to_string()),
            ("HF_HUB_DISABLE_PROGRESS_BARS".to_string(), "0".to_string()),
            ("TOKENIZERS_PARALLELISM".to_string(), "false".to_string()),
            ("PYTHONUNBUFFERED".to_string(), "1".to_string()),
            ("PYTHONIOENCODING".to_string(), "utf-8".to_string()),
            ("DO_NOT_TRACK".to_string(), "1".to_string()),
        ];
        if with_hf_token {
            if let Ok(Some(tok)) = self.secrets.get(crate::secrets::HF_TOKEN) {
                env.push(("HF_TOKEN".to_string(), tok.to_string()));
            }
        }
        env
    }
}
