//! Inference runners for testing: llama-server (GGUF), mlx_lm.server (MLX) and the
//! onnx_infer.py stdio driver (ONNX). All bind to 127.0.0.1; the WebView never talks to
//! them directly (CSP), Rust proxies and streams tokens as events.

use crate::error::{AppError, AppResult};
use crate::events::EventHub;
use crate::process::{Persistent, Spawn, Stream};
use crate::quant::artifacts::ArtifactRow;
use crate::state::AppState;
use futures_util::StreamExt;
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::io::AsyncWriteExt;
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;

#[derive(Debug, Clone, Serialize)]
pub struct RunnerInfo {
    pub artifact_id: String,
    pub format: String,
    pub variant: String,
    pub port: Option<u16>,
    pub status: String,
    pub started_at: u64,
    pub load_ms: u64,
}

pub struct Runner {
    info: RunnerInfo,
    proc: Persistent,
    last_used: Instant,
}

#[derive(Default)]
pub struct RunnerManager {
    runners: Mutex<HashMap<String, Arc<Mutex<Runner>>>>,
    hub: Option<EventHub>,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct GenMetrics {
    pub ttft_ms: f64,
    pub total_ms: f64,
    pub tokens: u64,
    pub tok_per_s: f64,
    pub prompt_tokens: Option<u64>,
    pub prompt_tok_per_s: Option<f64>,
    pub finish_reason: Option<String>,
}

#[derive(Debug, Clone, serde::Deserialize)]
pub struct GenParams {
    #[serde(default)]
    pub temperature: f64,
    #[serde(default = "one")]
    pub top_p: f64,
    #[serde(default = "max_tokens")]
    pub max_tokens: u32,
    #[serde(default = "seed")]
    pub seed: u64,
    #[serde(default = "ctx")]
    pub ctx: u32,
}

fn one() -> f64 {
    1.0
}
fn max_tokens() -> u32 {
    512
}
fn seed() -> u64 {
    42
}
fn ctx() -> u32 {
    4096
}

fn free_port() -> AppResult<u16> {
    let l = std::net::TcpListener::bind("127.0.0.1:0")?;
    Ok(l.local_addr()?.port())
}

impl RunnerManager {
    pub fn new(hub: EventHub) -> Self {
        Self {
            runners: Mutex::new(HashMap::new()),
            hub: Some(hub),
        }
    }

    fn emit(&self) {
        // Status changes are cheap; the UI refreshes its runner list on this event.
        if let Some(h) = &self.hub {
            h.emit("runners:changed", json!({}));
        }
    }

    pub async fn list(&self) -> Vec<RunnerInfo> {
        let map = self.runners.lock().await;
        let mut out = vec![];
        for r in map.values() {
            out.push(r.lock().await.info.clone());
        }
        out
    }

    pub async fn stop(&self, artifact_id: &str) {
        let r = self.runners.lock().await.remove(artifact_id);
        if let Some(r) = r {
            if let Ok(m) = Arc::try_unwrap(r) {
                m.into_inner().proc.kill().await;
            } else {
                // Still in use by a request: it will be dropped (kill_on_drop) when released.
            }
        }
        self.emit();
    }

    pub async fn stop_all(&self) {
        let ids: Vec<String> = self.runners.lock().await.keys().cloned().collect();
        for id in ids {
            self.stop(&id).await;
        }
    }

    /// Stops runners idle for longer than `idle`.
    pub async fn reap(&self, idle: Duration) {
        let mut stale = vec![];
        for (id, r) in self.runners.lock().await.iter() {
            if let Ok(g) = r.try_lock() {
                if g.last_used.elapsed() > idle {
                    stale.push(id.clone());
                }
            }
        }
        for id in stale {
            self.stop(&id).await;
        }
    }

