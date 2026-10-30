//! One-click toolchain: uv → managed Python 3.12 → one venv per format, plus prebuilt
//! llama.cpp binaries for this OS/accelerator and the matching converter source.

pub mod download;
pub mod probe;

use crate::db::now_ms;
use crate::error::{AppError, AppResult};
use crate::jobs::{JobCtx, Lane, NewJob, StageDef};
use crate::paths::dir_size;
use crate::process::{capture, Spawn};
use crate::state::AppState;
use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::LazyLock;

#[derive(Debug, Deserialize)]
pub struct Manifest {
    pub uv: UvManifest,
    pub python: PythonManifest,
    pub llama_cpp: LlamaManifest,
    pub envs: HashMap<String, EnvManifest>,
}

#[derive(Debug, Deserialize)]
pub struct UvManifest {
    pub version: String,
    pub repo: String,
    pub assets: HashMap<String, String>,
}

#[derive(Debug, Deserialize)]
pub struct PythonManifest {
    pub version: String,
}

#[derive(Debug, Deserialize)]
pub struct LlamaManifest {
    pub tag: String,
    pub repo: String,
    pub source_keep: Vec<String>,
    pub variants: HashMap<String, Vec<Variant>>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Variant {
    pub id: String,
    pub accel: String,
    pub label: String,
    pub assets: Vec<String>,
    #[serde(default)]
    pub min_cuda: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct EnvManifest {
    #[serde(default)]
    pub packages: Vec<String>,
    #[serde(default)]
    pub cuda_packages: Option<Vec<String>>,
    #[serde(default)]
    pub optional_packages: Vec<String>,
    #[serde(default)]
    pub requirements_from_source: Option<String>,
    #[serde(default)]
    pub local_packages: Vec<String>,
    #[serde(default)]
    pub platforms: Option<Vec<String>>,
}

pub static MANIFEST: LazyLock<Manifest> = LazyLock::new(|| {
    serde_json::from_str(include_str!("../../resources/toolchain.json"))
        .expect("valid toolchain.json")
});

pub fn platform_key(st: &AppState) -> String {
    let p = st.platform();
    format!("{}-{}", p.os, p.arch)
}

struct ComponentDef {
    id: &'static str,
    label: &'static str,
    kb: &'static str,
    required: bool,
    deps: &'static [&'static str],
    description: &'static str,
}

const COMPONENTS: &[ComponentDef] = &[
    ComponentDef {
        id: "uv",
        label: "uv package manager",
        kb: "tc.uv",
        required: true,
        deps: &[],
        description: "Fast Python package and environment manager used to install everything else.",
    },
    ComponentDef {
        id: "python",
        label: "Python 3.12 (managed)",
        kb: "tc.python",
        required: true,
        deps: &["uv"],
        description: "A private Python just for iQuantize. Your system Python is never touched.",
    },
    ComponentDef {
        id: "llama_cpp",
        label: "llama.cpp tools",
        kb: "tc.llamacpp",
        required: true,
        deps: &[],
        description:
            "Quantizer, importance-matrix, perplexity, benchmark and inference server for GGUF.",
    },
    ComponentDef {
        id: "env_core",
        label: "Hub & data tools",
        kb: "tc.env.core",
        required: true,
        deps: &["python"],
        description: "Hugging Face uploads and calibration/evaluation datasets.",
    },
    ComponentDef {
        id: "env_gguf",
        label: "GGUF converter",
        kb: "tc.env.gguf",
        required: true,
        deps: &["python", "llama_cpp"],
        description: "Converts Hugging Face checkpoints into a full-precision GGUF file.",
    },
    ComponentDef {
        id: "env_mlx",
        label: "MLX",
        kb: "tc.env.mlx",
        required: false,
        deps: &["python"],
        description:
            "Apple's array framework and mlx-lm for fast, native quantized models on Apple Silicon.",
    },
    ComponentDef {
        id: "env_onnx",
        label: "ONNX Runtime GenAI",
        kb: "tc.env.onnx",
        required: false,
        deps: &["python"],
        description: "Builds INT4/INT8/FP16 ONNX models for Windows, the web, mobile and servers.",
    },
];

fn def(id: &str) -> AppResult<&'static ComponentDef> {
    COMPONENTS
        .iter()
        .find(|c| c.id == id)
        .ok_or_else(|| AppError::invalid(format!("Unknown component {id}")))
}

