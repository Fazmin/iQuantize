//! Child-process layer: spawns tools in their own process group (Unix) or with
//! CREATE_NO_WINDOW + a new process group (Windows), streams stdout/stderr line by line
//! (splitting on both `\n` and `\r` so tqdm-style progress bars arrive as lines), and
//! kills the whole process tree on cancel.

use crate::error::{AppError, AppResult};
use std::collections::VecDeque;
use std::ffi::OsString;
use std::path::PathBuf;
use std::process::{ExitStatus, Stdio};
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

#[derive(Debug, Clone)]
pub struct Spawn {
    pub program: PathBuf,
    pub args: Vec<OsString>,
    pub cwd: Option<PathBuf>,
    pub env: Vec<(String, String)>,
}

impl Spawn {
    pub fn new(program: impl Into<PathBuf>) -> Self {
        Self {
            program: program.into(),
            args: vec![],
            cwd: None,
            env: vec![],
        }
    }
    pub fn arg(mut self, a: impl Into<OsString>) -> Self {
        self.args.push(a.into());
        self
    }
    pub fn args<I, S>(mut self, it: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<OsString>,
    {
        self.args.extend(it.into_iter().map(Into::into));
        self
    }
    pub fn env(mut self, k: &str, v: impl Into<String>) -> Self {
        self.env.push((k.into(), v.into()));
        self
    }
    pub fn cwd(mut self, p: impl Into<PathBuf>) -> Self {
        self.cwd = Some(p.into());
        self
    }

    /// Human-readable command line for logs and reproducibility sections (no env).
    pub fn display(&self) -> String {
        let mut parts = vec![quote(&self.program.to_string_lossy())];
        parts.extend(self.args.iter().map(|a| quote(&a.to_string_lossy())));
        parts.join(" ")
    }

    fn command(&self) -> Command {
        let mut cmd = Command::new(&self.program);
        cmd.args(&self.args);
        if let Some(cwd) = &self.cwd {
            cmd.current_dir(cwd);
        }
        for (k, v) in &self.env {
            cmd.env(k, v);
        }
        // Python env hygiene for every child.
        cmd.env("PYTHONDONTWRITEBYTECODE", "1");
        cmd.env_remove("PYTHONPATH");
        cmd.env_remove("PYTHONHOME");
        cmd.env_remove("VIRTUAL_ENV");
        cmd.env_remove("CONDA_PREFIX");
        #[cfg(unix)]
        {
            cmd.process_group(0);
        }
        #[cfg(windows)]
        {
            // CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP
            cmd.creation_flags(0x0800_0000 | 0x0000_0200);
        }
        cmd.kill_on_drop(true);
        cmd
    }
}

fn quote(s: &str) -> String {
    if s.is_empty()
        || s.chars()
            .any(|c| c.is_whitespace() || "\"'$`\\".contains(c))
    {
        format!("'{}'", s.replace('\'', "'\\''"))
    } else {
        s.to_string()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Stream {
    Stdout,
    Stderr,
}

impl Stream {
    pub fn as_str(self) -> &'static str {
        match self {
            Stream::Stdout => "stdout",
            Stream::Stderr => "stderr",
        }
    }
}

pub struct Outcome {
    pub status: ExitStatus,
    /// Last lines of stderr+stdout, useful for error messages.
    pub tail: Vec<String>,
}

impl Outcome {
    pub fn ensure_success(&self, what: &str) -> AppResult<()> {
        if self.status.success() {
            return Ok(());
        }
        let tail = self
            .tail
            .iter()
            .rev()
            .take(8)
            .rev()
            .cloned()
            .collect::<Vec<_>>()
            .join("\n");
        Err(AppError::new("process", format!("{what} failed ({}).\n{tail}", describe_status(&self.status)))
            .with_hint("Open the log below for details. If a component looks broken, use Repair in Environment."))
    }
}

pub fn describe_status(s: &ExitStatus) -> String {
    if let Some(code) = s.code() {
        return format!("exit code {code}");
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        if let Some(sig) = s.signal() {
            return match sig {
                9 => "killed (possibly out of memory)".into(),
                _ => format!("signal {sig}"),
            };
        }
    }
    "terminated".into()
}

/// Runs a process to completion, calling `on_line` for each output line.
/// Cancelling the token kills the whole tree and returns `AppError::cancelled()`.
pub async fn run_streaming(
    spec: &Spawn,
    cancel: &CancellationToken,
    mut on_line: impl FnMut(Stream, &str),
) -> AppResult<Outcome> {
    let mut cmd = spec.command();
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = cmd.spawn().map_err(|e| spawn_error(spec, e))?;
    let pid = child.id();
    let (tx, mut rx) = mpsc::channel::<(Stream, String)>(1024);
    if let Some(out) = child.stdout.take() {
        tokio::spawn(read_lines(out, Stream::Stdout, tx.clone()));
    }
    if let Some(err) = child.stderr.take() {
        tokio::spawn(read_lines(err, Stream::Stderr, tx.clone()));
    }
    drop(tx);
    let mut tail: VecDeque<String> = VecDeque::with_capacity(64);
    let mut readers_open = true;
    let status = loop {
        tokio::select! {
            line = rx.recv(), if readers_open => {
                match line {
                    Some((s, l)) => {
                        on_line(s, &l);
                        if tail.len() == 64 { tail.pop_front(); }
                        tail.push_back(l);
                    }
                    None => readers_open = false,
                }
            }
            st = child.wait(), if !readers_open => break st?,
            _ = cancel.cancelled() => {
                kill_tree(pid, &mut child).await;
                return Err(AppError::cancelled());
            }
        }
    };
    Ok(Outcome {
        status,
        tail: tail.into_iter().collect(),
    })
}

/// Runs a short command and captures its combined output (for `--help` probes etc.).
pub async fn capture(spec: &Spawn, timeout_secs: u64) -> AppResult<(ExitStatus, String)> {
    let cancel = CancellationToken::new();
    let mut text = String::new();
    let fut = run_streaming(spec, &cancel, |_, l| {
        text.push_str(l);
        text.push('\n');
    });
    let outcome =
        match tokio::time::timeout(std::time::Duration::from_secs(timeout_secs), fut).await {
            Ok(r) => r?,
            Err(_) => {
                cancel.cancel();
                return Err(AppError::new(
                    "timeout",
                    format!("{} timed out", spec.program.display()),
                ));
            }
        };
    Ok((outcome.status, text))
}

fn spawn_error(spec: &Spawn, e: std::io::Error) -> AppError {
    if e.kind() == std::io::ErrorKind::NotFound {
        return AppError::new(
            "missing_tool",
            format!("{} was not found", spec.program.display()),
        )
        .with_hint("Install or repair the component in Environment.");
    }
    AppError::new(
        "process",
        format!("Could not start {}: {e}", spec.program.display()),
    )
}

async fn read_lines<R: AsyncRead + Unpin>(
    mut r: R,
    stream: Stream,
    tx: mpsc::Sender<(Stream, String)>,
) {
    let mut buf = vec![0u8; 16 * 1024];
    let mut pending: Vec<u8> = Vec::with_capacity(4096);
    loop {
        let n = match r.read(&mut buf).await {
            Ok(0) | Err(_) => break,
            Ok(n) => n,
        };
        for &b in &buf[..n] {
            if b == b'\n' || b == b'\r' {
                if !pending.is_empty() {
                    let line = String::from_utf8_lossy(&pending).trim_end().to_string();
                    pending.clear();
                    if !line.is_empty() && tx.send((stream, line)).await.is_err() {
                        return;
                    }
                }
            } else {
                pending.push(b);
            }
        }
    }
    if !pending.is_empty() {
        let _ = tx
            .send((
                stream,
                String::from_utf8_lossy(&pending).trim_end().to_string(),
            ))
            .await;
    }
}

async fn kill_tree(pid: Option<u32>, child: &mut Child) {
    #[cfg(unix)]
    {
        if let Some(pid) = pid {
            unsafe {
                libc::killpg(pid as i32, libc::SIGTERM);
            }
            if tokio::time::timeout(std::time::Duration::from_secs(4), child.wait())
                .await
                .is_ok()
            {
                return;
            }
            unsafe {
                libc::killpg(pid as i32, libc::SIGKILL);
            }
        }
    }
    #[cfg(windows)]
    {
        if let Some(pid) = pid {
            let mut tk = Command::new("taskkill");
            tk.args(["/PID", &pid.to_string(), "/T", "/F"])
                .creation_flags(0x0800_0000);
            let _ = tk.output().await;
        }
    }
    let _ = child.kill().await;
    let _ = child.wait().await;
}

/// A long-running child (inference server / stdio driver) we keep talking to.
pub struct Persistent {
    pub pid: Option<u32>,
    pub stdin: Option<ChildStdin>,
    pub lines: mpsc::Receiver<(Stream, String)>,
    child: Child,
}

impl Persistent {
    pub fn spawn(spec: &Spawn, with_stdin: bool) -> AppResult<Self> {
        let mut cmd = spec.command();
        cmd.stdin(if with_stdin {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
        let mut child = cmd.spawn().map_err(|e| spawn_error(spec, e))?;
        let (tx, rx) = mpsc::channel(4096);
        if let Some(out) = child.stdout.take() {
            tokio::spawn(read_lines(out, Stream::Stdout, tx.clone()));
        }
        if let Some(err) = child.stderr.take() {
            tokio::spawn(read_lines(err, Stream::Stderr, tx));
        }
        Ok(Self {
            pid: child.id(),
            stdin: child.stdin.take(),
            lines: rx,
            child,
        })
    }

    pub fn try_status(&mut self) -> Option<ExitStatus> {
        self.child.try_wait().ok().flatten()
    }

    pub async fn kill(mut self) {
        kill_tree(self.pid, &mut self.child).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn streams_lines_split_on_cr() {
        if cfg!(windows) {
            return;
        }
        let spec =
            Spawn::new("/bin/sh").args(["-c", "printf 'a\\rb\\nc\\n'; printf 'err\\n' 1>&2"]);
        let mut seen = vec![];
        let out = run_streaming(&spec, &CancellationToken::new(), |s, l| {
            seen.push((s, l.to_string()))
        })
        .await
        .unwrap();
        assert!(out.status.success());
        let texts: Vec<&str> = seen.iter().map(|(_, l)| l.as_str()).collect();
        assert!(
            texts.contains(&"a")
                && texts.contains(&"b")
                && texts.contains(&"c")
                && texts.contains(&"err")
        );
    }

    #[tokio::test]
    async fn cancel_kills_process_group() {
        if cfg!(windows) {
            return;
        }
        let spec = Spawn::new("/bin/sh").args(["-c", "sleep 30 & sleep 30"]);
        let cancel = CancellationToken::new();
        let c2 = cancel.clone();
        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(200)).await;
            c2.cancel();
        });
        let start = std::time::Instant::now();
        let r = run_streaming(&spec, &cancel, |_, _| {}).await;
        assert!(matches!(r, Err(e) if e.code == "cancelled"));
        assert!(start.elapsed().as_secs() < 10);
    }
}