    pub async fn ensure(
        &self,
        st: &AppState,
        a: &ArtifactRow,
        params: &GenParams,
    ) -> AppResult<Arc<Mutex<Runner>>> {
        if let Some(r) = self.runners.lock().await.get(&a.id).cloned() {
            let alive = r.lock().await.proc.try_status().is_none();
            if alive {
                return Ok(r);
            }
            self.runners.lock().await.remove(&a.id);
        }
        let started = Instant::now();
        let (proc, port) = match a.format.as_str() {
            "gguf" => {
                let port = free_port()?;
                let path = crate::quant::artifacts::shard_paths(std::path::Path::new(&a.path))
                    .into_iter()
                    .next()
                    .unwrap_or_else(|| a.path.clone().into());
                let spec = Spawn::new(st.paths.llama_bin("llama-server"))
                    .arg("-m")
                    .arg(path)
                    .args([
                        "--host",
                        "127.0.0.1",
                        "--port",
                        &port.to_string(),
                        "-c",
                        &params.ctx.to_string(),
                        "--no-webui",
                        "--jinja",
                        "--parallel",
                        "1",
                    ])
                    .args(crate::quant::gguf::gpu_args(st));
                (Persistent::spawn(&spec, false)?, Some(port))
            }
            "mlx" => {
                let port = free_port()?;
                let mut spec = Spawn::new(st.paths.env_python("mlx"))
                    .args(["-u", "-I", "-m", "mlx_lm.server", "--model"])
                    .arg(&a.path)
                    .args(["--host", "127.0.0.1", "--port", &port.to_string()]);
                for (k, v) in st.python_env(false) {
                    spec = spec.env(&k, v);
                }
                (Persistent::spawn(&spec, false)?, Some(port))
            }
            "onnx" => {
                let spec = crate::driver::spawn(st, "onnx", "onnx_infer.py", &json!({}), false)?;
                let mut p = Persistent::spawn(&spec, true)?;
                send(&mut p, &json!({ "cmd": "load", "path": a.path })).await?;
                wait_result(&mut p, |v| v["cmd"] == "load", Duration::from_secs(300)).await?;
                (p, None)
            }
            f => return Err(AppError::invalid(format!("Cannot run format {f}"))),
        };
        let mut runner = Runner {
            info: RunnerInfo {
                artifact_id: a.id.clone(),
                format: a.format.clone(),
                variant: a.variant.clone(),
                port,
                status: "loading".into(),
                started_at: crate::db::now_ms() as u64,
                load_ms: 0,
            },
            proc,
            last_used: Instant::now(),
        };
        if let Some(port) = port {
            wait_http(&st.http, port, &a.format, &mut runner.proc).await?;
        }
        runner.info.status = "ready".into();
        runner.info.load_ms = started.elapsed().as_millis() as u64;
        let arc = Arc::new(Mutex::new(runner));
        self.runners.lock().await.insert(a.id.clone(), arc.clone());
        self.emit();
        Ok(arc)
    }
}

async fn send(p: &mut Persistent, v: &Value) -> AppResult<()> {
    let stdin = p
        .stdin
        .as_mut()
        .ok_or_else(|| AppError::new("runner", "Runner has no stdin"))?;
    stdin.write_all(format!("{v}\n").as_bytes()).await?;
    stdin.flush().await?;
    Ok(())
}

async fn wait_result(
    p: &mut Persistent,
    pred: impl Fn(&Value) -> bool,
    timeout: Duration,
) -> AppResult<Value> {
    let deadline = Instant::now() + timeout;
    let mut tail: Vec<String> = vec![];
    loop {
        let left = deadline.saturating_duration_since(Instant::now());
        match tokio::time::timeout(left, p.lines.recv()).await {
            Err(_) => {
                return Err(AppError::new(
                    "timeout",
                    "The model took too long to respond",
                ))
            }
            Ok(None) => {
                return Err(AppError::new(
                    "runner",
                    format!("The runner exited.\n{}", tail.join("\n")),
                ))
            }
            Ok(Some((_, line))) => {
                if let Some(v) = crate::driver::parse_event(&line) {
                    if v["t"] == "error" {
                        return Err(AppError::new(
                            "runner",
                            v["message"].as_str().unwrap_or("error").to_string(),
                        ));
                    }
                    if v["t"] == "result" && pred(&v) {
                        return Ok(v);
                    }
                } else {
                    tail.push(line);
                    if tail.len() > 12 {
                        tail.remove(0);
                    }
                }
            }
        }
    }
}

async fn wait_http(
    http: &reqwest::Client,
    port: u16,
    format: &str,
    p: &mut Persistent,
) -> AppResult<()> {
    let url = if format == "gguf" {
        format!("http://127.0.0.1:{port}/health")
    } else {
        format!("http://127.0.0.1:{port}/v1/models")
    };
    let deadline = Instant::now() + Duration::from_secs(600);
    let mut tail: Vec<String> = vec![];
    while Instant::now() < deadline {
        while let Ok((_, l)) = p.lines.try_recv() {
            tail.push(l);
            if tail.len() > 12 {
                tail.remove(0);
            }
        }
        if let Some(status) = p.try_status() {
            return Err(AppError::new(
                "runner",
                format!(
                    "The inference server exited ({}).\n{}",
                    crate::process::describe_status(&status),
                    tail.join("\n")
                ),
            ));
        }
        if let Ok(r) = http.get(&url).timeout(Duration::from_secs(2)).send().await {
            if r.status().is_success() {
                return Ok(());
            }
        }
        tokio::time::sleep(Duration::from_millis(400)).await;
    }
    Err(AppError::new(
        "timeout",
        "The inference server did not start in time",
    ))
}

/// Streams one chat completion, calling `on_text` for each piece of text.
pub async fn generate(
    st: &AppState,
    runner: &Arc<Mutex<Runner>>,
    messages: &[Value],
    params: &GenParams,
    cancel: &CancellationToken,
    mut on_text: impl FnMut(&str),
) -> AppResult<(String, GenMetrics)> {
    let mut r = runner.lock().await;
    r.last_used = Instant::now();
    let start = Instant::now();
    let mut text = String::new();
    let mut first: Option<f64> = None;
    let mut m = GenMetrics::default();
    if let Some(port) = r.info.port {
        let body = json!({
            "model": "default_model", "messages": messages, "stream": true, "temperature": params.temperature, "top_p": params.top_p,
            "max_tokens": params.max_tokens, "seed": params.seed, "stream_options": { "include_usage": true },
        });
        let resp = st
            .http
            .post(format!("http://127.0.0.1:{port}/v1/chat/completions"))
            .json(&body)
            .send()
            .await?;
        if !resp.status().is_success() {
            let s = resp.status();
            let b = resp.text().await.unwrap_or_default();
            return Err(AppError::new(
                "runner",
                format!(
                    "Inference server returned {s}: {}",
                    b.chars().take(300).collect::<String>()
                ),
            ));
        }
        let mut stream = resp.bytes_stream();
        let mut buf = String::new();
        let mut chunks = 0u64;
        'outer: while let Some(chunk) =
            tokio::select! { c = stream.next() => c, _ = cancel.cancelled() => None }
        {
            buf.push_str(&String::from_utf8_lossy(&chunk?));
            while let Some(i) = buf.find('\n') {
                let line = buf[..i].trim().to_string();
                buf.drain(..=i);
                let Some(data) = line.strip_prefix("data:") else {
                    continue;
                };
                let data = data.trim();
                if data == "[DONE]" {
                    break 'outer;
                }
                let Ok(v) = serde_json::from_str::<Value>(data) else {
                    continue;
                };
                if let Some(piece) = v["choices"][0]["delta"]["content"].as_str() {
                    if !piece.is_empty() {
                        if first.is_none() {
                            first = Some(start.elapsed().as_secs_f64() * 1000.0);
                        }
                        chunks += 1;
                        text.push_str(piece);
                        on_text(piece);
                    }
                }
                if let Some(f) = v["choices"][0]["finish_reason"].as_str() {
                    m.finish_reason = Some(f.to_string());
                }
                if let Some(u) = v.get("usage").filter(|u| u.is_object()) {
                    m.tokens = u["completion_tokens"].as_u64().unwrap_or(m.tokens);
                    m.prompt_tokens = u["prompt_tokens"].as_u64();
                }
                if let Some(t) = v.get("timings").filter(|t| t.is_object()) {
                    m.tokens = t["predicted_n"].as_u64().unwrap_or(m.tokens);
                    m.prompt_tokens = t["prompt_n"].as_u64().or(m.prompt_tokens);
                    m.prompt_tok_per_s = t["prompt_per_second"].as_f64();
                    if let Some(tps) = t["predicted_per_second"].as_f64() {
                        m.tok_per_s = tps;
                    }
                }
            }
        }
        if m.tokens == 0 {
            m.tokens = chunks;
        }
    } else {
        let id = crate::db::new_id();
        let req = json!({ "cmd": "generate", "id": id, "messages": messages, "max_tokens": params.max_tokens, "temperature": params.temperature, "top_p": params.top_p, "seed": params.seed });
        send(&mut r.proc, &req).await?;
        loop {
            let line = tokio::select! {
                l = r.proc.lines.recv() => l,
                _ = cancel.cancelled() => {
                    let _ = send(&mut r.proc, &json!({ "cmd": "cancel", "id": id })).await;
                    None
                }
            };
            let Some((stream, line)) = line else { break };
            if stream == Stream::Stderr {
                continue;
            }
            let Some(v) = crate::driver::parse_event(&line) else {
                continue;
            };
            if v["id"] != id.as_str() {
                continue;
            }
            match v["t"].as_str() {
                Some("token") => {
                    let piece = v["text"].as_str().unwrap_or("");
                    if first.is_none() {
                        first = Some(start.elapsed().as_secs_f64() * 1000.0);
                    }
                    text.push_str(piece);
                    on_text(piece);
                }
                Some("result") => {
                    m.tokens = v["tokens"].as_u64().unwrap_or(0);
                    m.prompt_tokens = v["prompt_tokens"].as_u64();
                    m.tok_per_s = v["tok_per_s"].as_f64().unwrap_or(0.0);
                    m.finish_reason = v["finish_reason"].as_str().map(str::to_string);
                    if let Some(t) = v["ttft_ms"].as_f64() {
                        first = Some(t);
                    }
                    break;
                }
                Some("error") => {
                    return Err(AppError::new(
                        "runner",
                        v["message"].as_str().unwrap_or("error").to_string(),
                    ))
                }
                _ => {}
            }
        }
    }
    m.total_ms = start.elapsed().as_secs_f64() * 1000.0;
    m.ttft_ms = first.unwrap_or(m.total_ms);
    if m.tok_per_s == 0.0 && m.tokens > 1 {
        m.tok_per_s = (m.tokens - 1) as f64 / ((m.total_ms - m.ttft_ms).max(1.0) / 1000.0);
    }
    r.last_used = Instant::now();
    Ok((text, m))
}