#[derive(Debug, Clone, Serialize)]
pub struct ComponentStatus {
    pub id: String,
    pub label: String,
    pub kb: String,
    pub description: String,
    pub required: bool,
    pub supported: bool,
    pub unsupported_reason: Option<String>,
    pub status: String,
    pub version: Option<String>,
    pub variant: Option<String>,
    pub variants: Vec<Variant>,
    pub recommended_variant: Option<String>,
    pub size_bytes: Option<u64>,
    pub installed_at: Option<i64>,
    pub path: Option<String>,
    pub deps: Vec<String>,
    pub job_id: Option<String>,
}

struct Row {
    version: Option<String>,
    variant: Option<String>,
    status: String,
    size: Option<i64>,
    installed_at: Option<i64>,
    meta: Value,
}

fn row(st: &AppState, id: &str) -> AppResult<Option<Row>> {
    st.db.with(|c| {
        c.query_row(
            "SELECT version, variant, status, size_bytes, installed_at, meta_json FROM toolchain_components WHERE id = ?1",
            [id],
            |r| {
                Ok(Row {
                    version: r.get(0)?,
                    variant: r.get(1)?,
                    status: r.get(2)?,
                    size: r.get(3)?,
                    installed_at: r.get(4)?,
                    meta: crate::db::json_col(r.get(5)?),
                })
            },
        )
        .optional()
    })
}

fn save_row(
    st: &AppState,
    id: &str,
    version: &str,
    variant: Option<&str>,
    path: &std::path::Path,
    meta: Value,
) -> AppResult<()> {
    let size = dir_size(path) as i64;
    st.db.with(|c| {
        c.execute(
            "INSERT INTO toolchain_components (id, version, variant, path, status, size_bytes, installed_at, meta_json)
             VALUES (?1, ?2, ?3, ?4, 'installed', ?5, ?6, ?7)
             ON CONFLICT(id) DO UPDATE SET version = excluded.version, variant = excluded.variant, path = excluded.path,
               status = 'installed', size_bytes = excluded.size_bytes, installed_at = excluded.installed_at, meta_json = excluded.meta_json",
            rusqlite::params![id, version, variant, path.to_string_lossy(), size, now_ms(), meta.to_string()],
        )
    })?;
    Ok(())
}

fn component_path(st: &AppState, id: &str) -> PathBuf {
    match id {
        "uv" => st.paths.tools().join("uv"),
        "python" => st.paths.python_installs(),
        "llama_cpp" => st.paths.llama_dir(),
        other => st.paths.env(other.trim_start_matches("env_")),
    }
}

fn files_present(st: &AppState, id: &str) -> bool {
    match id {
        "uv" => st.paths.uv_bin().exists(),
        "python" => row(st, "python")
            .ok()
            .flatten()
            .and_then(|r| r.meta["python_path"].as_str().map(PathBuf::from))
            .map(|p| p.exists())
            .unwrap_or(false),
        "llama_cpp" => {
            st.paths.llama_bin("llama-quantize").exists() && st.paths.convert_script().exists()
        }
        other => st
            .paths
            .env_python(other.trim_start_matches("env_"))
            .exists(),
    }
}

/// Variants of llama.cpp available for this platform, plus the auto-detected recommendation.
pub fn llama_variants(st: &AppState) -> (Vec<Variant>, Option<String>) {
    let variants = MANIFEST
        .llama_cpp
        .variants
        .get(&platform_key(st))
        .cloned()
        .unwrap_or_default();
    let p = st.platform();
    let cuda_ver: Option<f64> = p
        .gpus
        .iter()
        .filter_map(|g| g.cuda_version.as_deref())
        .filter_map(|v| v.parse().ok())
        .fold(None, |a: Option<f64>, b| Some(a.map_or(b, |x| x.max(b))));
    let rec = variants
        .iter()
        .find(|v| {
            p.accelerators.iter().any(|a| a == &v.accel)
                && match (&v.min_cuda, cuda_ver) {
                    (Some(min), Some(have)) => have >= min.parse::<f64>().unwrap_or(99.0),
                    (Some(_), None) => false,
                    _ => true,
                }
        })
        .or_else(|| variants.iter().find(|v| v.accel == "cpu"))
        .map(|v| v.id.clone());
    (variants, rec)
}

fn supported(st: &AppState, id: &str) -> (bool, Option<String>) {
    let key = platform_key(st);
    if let Some(env) = id.strip_prefix("env_") {
        if let Some(ps) = MANIFEST.envs.get(env).and_then(|e| e.platforms.as_ref()) {
            if !ps.contains(&key) {
                return (
                    false,
                    Some("MLX needs a Mac with Apple Silicon (M1 or newer).".into()),
                );
            }
        }
    }
    if id == "llama_cpp" && !MANIFEST.llama_cpp.variants.contains_key(&key) {
        return (false, Some(format!("No prebuilt llama.cpp for {key}.")));
    }
    if id == "uv" && !MANIFEST.uv.assets.contains_key(&key) {
        return (false, Some(format!("No prebuilt uv for {key}.")));
    }
    (true, None)
}

