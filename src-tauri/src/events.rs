//! Event hub: high-frequency job updates are coalesced and flushed every 100 ms so the
//! WebView never drowns in IPC messages. Log lines are also persisted in batches.
//!
//! Events emitted to the frontend:
//! - `job:update`   full job row on any status/stage change (immediate)
//! - `job:progress` `[{ id, progress, stage, detail, extra }]` latest per job
//! - `job:log`      `{ id, lines: [{ ts, stream, text }] }`
//! - `job:tensor`   `{ id, items: [...] }`
//! - `job:metric`   `{ id, items: [{ name, value, step }] }`

use crate::db::{now_ms, Db};
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::Write;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tokio::sync::mpsc;

const MAX_LINE: usize = 4000;
const MAX_DB_LOG_LINES_PER_FLUSH: usize = 2000;

enum Msg {
    Progress {
        id: String,
        progress: f64,
        stage: Option<String>,
        detail: Option<String>,
        extra: Option<Value>,
    },
    Log {
        id: String,
        stream: &'static str,
        text: String,
    },
    Tensor {
        id: String,
        item: Value,
    },
    Metric {
        id: String,
        name: String,
        value: f64,
        step: Option<i64>,
    },
}

#[derive(Clone)]
pub struct EventHub {
    app: AppHandle,
    tx: mpsc::UnboundedSender<Msg>,
    /// Tensor events of the current variant per job, so a view opened mid-run can catch up.
    history: std::sync::Arc<std::sync::Mutex<HashMap<String, Vec<Value>>>>,
}

const MAX_HISTORY: usize = 60_000;

#[derive(Serialize, Clone)]
struct LogLine {
    ts: i64,
    stream: &'static str,
    text: String,
}

impl EventHub {
    pub fn start(
        app: AppHandle,
        db: Arc<Db>,
        jobs_dir: impl Fn() -> PathBuf + Send + 'static,
    ) -> Self {
        let (tx, rx) = mpsc::unbounded_channel();
        let hub = Self {
            app: app.clone(),
            tx,
            history: Default::default(),
        };
        tauri::async_runtime::spawn(flush_loop(app, db, rx, jobs_dir));
        hub
    }

    pub fn emit<S: Serialize + Clone>(&self, event: &str, payload: S) {
        if let Err(e) = self.app.emit(event, payload) {
            tracing::warn!("emit {event} failed: {e}");
        }
    }

    pub fn progress(
        &self,
        id: &str,
        progress: f64,
        stage: Option<&str>,
        detail: Option<String>,
        extra: Option<Value>,
    ) {
        let _ = self.tx.send(Msg::Progress {
            id: id.into(),
            progress: progress.clamp(0.0, 1.0),
            stage: stage.map(str::to_string),
            detail,
            extra,
        });
    }

    pub fn log(&self, id: &str, stream: &'static str, text: impl Into<String>) {
        let mut text: String = text.into();
        if text.len() > MAX_LINE {
            let mut cut = MAX_LINE;
            while !text.is_char_boundary(cut) {
                cut -= 1;
            }
            text.truncate(cut);
            text.push('…');
        }
        let _ = self.tx.send(Msg::Log {
            id: id.into(),
            stream,
            text,
        });
    }

    pub fn tensor(&self, id: &str, item: Value) {
        if let Ok(mut h) = self.history.lock() {
            let list = h.entry(id.to_string()).or_default();
            if item["t"] == "reset" {
                list.clear();
            }
            if list.len() < MAX_HISTORY {
                list.push(item.clone());
            }
            // Bound memory across many jobs.
            if h.len() > 8 {
                let keep: Vec<String> = h.keys().take(4).cloned().collect();
                h.retain(|k, _| k == id || !keep.contains(k));
            }
        }
        let _ = self.tx.send(Msg::Tensor {
            id: id.into(),
            item,
        });
    }

    pub fn tensor_history(&self, id: &str) -> Vec<Value> {
        self.history
            .lock()
            .ok()
            .and_then(|h| h.get(id).cloned())
            .unwrap_or_default()
    }

