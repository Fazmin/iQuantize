//! Folder layout. App-private tooling lives under the app data dir; bulky user data
//! (models, outputs, caches) lives under a configurable workspace folder.

use std::path::{Path, PathBuf};
use std::sync::RwLock;

pub struct Paths {
    pub data: PathBuf,
    workspace: RwLock<PathBuf>,
}

impl Paths {
    pub fn new(data: PathBuf, workspace: PathBuf) -> Self {
        Self {
            data,
            workspace: RwLock::new(workspace),
        }
    }

    pub fn default_workspace(data: &Path) -> PathBuf {
        data.join("workspace")
    }

    pub fn tools(&self) -> PathBuf {
        self.data.join("tools")
    }
    pub fn uv_bin(&self) -> PathBuf {
        self.tools()
            .join("uv")
            .join(format!("uv{}", std::env::consts::EXE_SUFFIX))
    }
    pub fn python_installs(&self) -> PathBuf {
        self.data.join("python")
    }
    pub fn envs(&self) -> PathBuf {
        self.data.join("envs")
    }
    pub fn env(&self, name: &str) -> PathBuf {
        self.envs().join(name)
    }
    pub fn env_python(&self, name: &str) -> PathBuf {
        let env = self.env(name);
        if cfg!(windows) {
            env.join("Scripts").join("python.exe")
        } else {
            env.join("bin").join("python")
        }
    }
    pub fn llama_dir(&self) -> PathBuf {
        self.tools().join("llama.cpp")
    }
    pub fn llama_bin(&self, name: &str) -> PathBuf {
        self.llama_dir()
            .join("bin")
            .join(format!("{name}{}", std::env::consts::EXE_SUFFIX))
    }
    pub fn llama_src(&self) -> PathBuf {
        self.llama_dir().join("src")
    }
    pub fn convert_script(&self) -> PathBuf {
        self.llama_src().join("convert_hf_to_gguf.py")
    }
    pub fn drivers(&self) -> PathBuf {
        self.data.join("drivers")
    }
    pub fn driver(&self, name: &str) -> PathBuf {
        self.drivers().join(name)
    }
    pub fn uv_cache(&self) -> PathBuf {
        self.data.join("cache").join("uv")
    }
    pub fn downloads_tmp(&self) -> PathBuf {
        self.data.join("cache").join("downloads")
    }

    pub fn workspace(&self) -> PathBuf {
        self.workspace
            .read()
            .map(|w| w.clone())
            .unwrap_or_else(|_| Self::default_workspace(&self.data))
    }
    pub fn set_workspace(&self, p: PathBuf) {
        if let Ok(mut w) = self.workspace.write() {
            *w = p;
        }
    }
    pub fn models(&self) -> PathBuf {
        self.workspace().join("models")
    }
    pub fn outputs(&self) -> PathBuf {
        self.workspace().join("outputs")
    }
    pub fn hf_cache(&self) -> PathBuf {
        self.workspace().join("hf-cache")
    }
    pub fn jobs(&self) -> PathBuf {
        self.workspace().join("jobs")
    }
    pub fn job_dir(&self, id: &str) -> PathBuf {
        self.jobs().join(id)
    }
    pub fn calibration(&self) -> PathBuf {
        self.workspace().join("calibration")
    }
    pub fn cache(&self) -> PathBuf {
        self.workspace().join("cache")
    }
    pub fn eval(&self) -> PathBuf {
        self.workspace().join("eval")
    }
    pub fn docs(&self) -> PathBuf {
        self.workspace().join("docs")
    }

    pub fn ensure_all(&self) -> std::io::Result<()> {
        for p in [
            self.data.clone(),
            self.tools(),
            self.envs(),
            self.drivers(),
            self.uv_cache(),
            self.downloads_tmp(),
            self.models(),
            self.outputs(),
            self.hf_cache(),
            self.jobs(),
            self.calibration(),
            self.cache(),
            self.eval(),
            self.docs(),
        ] {
            std::fs::create_dir_all(p)?;
        }
        Ok(())
    }
}

/// Recursively sums file sizes under a path (0 if missing).
pub fn dir_size(path: &Path) -> u64 {
    let Ok(meta) = std::fs::symlink_metadata(path) else {
        return 0;
    };
    if meta.is_file() {
        return meta.len();
    }
    if !meta.is_dir() {
        return 0;
    }
    let mut total = 0;
    if let Ok(rd) = std::fs::read_dir(path) {
        for e in rd.flatten() {
            total += dir_size(&e.path());
        }
    }
    total
}

/// Free bytes on the volume holding `path` (walks up to an existing ancestor).
pub fn free_space(path: &Path) -> Option<u64> {
    let disks = sysinfo::Disks::new_with_refreshed_list();
    let mut probe = path.to_path_buf();
    while !probe.exists() {
        probe = probe.parent()?.to_path_buf();
    }
    let probe = std::fs::canonicalize(&probe).unwrap_or(probe);
    disks
        .list()
        .iter()
        .filter(|d| probe.starts_with(d.mount_point()))
        .max_by_key(|d| d.mount_point().as_os_str().len())
        .map(|d| d.available_space())
}