fn active_install_jobs(st: &AppState) -> HashMap<String, String> {
    let mut map = HashMap::new();
    let rows: Vec<(String, String)> = st
        .db
        .with(|c| {
            let mut s = c.prepare("SELECT id, params_json FROM jobs WHERE kind = 'install' AND status IN ('queued','running')")?;
            let r = s.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
            r.collect()
        })
        .unwrap_or_default();
    for (job, params) in rows {
        let v: Value = serde_json::from_str(&params).unwrap_or(Value::Null);
        if let Some(arr) = v["components"].as_array() {
            for c in arr.iter().filter_map(|c| c.as_str()) {
                map.insert(c.to_string(), job.clone());
            }
        }
    }
    map
}

pub fn status(st: &AppState) -> AppResult<Vec<ComponentStatus>> {
    let jobs = active_install_jobs(st);
    let mut out = vec![];
    for d in COMPONENTS {
        let r = row(st, d.id)?;
        let present = files_present(st, d.id);
        let (sup, reason) = supported(st, d.id);
        let status = if jobs.contains_key(d.id) {
            "installing".to_string()
        } else if !sup {
            "unsupported".into()
        } else {
            match (&r, present) {
                (Some(r), true) if r.status == "installed" => "installed".into(),
                (Some(_), false) => "broken".into(),
                (None, true) if d.id == "uv" || d.id == "llama_cpp" => "broken".into(),
                _ => "not_installed".into(),
            }
        };
        let (variants, rec) = if d.id == "llama_cpp" {
            llama_variants(st)
        } else {
            (vec![], None)
        };
        out.push(ComponentStatus {
            id: d.id.into(),
            label: d.label.into(),
            kb: d.kb.into(),
            description: d.description.into(),
            required: d.required,
            supported: sup,
            unsupported_reason: reason,
            status,
            version: r.as_ref().and_then(|r| r.version.clone()),
            variant: r.as_ref().and_then(|r| r.variant.clone()),
            variants,
            recommended_variant: rec,
            size_bytes: r.as_ref().and_then(|r| r.size.map(|s| s as u64)),
            installed_at: r.as_ref().and_then(|r| r.installed_at),
            path: Some(component_path(st, d.id).to_string_lossy().to_string()),
            deps: d.deps.iter().map(|s| s.to_string()).collect(),
            job_id: jobs.get(d.id).cloned(),
        });
    }
    Ok(out)
}

pub fn is_installed(st: &AppState, id: &str) -> bool {
    files_present(st, id)
        && row(st, id)
            .ok()
            .flatten()
            .map(|r| r.status == "installed")
            .unwrap_or(false)
}

pub fn emit_changed(st: &AppState) {
    if let Ok(components) = status(st) {
        st.hub
            .emit("toolchain:changed", json!({ "components": components }));
    }
}

/* ---------------- capabilities ---------------- */

pub fn save_capability(st: &AppState, component: &str, key: &str, value: &Value) -> AppResult<()> {
    st.db.with(|c| {
        c.execute(
            "INSERT INTO toolchain_capabilities (component, key, value_json, probed_at) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(component, key) DO UPDATE SET value_json = excluded.value_json, probed_at = excluded.probed_at",
            rusqlite::params![component, key, value.to_string(), now_ms()],
        )
    })?;
    Ok(())
}

pub fn capabilities(st: &AppState) -> AppResult<Value> {
    let rows: Vec<(String, String, String)> = st.db.with(|c| {
        let mut s = c.prepare("SELECT component, key, value_json FROM toolchain_capabilities")?;
        let r = s.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?;
        r.collect()
    })?;
    let mut out = serde_json::Map::new();
    for (comp, key, val) in rows {
        let entry = out.entry(comp).or_insert_with(|| json!({}));
        entry[key] = serde_json::from_str(&val).unwrap_or(Value::Null);
    }
    Ok(Value::Object(out))
}

pub fn capability(st: &AppState, component: &str, key: &str) -> Option<Value> {
    st.db
        .with(|c| {
            c.query_row(
                "SELECT value_json FROM toolchain_capabilities WHERE component = ?1 AND key = ?2",
                [component, key],
                |r| r.get::<_, String>(0),
            )
            .optional()
        })
        .ok()
        .flatten()
        .and_then(|s| serde_json::from_str(&s).ok())
}