    pub fn metric(&self, id: &str, name: &str, value: f64, step: Option<i64>) {
        let _ = self.tx.send(Msg::Metric {
            id: id.into(),
            name: name.into(),
            value,
            step,
        });
    }
}

async fn flush_loop(
    app: AppHandle,
    db: Arc<Db>,
    mut rx: mpsc::UnboundedReceiver<Msg>,
    jobs_dir: impl Fn() -> PathBuf + Send + 'static,
) {
    let mut tick = tokio::time::interval(Duration::from_millis(100));
    let mut progress: HashMap<String, Value> = HashMap::new();
    let mut logs: HashMap<String, Vec<LogLine>> = HashMap::new();
    let mut tensors: HashMap<String, Vec<Value>> = HashMap::new();
    let mut metrics: HashMap<String, Vec<Value>> = HashMap::new();
    loop {
        tokio::select! {
            msg = rx.recv() => {
                let Some(msg) = msg else { break };
                match msg {
                    Msg::Progress { id, progress: p, stage, detail, extra } => {
                        progress.insert(id.clone(), json!({ "id": id, "progress": p, "stage": stage, "detail": detail, "extra": extra }));
                    }
                    Msg::Log { id, stream, text } => logs.entry(id).or_default().push(LogLine { ts: now_ms(), stream, text }),
                    Msg::Tensor { id, item } => tensors.entry(id).or_default().push(item),
                    Msg::Metric { id, name, value, step } => metrics.entry(id).or_default().push(json!({ "name": name, "value": value, "step": step })),
                }
            }
            _ = tick.tick() => {
                if !progress.is_empty() {
                    let items: Vec<Value> = progress.drain().map(|(_, v)| v).collect();
                    persist_progress(&db, &items);
                    let _ = app.emit("job:progress", items);
                }
                if !logs.is_empty() {
                    let batch: Vec<(String, Vec<LogLine>)> = logs.drain().collect();
                    persist_logs(&db, &jobs_dir(), &batch);
                    for (id, lines) in batch {
                        let _ = app.emit("job:log", json!({ "id": id, "lines": lines }));
                    }
                }
                for (id, items) in tensors.drain() {
                    let _ = app.emit("job:tensor", json!({ "id": id, "items": items }));
                }
                for (id, items) in metrics.drain() {
                    let _ = app.emit("job:metric", json!({ "id": id, "items": items }));
                }
            }
        }
    }
}

fn persist_progress(db: &Db, items: &[Value]) {
    let _ = db.tx(|tx| {
        for it in items {
            let id = it["id"].as_str().unwrap_or_default();
            let p = it["progress"].as_f64().unwrap_or(0.0);
            tx.execute(
                "UPDATE jobs SET progress = ?1 WHERE id = ?2 AND status = 'running'",
                rusqlite::params![p, id],
            )?;
        }
        Ok(())
    });
}

fn persist_logs(db: &Db, jobs_dir: &std::path::Path, batch: &[(String, Vec<LogLine>)]) {
    let _ = db.tx(|tx| {
        let mut st = tx.prepare_cached(
            "INSERT INTO job_logs (job_id, ts, stream, line) VALUES (?1, ?2, ?3, ?4)",
        )?;
        for (id, lines) in batch {
            // Keep the DB lean during very chatty stages; the full log is on disk.
            let skip = lines.len().saturating_sub(MAX_DB_LOG_LINES_PER_FLUSH);
            for l in lines.iter().skip(skip) {
                st.execute(rusqlite::params![id, l.ts, l.stream, l.text])?;
            }
        }
        Ok(())
    });
    for (id, lines) in batch {
        let dir = jobs_dir.join(id);
        if std::fs::create_dir_all(&dir).is_err() {
            continue;
        }
        if let Ok(mut f) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(dir.join("job.log"))
        {
            for l in lines {
                let _ = writeln!(f, "[{}] {}", l.stream, l.text);
            }
        }
    }
}
