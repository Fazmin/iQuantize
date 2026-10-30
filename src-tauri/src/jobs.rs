//! Background jobs: installs, downloads, quantizations, evaluations and uploads all run
//! through here so the UI gets one consistent model: a job row with ordered stages,
//! progress, logs, live tensor/metric events and cancellation.

use crate::db::{json_col, new_id, now_ms, Db};
use crate::error::{AppError, AppResult};
use crate::events::EventHub;
use crate::process::{run_streaming, Outcome, Spawn, Stream};
use rusqlite::OptionalExtension;
use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::future::Future;
use std::sync::{Arc, Mutex};
use tokio::sync::Semaphore;
use tokio_util::sync::CancellationToken;

#[derive(Debug, Clone, Serialize)]
pub struct StageRow {
    pub idx: i64,
    pub key: String,
    pub label: String,
    pub status: String,
    pub cached: bool,
    pub started_at: Option<i64>,
    pub finished_at: Option<i64>,
    pub detail: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct JobRow {
    pub id: String,
    pub kind: String,
    pub title: String,
    pub status: String,
    pub model_id: Option<String>,
    pub format: Option<String>,
    pub params: Value,
    pub result: Value,
    pub error: Option<String>,
    pub progress: f64,
    pub stage: Option<String>,
    pub created_at: i64,
    pub started_at: Option<i64>,
    pub finished_at: Option<i64>,
    pub stages: Vec<StageRow>,
}

#[derive(Debug, Clone)]
pub struct StageDef {
    pub key: String,
    pub label: String,
    pub weight: f64,
}

impl StageDef {
    pub fn new(key: &str, label: impl Into<String>, weight: f64) -> Self {
        Self {
            key: key.into(),
            label: label.into(),
            weight,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Lane {
    /// RAM/CPU heavy work (quantize, eval). Limited by the concurrency setting.
    Heavy,
    /// Toolchain installs, serialized so package managers don't fight.
    Install,
    /// Network-bound work (downloads, uploads); runs immediately.
    Free,
}

pub struct NewJob {
    pub kind: &'static str,
    pub title: String,
    pub model_id: Option<String>,
    pub format: Option<String>,
    pub params: Value,
    pub stages: Vec<StageDef>,
    pub lane: Lane,
}

pub struct JobManager {
    db: Arc<Db>,
    hub: EventHub,
    running: Mutex<HashMap<String, CancellationToken>>,
    heavy: Arc<Semaphore>,
    install: Arc<Semaphore>,
}

impl JobManager {
    pub fn new(db: Arc<Db>, hub: EventHub, concurrency: usize) -> Self {
        Self {
            db,
            hub,
            running: Mutex::new(HashMap::new()),
            heavy: Arc::new(Semaphore::new(concurrency.max(1))),
            install: Arc::new(Semaphore::new(1)),
        }
    }

    /// Marks jobs left running by a previous session as failed.
    pub fn recover_interrupted(&self) -> AppResult<()> {
        let ts = now_ms();
        self.db.with(|c| {
            c.execute(
                "UPDATE jobs SET status = 'failed', error = 'Interrupted: the app was closed while this job was running.', finished_at = ?1
                 WHERE status IN ('running', 'queued')",
                [ts],
            )?;
            c.execute("UPDATE job_stages SET status = 'cancelled' WHERE status IN ('running', 'pending')", [])
        })?;
        Ok(())
    }

    pub fn is_active(&self, id: &str) -> bool {
        self.running
            .lock()
            .map(|m| m.contains_key(id))
            .unwrap_or(false)
    }

    pub fn active_ids(&self) -> Vec<String> {
        self.running
            .lock()
            .map(|m| m.keys().cloned().collect())
            .unwrap_or_default()
    }

    pub fn submit<F, Fut>(self: &Arc<Self>, job: NewJob, f: F) -> AppResult<String>
    where
        F: FnOnce(JobCtx) -> Fut + Send + 'static,
        Fut: Future<Output = AppResult<Value>> + Send + 'static,
    {
        let id = new_id();
        let ts = now_ms();
        let stages = Arc::new(job.stages);
        self.db.tx(|tx| {
            tx.execute(
                "INSERT INTO jobs (id, kind, title, status, model_id, format, params_json, created_at) VALUES (?1, ?2, ?3, 'queued', ?4, ?5, ?6, ?7)",
                rusqlite::params![id, job.kind, job.title, job.model_id, job.format, job.params.to_string(), ts],
            )?;
            for (i, s) in stages.iter().enumerate() {
                tx.execute(
                    "INSERT INTO job_stages (job_id, idx, key, label, status) VALUES (?1, ?2, ?3, ?4, 'pending')",
                    rusqlite::params![id, i as i64, s.key, s.label],
                )?;
            }
            Ok(())
        })?;
        let cancel = CancellationToken::new();
        if let Ok(mut m) = self.running.lock() {
            m.insert(id.clone(), cancel.clone());
        }
        self.emit_update(&id);

        let ctx = JobCtx {
            id: id.clone(),
            cancel: cancel.clone(),
            hub: self.hub.clone(),
            db: self.db.clone(),
            stages,
            done_weight: Arc::new(Mutex::new(0.0)),
            current: Arc::new(Mutex::new(None)),
        };
        let me = self.clone();
        let lane = job.lane;
        let job_id = id.clone();
        tauri::async_runtime::spawn(async move {
            let sem = match lane {
                Lane::Heavy => Some(me.heavy.clone()),
                Lane::Install => Some(me.install.clone()),
                Lane::Free => None,
            };
            let permit = match sem {
                Some(s) => {
                    tokio::select! {
                        p = s.acquire_owned() => p.ok(),
                        _ = cancel.cancelled() => {
                            me.finish(&job_id, Err(AppError::cancelled()));
                            return;
                        }
                    }
                }
                None => None,
            };
            let _ = me.db.with(|c| {
                c.execute(
                    "UPDATE jobs SET status = 'running', started_at = ?1 WHERE id = ?2",
                    rusqlite::params![now_ms(), job_id],
                )
            });
            me.emit_update(&job_id);
            let result = f(ctx.clone()).await;
            let result = if cancel.is_cancelled() {
                Err(AppError::cancelled())
            } else {
                result
            };
            ctx.close_open_stage(if result.is_ok() {
                "done"
            } else if cancel.is_cancelled() {
                "cancelled"
            } else {
                "failed"
            });
            me.finish(&job_id, result);
            drop(permit);
        });
        Ok(id)
    }

    fn finish(&self, id: &str, result: AppResult<Value>) {
        let ts = now_ms();
        let _ = match &result {
            Ok(v) => self.db.with(|c| {
                c.execute(
                    "UPDATE jobs SET status = 'done', progress = 1, result_json = ?1, finished_at = ?2 WHERE id = ?3",
                    rusqlite::params![v.to_string(), ts, id],
                )
            }),
            Err(e) if e.code == "cancelled" => self.db.with(|c| {
                c.execute("UPDATE jobs SET status = 'cancelled', finished_at = ?1 WHERE id = ?2", rusqlite::params![ts, id])?;
                c.execute("UPDATE job_stages SET status = 'cancelled' WHERE job_id = ?1 AND status IN ('pending', 'running')", [id])
            }),
            Err(e) => {
                let msg = match &e.hint {
                    Some(h) => format!("{}\n\nHint: {h}", e.message),
                    None => e.message.clone(),
                };
                self.hub.log(id, "stderr", format!("✖ {}", e.message));
                self.db.with(|c| {
                    c.execute(
                        "UPDATE jobs SET status = 'failed', error = ?1, finished_at = ?2 WHERE id = ?3",
                        rusqlite::params![msg, ts, id],
                    )?;
                    c.execute("UPDATE job_stages SET status = 'skipped' WHERE job_id = ?1 AND status = 'pending'", [id])
                })
            }
        };
        if let Ok(mut m) = self.running.lock() {
            m.remove(id);
        }
        self.emit_update(id);
    }

    pub fn cancel(&self, id: &str) -> bool {
        if let Some(tok) = self.running.lock().ok().and_then(|m| m.get(id).cloned()) {
            tok.cancel();
            return true;
        }
        false
    }

    pub fn emit_update(&self, id: &str) {
        if let Ok(row) = get_job(&self.db, id) {
            self.hub.emit("job:update", row);
        }
    }
}

pub fn get_job(db: &Db, id: &str) -> AppResult<JobRow> {
    let job = db
        .with(|c| {
            c.query_row(
                "SELECT id, kind, title, status, model_id, format, params_json, result_json, error, progress, stage, created_at, started_at, finished_at FROM jobs WHERE id = ?1",
                [id],
                row_to_job,
            )
            .optional()
        })?
        .ok_or_else(|| AppError::not_found("Job"))?;
    let stages = stages_for(db, id)?;
    Ok(JobRow { stages, ..job })
}

pub fn list_jobs(db: &Db, kind: Option<&str>, limit: i64) -> AppResult<Vec<JobRow>> {
    let mut jobs = db.with(|c| {
        let mut st = c.prepare(
            "SELECT id, kind, title, status, model_id, format, params_json, result_json, error, progress, stage, created_at, started_at, finished_at
             FROM jobs WHERE (?1 IS NULL OR kind = ?1) ORDER BY created_at DESC LIMIT ?2",
        )?;
        let rows = st.query_map(rusqlite::params![kind, limit], row_to_job)?;
        rows.collect::<Result<Vec<_>, _>>()
    })?;
    for j in jobs.iter_mut() {
        j.stages = stages_for(db, &j.id)?;
    }
    Ok(jobs)
}

fn row_to_job(r: &rusqlite::Row) -> rusqlite::Result<JobRow> {
    Ok(JobRow {
        id: r.get(0)?,
        kind: r.get(1)?,
        title: r.get(2)?,
        status: r.get(3)?,
        model_id: r.get(4)?,
        format: r.get(5)?,
        params: json_col(r.get(6)?),
        result: json_col(r.get(7)?),
        error: r.get(8)?,
        progress: r.get(9)?,
        stage: r.get(10)?,
        created_at: r.get(11)?,
        started_at: r.get(12)?,
        finished_at: r.get(13)?,
        stages: vec![],
    })
}

fn stages_for(db: &Db, id: &str) -> AppResult<Vec<StageRow>> {
    db.with(|c| {
        let mut st = c.prepare(
            "SELECT idx, key, label, status, cached, started_at, finished_at, detail FROM job_stages WHERE job_id = ?1 ORDER BY idx",
        )?;
        let rows = st.query_map([id], |r| {
            Ok(StageRow {
                idx: r.get(0)?,
                key: r.get(1)?,
                label: r.get(2)?,
                status: r.get(3)?,
                cached: r.get::<_, i64>(4)? != 0,
                started_at: r.get(5)?,
                finished_at: r.get(6)?,
                detail: r.get(7)?,
            })
        })?;
        rows.collect()
    })
}

pub fn job_logs(db: &Db, id: &str, after: i64, limit: i64) -> AppResult<Vec<Value>> {
    db.with(|c| {
        let mut st = c.prepare("SELECT id, ts, stream, line FROM job_logs WHERE job_id = ?1 AND id > ?2 ORDER BY id LIMIT ?3")?;
        let rows = st.query_map(rusqlite::params![id, after, limit], |r| {
            Ok(serde_json::json!({ "seq": r.get::<_, i64>(0)?, "ts": r.get::<_, i64>(1)?, "stream": r.get::<_, String>(2)?, "text": r.get::<_, String>(3)? }))
        })?;
        rows.collect()
    })
}

/// Handle given to job bodies.
#[derive(Clone)]
pub struct JobCtx {
    pub id: String,
    pub cancel: CancellationToken,
    pub hub: EventHub,
    db: Arc<Db>,
    stages: Arc<Vec<StageDef>>,
    done_weight: Arc<Mutex<f64>>,
    current: Arc<Mutex<Option<usize>>>,
}

impl JobCtx {
    pub fn log(&self, line: impl Into<String>) {
        self.hub.log(&self.id, "info", line);
    }

    pub fn check_cancel(&self) -> AppResult<()> {
        if self.cancel.is_cancelled() {
            return Err(AppError::cancelled());
        }
        Ok(())
    }

    fn total_weight(&self) -> f64 {
        self.stages
            .iter()
            .map(|s| s.weight)
            .sum::<f64>()
            .max(f64::EPSILON)
    }

    fn idx_of(&self, key: &str) -> Option<usize> {
        self.stages.iter().position(|s| s.key == key)
    }

    fn set_stage_status(&self, idx: usize, status: &str, cached: bool, detail: Option<&str>) {
        let ts = now_ms();
        let _ = self.db.with(|c| {
            match status {
                "running" => c.execute(
                    "UPDATE job_stages SET status = ?1, started_at = ?2 WHERE job_id = ?3 AND idx = ?4",
                    rusqlite::params![status, ts, self.id, idx as i64],
                )?,
                _ => c.execute(
                    "UPDATE job_stages SET status = ?1, finished_at = ?2, cached = ?3, detail = COALESCE(?4, detail) WHERE job_id = ?5 AND idx = ?6",
                    rusqlite::params![status, ts, cached as i64, detail, self.id, idx as i64],
                )?,
            };
            if status == "running" {
                c.execute("UPDATE jobs SET stage = ?1 WHERE id = ?2", rusqlite::params![self.stages[idx].key, self.id])?;
            }
            Ok(())
        });
        if let Ok(row) = get_job(&self.db, &self.id) {
            self.hub.emit("job:update", row);
        }
    }

    /// Starts a stage (finishing any stage still open as done).
    pub fn stage(&self, key: &str) -> AppResult<()> {
        self.check_cancel()?;
        self.close_open_stage("done");
        let Some(idx) = self.idx_of(key) else {
            return Ok(());
        };
        if let Ok(mut c) = self.current.lock() {
            *c = Some(idx);
        }
        self.set_stage_status(idx, "running", false, None);
        self.log(format!("▸ {}", self.stages[idx].label));
        self.stage_progress(0.0, None);
        Ok(())
    }

    /// Marks a stage as satisfied from cache without running it.
    pub fn stage_cached(&self, key: &str, detail: &str) {
        self.close_open_stage("done");
        if let Some(idx) = self.idx_of(key) {
            self.set_stage_status(idx, "done", true, Some(detail));
            self.add_done(idx);
            self.log(format!(
                "▸ {} (reused from cache: {detail})",
                self.stages[idx].label
            ));
        }
    }

    pub fn stage_detail(&self, detail: &str) {
        if let Some(idx) = self.current.lock().ok().and_then(|c| *c) {
            let _ = self.db.with(|c| {
                c.execute(
                    "UPDATE job_stages SET detail = ?1 WHERE job_id = ?2 AND idx = ?3",
                    rusqlite::params![detail, self.id, idx as i64],
                )
            });
        }
    }

    fn add_done(&self, idx: usize) {
        if let Ok(mut w) = self.done_weight.lock() {
            *w += self.stages[idx].weight;
        }
        let w = self.done_weight.lock().map(|w| *w).unwrap_or(0.0);
        self.hub.progress(
            &self.id,
            w / self.total_weight(),
            Some(&self.stages[idx].key),
            None,
            None,
        );
    }

    fn close_open_stage(&self, status: &str) {
        let open = self.current.lock().ok().and_then(|mut c| c.take());
        if let Some(idx) = open {
            self.set_stage_status(idx, status, false, None);
            if status == "done" {
                self.add_done(idx);
            }
        }
    }

    /// Progress within the current stage, 0..1. Converted to overall job progress.
    pub fn stage_progress(&self, frac: f64, detail: Option<String>) {
        self.stage_progress_extra(frac, detail, None);
    }

    pub fn stage_progress_extra(&self, frac: f64, detail: Option<String>, extra: Option<Value>) {
        let cur = self.current.lock().ok().and_then(|c| *c);
        let done = self.done_weight.lock().map(|w| *w).unwrap_or(0.0);
        let (stage_w, key) = match cur {
            Some(i) => (self.stages[i].weight, Some(self.stages[i].key.as_str())),
            None => (0.0, None),
        };
        let overall = (done + stage_w * frac.clamp(0.0, 1.0)) / self.total_weight();
        self.hub.progress(&self.id, overall, key, detail, extra);
    }

    pub fn tensor(&self, item: Value) {
        self.hub.tensor(&self.id, item);
    }

    pub fn metric(&self, name: &str, value: f64, step: Option<i64>) {
        self.hub.metric(&self.id, name, value, step);
    }

    /// Runs a process, logging every line, and forwards lines to `handler`.
    pub async fn exec(
        &self,
        spec: &Spawn,
        mut handler: impl FnMut(Stream, &str),
    ) -> AppResult<Outcome> {
        self.hub
            .log(&self.id, "cmd", format!("$ {}", spec.display()));
        let id = self.id.clone();
        let hub = self.hub.clone();
        run_streaming(spec, &self.cancel, |s, l| {
            if !l.starts_with("@@IQ ") {
                hub.log(&id, s.as_str(), l);
            }
            handler(s, l);
        })
        .await
    }
}