/* ---------------- uv helpers ---------------- */

pub fn uv(st: &AppState) -> Spawn {
    Spawn::new(st.paths.uv_bin())
        .env(
            "UV_PYTHON_INSTALL_DIR",
            st.paths.python_installs().to_string_lossy(),
        )
        .env("UV_CACHE_DIR", st.paths.uv_cache().to_string_lossy())
        .env("UV_PYTHON_PREFERENCE", "only-managed")
        .env("UV_NO_CONFIG", "1")
        .env("UV_NO_PROGRESS", "0")
        .env("UV_LINK_MODE", "copy")
}

/// Rough progress for `uv pip install`, which prints Resolved/Prepared/Installed summaries.
fn uv_progress(ctx: &JobCtx, line: &str, phase: &mut f64) {
    let l = line.trim();
    let next = if l.starts_with("Resolved") {
        Some((0.15, l))
    } else if l.starts_with("Downloading") || l.starts_with(" Downloading") {
        Some(((*phase + 0.03).min(0.7), l))
    } else if l.starts_with("Downloaded") {
        Some(((*phase + 0.02).min(0.75), l))
    } else if l.starts_with("Prepared") {
        Some((0.8, l))
    } else if l.starts_with("Installed") {
        Some((0.97, l))
    } else {
        None
    };
    if let Some((p, detail)) = next {
        *phase = phase.max(p);
        ctx.stage_progress(*phase, Some(detail.to_string()));
    }
}

/* ---------------- installers ---------------- */

fn stages_for(id: &str) -> Vec<StageDef> {
    match id {
        "uv" => vec![StageDef::new("uv:download", "Download uv", 1.0)],
        "python" => vec![StageDef::new("python:install", "Install Python 3.12", 2.0)],
        "llama_cpp" => vec![
            StageDef::new("llama:download", "Download llama.cpp binaries", 3.0),
            StageDef::new("llama:source", "Fetch converter source", 2.0),
            StageDef::new("llama:verify", "Verify and probe tools", 0.5),
        ],
        env => {
            let e = env.trim_start_matches("env_");
            vec![
                StageDef::new(
                    &format!("{e}:venv"),
                    format!("Create {} environment", e),
                    0.3,
                ),
                StageDef::new(&format!("{e}:packages"), "Install packages", 6.0),
                StageDef::new(&format!("{e}:probe"), "Probe capabilities", 0.4),
            ]
        }
    }
}

async fn install_uv(st: &AppState, ctx: &JobCtx) -> AppResult<()> {
    ctx.stage("uv:download")?;
    let key = platform_key(st);
    let m = &MANIFEST.uv;
    let asset_name = m
        .assets
        .get(&key)
        .ok_or_else(|| AppError::invalid(format!("uv is not available for {key}")))?;
    let rel = download::github_release(&st.http, &m.repo, &m.version).await?;
    let asset = rel
        .assets
        .iter()
        .find(|a| &a.name == asset_name)
        .ok_or_else(|| AppError::not_found(asset_name.clone()))?;
    let mut sha = asset.digest.clone();
    if sha.is_none() {
        if let Some(sa) = rel
            .assets
            .iter()
            .find(|a| a.name == format!("{asset_name}.sha256"))
        {
            sha = st
                .http
                .get(&sa.browser_download_url)
                .send()
                .await?
                .text()
                .await
                .ok()
                .and_then(|t| t.split_whitespace().next().map(str::to_string));
        }
    }
    let archive = st.paths.downloads_tmp().join(asset_name);
    download::download(
        &st.http,
        ctx,
        &asset.browser_download_url,
        &archive,
        sha.as_deref(),
        asset_name,
    )
    .await?;
    let dest = st.paths.tools().join("uv");
    let _ = std::fs::remove_dir_all(&dest);
    let n = download::extract(&archive, &dest, &|p| {
        let name = p
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();
        name.starts_with("uv")
    })?;
    let _ = std::fs::remove_file(&archive);
    // Archives may nest the binary; flatten anything found into tools/uv.
    flatten_into(&dest)?;
    ctx.log(format!("Extracted {n} files"));
    let (_, out) = capture(&uv(st).arg("--version"), 30).await?;
    ctx.log(out.trim().to_string());
    save_row(st, "uv", &m.version, None, &dest, json!({}))
}

fn flatten_into(dir: &std::path::Path) -> AppResult<()> {
    let mut moves = vec![];
    for e in std::fs::read_dir(dir)?.flatten() {
        if e.path().is_dir() {
            for f in std::fs::read_dir(e.path())?.flatten() {
                moves.push(f.path());
            }
        }
    }
    for f in moves {
        if let Some(name) = f.file_name() {
            std::fs::rename(&f, dir.join(name))?;
        }
    }
    Ok(())
}

async fn install_python(st: &AppState, ctx: &JobCtx) -> AppResult<()> {
    ctx.stage("python:install")?;
    if !st.paths.uv_bin().exists() {
        return Err(AppError::missing_tool("uv"));
    }
    let ver = &MANIFEST.python.version;
    let out = ctx
        .exec(&uv(st).args(["python", "install", ver.as_str()]), |_, l| {
            if l.contains("Installed") || l.contains("Downloading") {
                ctx.stage_progress(0.6, Some(l.trim().to_string()));
            }
        })
        .await?;
    out.ensure_success("Python install")?;
    let (status, found) = capture(&uv(st).args(["python", "find", ver.as_str()]), 60).await?;
    if !status.success() {
        return Err(AppError::new(
            "python",
            format!("Python {ver} was installed but could not be located: {found}"),
        ));
    }
    let path = found
        .lines()
        .rev()
        .find(|l| !l.trim().is_empty())
        .unwrap_or("")
        .trim()
        .to_string();
    let (_, v) = capture(&Spawn::new(&path).arg("--version"), 30).await?;
    ctx.log(format!("Using {} at {path}", v.trim()));
    save_row(
        st,
        "python",
        v.trim().trim_start_matches("Python ").trim(),
        None,
        &st.paths.python_installs(),
        json!({ "python_path": path }),
    )
}

fn python_path(st: &AppState) -> AppResult<String> {
    row(st, "python")?
        .and_then(|r| r.meta["python_path"].as_str().map(str::to_string))
        .filter(|p| std::path::Path::new(p).exists())
        .ok_or_else(|| AppError::missing_tool("Python"))
}

async fn install_env(st: &AppState, ctx: &JobCtx, env: &str) -> AppResult<()> {
    let m = MANIFEST
        .envs
        .get(env)
        .ok_or_else(|| AppError::invalid(format!("Unknown environment {env}")))?;
    let py = python_path(st)?;
    let dir = st.paths.env(env);

    ctx.stage(&format!("{env}:venv"))?;
    let _ = std::fs::remove_dir_all(&dir);
    ctx.exec(
        &uv(st).arg("venv").arg(&dir).args(["--python", py.as_str()]),
        |_, _| {},
    )
    .await?
    .ensure_success("Creating the environment")?;
    let env_py = st.paths.env_python(env);

    ctx.stage(&format!("{env}:packages"))?;
    let platform = st.platform();
    let use_cuda = platform.accelerators.iter().any(|a| a == "cuda") && platform.os != "macos";
    let packages: Vec<String> = match (&m.cuda_packages, use_cuda) {
        (Some(cuda), true) => cuda.clone(),
        _ => m.packages.clone(),
    };
    let mut cmd = uv(st).args(["pip", "install", "--python"]).arg(&env_py);
    if let Some(req) = &m.requirements_from_source {
        let req_path = st.paths.llama_src().join(req);
        if !req_path.exists() {
            return Err(AppError::missing_tool("llama.cpp tools"));
        }
        cmd = cmd.arg("-r").arg(req_path);
    }
    if packages.iter().any(|p| p.starts_with("torch")) || m.requirements_from_source.is_some() {
        cmd = cmd.args(["--torch-backend", "cpu"]);
    }
    cmd = cmd.args(packages.iter());
    let mut phase = 0.0;
    ctx.exec(&cmd, |_, l| uv_progress(ctx, l, &mut phase))
        .await?
        .ensure_success("Installing packages")?;
    for local in &m.local_packages {
        let p = st.paths.llama_src().join(local);
        ctx.exec(
            &uv(st)
                .args(["pip", "install", "--python"])
                .arg(&env_py)
                .arg(p),
            |_, _| {},
        )
        .await?
        .ensure_success("Installing local package")?;
    }
    for opt in &m.optional_packages {
        let r = ctx
            .exec(
                &uv(st)
                    .args(["pip", "install", "--python"])
                    .arg(&env_py)
                    .arg(opt),
                |_, _| {},
            )
            .await?;
        if !r.status.success() {
            ctx.log(format!("⚠ Optional package {opt} could not be installed; the features that need it stay disabled."));
        }
    }

    ctx.stage(&format!("{env}:probe"))?;
    let probe_ok = probe_env(st, ctx, env).await;
    let version = match &probe_ok {
        Ok(v) => v.clone(),
        Err(e) => {
            ctx.log(format!("⚠ Capability probe failed: {}", e.message));
            "installed".into()
        }
    };
    save_row(
        st,
        &format!("env_{env}"),
        &version,
        if use_cuda && m.cuda_packages.is_some() {
            Some("cuda")
        } else {
            None
        },
        &dir,
        json!({ "packages": packages }),
    )
}

/// Runs the probe driver for an environment and stores its capabilities. Returns a version summary.
pub async fn probe_env(st: &AppState, ctx: &JobCtx, env: &str) -> AppResult<String> {
    let mut args = json!({ "env": env });
    if env == "gguf" {
        args["convert_script"] = json!(st.paths.convert_script());
    }
    let spec = crate::driver::spawn(st, env, "probe.py", &args, false)?;
    let res = crate::driver::run(ctx, &spec, |_| {}).await?;
    let comp = format!("env_{env}");
    save_capability(st, &comp, "packages", &res["packages"])?;
    save_capability(st, &comp, "caps", &res["caps"])?;
    save_capability(st, &comp, "python", &res["python"])?;
    let main_pkg = match env {
        "mlx" => "mlx-lm",
        "onnx" => "onnxruntime-genai",
        "gguf" => "gguf",
        _ => "huggingface_hub",
    };
    let ver = res["packages"].as_object().and_then(|p| {
        p.iter()
            .find(|(k, _)| k.as_str().starts_with(main_pkg))
            .and_then(|(_, v)| v.as_str().map(str::to_string))
    });
    Ok(ver
        .map(|v| format!("{main_pkg} {v}"))
        .unwrap_or_else(|| "installed".into()))
}

async fn install_llama(st: &AppState, ctx: &JobCtx, variant: Option<String>) -> AppResult<()> {
    let m = &MANIFEST.llama_cpp;
    let (variants, rec) = llama_variants(st);
    let chosen_id = variant
        .or_else(|| {
            st.db
                .setting("accelerator")
                .ok()
                .flatten()
                .filter(|a| a != "auto")
        })
        .filter(|v| variants.iter().any(|x| &x.id == v))
        .or(rec)
        .ok_or_else(|| AppError::invalid("No llama.cpp build matches this machine"))?;
    let chosen = variants
        .iter()
        .find(|v| v.id == chosen_id)
        .cloned()
        .expect("variant exists");

    ctx.stage("llama:download")?;
    ctx.log(format!("Build {} · {}", m.tag, chosen.label));
    let rel = download::github_release(&st.http, &m.repo, &m.tag).await?;
    let bin = st.paths.llama_dir().join("bin");
    let _ = std::fs::remove_dir_all(&bin);
    for pattern in &chosen.assets {
        let name = pattern.replace("{tag}", &m.tag);
        let asset = rel.assets.iter().find(|a| a.name == name).ok_or_else(|| {
            AppError::not_found(format!("Release asset {name}"))
                .with_hint("This llama.cpp build may have been withdrawn; update the app.")
        })?;
        let archive = st.paths.downloads_tmp().join(&name);
        download::download(
            &st.http,
            ctx,
            &asset.browser_download_url,
            &archive,
            asset.digest.as_deref(),
            &name,
        )
        .await?;
        let n = download::extract(&archive, &bin, &|_| true)?;
        ctx.log(format!("Extracted {n} files from {name}"));
        let _ = std::fs::remove_file(&archive);
    }

    ctx.stage("llama:source")?;
    let src_url = format!(
        "https://github.com/{}/archive/refs/tags/{}.tar.gz",
        m.repo, m.tag
    );
    let archive = st
        .paths
        .downloads_tmp()
        .join(format!("llama-src-{}.tar.gz", m.tag));
    download::download(&st.http, ctx, &src_url, &archive, None, "converter source").await?;
    let src = st.paths.llama_src();
    let _ = std::fs::remove_dir_all(&src);
    let keep = m.source_keep.clone();
    let n = download::extract(&archive, &src, &move |p| {
        let s = p.to_string_lossy().replace('\\', "/");
        keep.iter().any(|k| {
            if k.ends_with('/') {
                s.starts_with(k.as_str())
            } else {
                s == *k
            }
        })
    })?;
    let _ = std::fs::remove_file(&archive);
    ctx.log(format!("Extracted {n} converter files"));

    ctx.stage("llama:verify")?;
    probe_llama(st, ctx).await?;
    save_row(
        st,
        "llama_cpp",
        &m.tag,
        Some(&chosen.id),
        &st.paths.llama_dir(),
        json!({ "accel": chosen.accel, "label": chosen.label }),
    )
}

pub async fn probe_llama(st: &AppState, ctx: &JobCtx) -> AppResult<()> {
    let q = st.paths.llama_bin("llama-quantize");
    let (_, help) = capture(&Spawn::new(&q).arg("--help"), 30).await?;
    let types = probe::parse_quant_types(&help);
    if types.is_empty() {
        return Err(AppError::new("probe", "llama-quantize did not run correctly")
            .with_hint("Try another accelerator variant (CPU always works), or check that GPU drivers are installed."));
    }
    ctx.log(format!(
        "llama-quantize supports {} quantization types",
        types.len()
    ));
    save_capability(
        st,
        "llama_cpp",
        "quant_types",
        &serde_json::to_value(&types)?,
    )?;
    save_capability(
        st,
        "llama_cpp",
        "quantize_flags",
        &json!(probe::parse_flags(&help)),
    )?;
    for tool in [
        "llama-imatrix",
        "llama-perplexity",
        "llama-bench",
        "llama-server",
        "llama-gguf-split",
    ] {
        let p = st.paths.llama_bin(tool);
        if !p.exists() {
            ctx.log(format!("⚠ {tool} is missing from this build"));
            continue;
        }
        let flags = match capture(&Spawn::new(&p).arg("--help"), 30).await {
            Ok((_, h)) => probe::parse_flags(&h),
            Err(_) => vec![],
        };
        save_capability(st, "llama_cpp", &format!("{tool}_flags"), &json!(flags))?;
    }
    Ok(())
}

async fn install_component(
    st: &AppState,
    ctx: &JobCtx,
    id: &str,
    variant: Option<String>,
) -> AppResult<()> {
    match id {
        "uv" => install_uv(st, ctx).await,
        "python" => install_python(st, ctx).await,
        "llama_cpp" => install_llama(st, ctx, variant).await,
        env if env.starts_with("env_") => {
            install_env(st, ctx, env.trim_start_matches("env_")).await
        }
        _ => Err(AppError::invalid(format!("Unknown component {id}"))),
    }
}

/// Topologically ordered list of components needed to install `targets`.
fn plan(st: &AppState, targets: &[String], force: bool) -> Vec<String> {
    let mut order: Vec<String> = vec![];
    fn visit(st: &AppState, id: &str, force_ids: &[String], force: bool, order: &mut Vec<String>) {
        if order.iter().any(|x| x == id) {
            return;
        }
        if let Ok(d) = def(id) {
            for dep in d.deps {
                visit(st, dep, force_ids, false, order);
            }
        }
        let wanted = force && force_ids.iter().any(|x| x == id);
        if wanted || !is_installed(st, id) {
            order.push(id.to_string());
        }
    }
    for t in targets {
        visit(st, t, targets, force, &mut order);
    }
    order
}

pub fn submit_install(
    st: &AppState,
    targets: Vec<String>,
    variant: Option<String>,
    force: bool,
) -> AppResult<String> {
    for t in &targets {
        let d = def(t)?;
        let (sup, reason) = supported(st, d.id);
        if !sup {
            return Err(AppError::invalid(
                reason.unwrap_or_else(|| format!("{} is not supported here", d.label)),
            ));
        }
    }
    let busy = active_install_jobs(st);
    if let Some(job) = targets.iter().find_map(|t| busy.get(t)) {
        return Err(
            AppError::new("busy", "An install is already running for this component")
                .with_hint(format!("Job {job} is still in progress.")),
        );
    }
    let order: Vec<String> = plan(st, &targets, force)
        .into_iter()
        .filter(|c| !busy.contains_key(c))
        .collect();
    if order.is_empty() {
        return Err(AppError::invalid(
            "Everything selected is already installed",
        ));
    }
    let stages: Vec<StageDef> = order.iter().flat_map(|id| stages_for(id)).collect();
    let title = if order.len() == 1 {
        format!("Install {}", def(&order[0])?.label)
    } else {
        format!("Install {} components", order.len())
    };
    let st2 = st.clone();
    let order2 = order.clone();
    let id = st.jobs.submit(
        NewJob {
            kind: "install",
            title,
            model_id: None,
            format: None,
            params: json!({ "components": order, "variant": variant }),
            stages,
            lane: Lane::Install,
        },
        move |ctx| async move {
            let mut installed = vec![];
            let result = async {
                for id in &order2 {
                    install_component(&st2, &ctx, id, variant.clone()).await?;
                    installed.push(id.clone());
                    emit_changed(&st2);
                }
                Ok::<_, AppError>(())
            }
            .await;
            emit_changed(&st2);
            result.map(|_| json!({ "installed": installed }))
        },
    )?;
    emit_changed(st);
    Ok(id)
}

pub fn remove(st: &AppState, id: &str) -> AppResult<()> {
    def(id)?;
    let dependents: Vec<&str> = COMPONENTS
        .iter()
        .filter(|c| c.deps.contains(&id) && is_installed(st, c.id))
        .map(|c| c.label)
        .collect();
    if id == "python" && !dependents.is_empty() {
        return Err(AppError::invalid(format!(
            "Remove these first: {}",
            dependents.join(", ")
        )));
    }
    let p = component_path(st, id);
    if p.exists() {
        std::fs::remove_dir_all(&p)?;
    }
    st.db.with(|c| {
        c.execute("DELETE FROM toolchain_components WHERE id = ?1", [id])?;
        c.execute(
            "DELETE FROM toolchain_capabilities WHERE component = ?1",
            [id],
        )
    })?;
    emit_changed(st);
    Ok(())
}

/* ---------------- doctor ---------------- */

pub async fn doctor(st: &AppState) -> AppResult<Value> {
    let p = st.platform();
    let free = crate::paths::free_space(&st.paths.workspace());
    let net = |url: &'static str| {
        let http = st.http.clone();
        async move {
            http.head(url)
                .timeout(std::time::Duration::from_secs(6))
                .send()
                .await
                .map(|r| r.status().as_u16() < 500)
                .unwrap_or(false)
        }
    };
    let (hf, gh, pypi) = tokio::join!(
        net("https://huggingface.co"),
        net("https://api.github.com"),
        net("https://pypi.org/simple/")
    );
    let glibc = if p.os == "linux" {
        capture(&Spawn::new("ldd").arg("--version"), 10)
            .await
            .ok()
            .and_then(|(_, o)| o.lines().next().map(str::to_string))
    } else {
        None
    };
    let mut checks = vec![
        json!({ "key": "os", "label": "Operating system", "value": format!("{} ({}, {})", p.os_version, p.os, p.arch), "ok": true }),
        json!({ "key": "cpu", "label": "CPU", "value": format!("{} · {} threads", p.cpu_brand, p.cores), "ok": true, "kb": "hw.cpu_threads" }),
        json!({ "key": "ram", "label": "Memory", "value": crate::toolchain::download::human(p.total_ram), "ok": p.total_ram >= 8_000_000_000, "hint": if p.total_ram < 8_000_000_000 { Some("Under 8 GB limits you to small models.") } else { None }, "kb": "hw.ram" }),
        json!({ "key": "accel", "label": "Accelerators", "value": p.accelerators.join(", "), "ok": true, "kb": "tc.accelerator" }),
        json!({ "key": "disk", "label": "Free space in workspace", "value": free.map(crate::toolchain::download::human).unwrap_or_else(|| "unknown".into()), "ok": free.map(|f| f > 30_000_000_000).unwrap_or(true), "hint": "Quantizing a 7–8B model needs roughly 30–40 GB free (original + F16 + outputs).", "kb": "concept.disk_space" }),
        json!({ "key": "net_hf", "label": "huggingface.co", "value": if hf { "reachable" } else { "unreachable" }, "ok": hf }),
        json!({ "key": "net_gh", "label": "GitHub (tool downloads)", "value": if gh { "reachable" } else { "unreachable" }, "ok": gh }),
        json!({ "key": "net_pypi", "label": "PyPI (Python packages)", "value": if pypi { "reachable" } else { "unreachable" }, "ok": pypi }),
        json!({ "key": "secrets", "label": "Secret storage", "value": if st.secrets.backend().kind == "os-keychain" { "OS keychain" } else { "Private key file" }, "ok": true }),
    ];
    for g in &p.gpus {
        checks.push(json!({ "key": "gpu", "label": format!("GPU ({})", g.vendor), "value": format!("{}{}{}", g.name, g.vram_bytes.map(|v| format!(" · {}", crate::toolchain::download::human(v))).unwrap_or_default(), g.cuda_version.as_ref().map(|c| format!(" · CUDA {c}")).unwrap_or_default()), "ok": true }));
    }
    if let Some(g) = glibc {
        checks.push(json!({ "key": "glibc", "label": "glibc", "value": g, "ok": true }));
    }
    Ok(json!({ "checks": checks, "platform": p, "platform_key": platform_key(st) }))
}

/// Accelerator of the installed llama.cpp build (metal, cuda, vulkan, rocm, cpu).
pub fn llama_accel(st: &AppState) -> String {
    row(st, "llama_cpp")
        .ok()
        .flatten()
        .and_then(|r| r.meta["accel"].as_str().map(str::to_string))
        .unwrap_or_else(|| "cpu".into())
}
