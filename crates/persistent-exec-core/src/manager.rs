use std::collections::HashMap;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;

use persistent_exec_pty::SpawnedProcess;
use persistent_exec_pty::TerminalSize;
use serde::Deserialize;
use serde::Serialize;
use tokio::runtime::Runtime;

use crate::error::ErrorKind;
use crate::error::ExecError;
use crate::error::Result;
use crate::session::Session;
use crate::session::collect_process_output;

const MAX_SESSIONS: usize = 64;

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
pub struct SpawnRequest {
    pub cmd: String,
    pub workdir: PathBuf,
    #[serde(default)]
    pub tty: bool,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub struct PollResponse {
    pub output: Vec<u8>,
    pub omitted_bytes: usize,
    pub exit_code: Option<i32>,
}

/// Owns all process sessions for one agent session.
#[derive(Debug)]
pub struct ExecRuntime {
    runtime: Option<Runtime>,
    registry: Mutex<SessionRegistry>,
    next_session_id: AtomicU64,
}

#[derive(Debug, Default)]
struct SessionRegistry {
    sessions: HashMap<u64, Arc<Session>>,
    pending_spawns: usize,
}

impl ExecRuntime {
    pub fn new() -> Result<Self> {
        let runtime = Runtime::new().map_err(|error| {
            ExecError::new(
                ErrorKind::Internal,
                format!("failed to initialize async runtime: {error}"),
            )
        })?;
        Ok(Self {
            runtime: Some(runtime),
            registry: Mutex::new(SessionRegistry::default()),
            next_session_id: AtomicU64::new(1),
        })
    }

    pub fn spawn(&self, request: SpawnRequest) -> Result<u64> {
        validate_spawn_request(&request)?;
        {
            let mut registry = self
                .registry
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            if registry.sessions.len() + registry.pending_spawns >= MAX_SESSIONS {
                return Err(ExecError::new(
                    ErrorKind::ResourceExhausted,
                    format!("at most {MAX_SESSIONS} sessions may run concurrently"),
                ));
            }
            registry.pending_spawns += 1;
        }

        let spawned = match self.runtime().block_on(spawn_shell_command(&request)) {
            Ok(spawned) => spawned,
            Err(error) => {
                self.finish_pending_spawn();
                return Err(ExecError::new(
                    ErrorKind::SpawnFailed,
                    format!("failed to spawn command: {error}"),
                ));
            }
        };
        let session_id = self.next_session_id.fetch_add(1, Ordering::Relaxed);
        let SpawnedProcess {
            session: process,
            stdout_rx,
            stderr_rx,
            exit_rx,
        } = spawned;
        let session = Arc::new(Session::new(process));

        {
            let mut registry = self
                .registry
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            registry.pending_spawns -= 1;
            registry.sessions.insert(session_id, Arc::clone(&session));
        }
        self.runtime().spawn(collect_process_output(
            session, stdout_rx, stderr_rx, exit_rx,
        ));

        Ok(session_id)
    }

    pub fn write(&self, session_id: u64, chars: String) -> Result<()> {
        let session = self.get_session(session_id)?;
        if chars == "\u{3}" {
            session.interrupt()
        } else {
            session.write(chars.into_bytes())
        }
    }

    pub fn poll(&self, session_id: u64) -> Result<PollResponse> {
        let session = self.get_session(session_id)?;
        let output = session.take_output();
        if output.exit_code.is_some() {
            self.registry
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .sessions
                .remove(&session_id);
        }
        Ok(PollResponse {
            output: output.output,
            omitted_bytes: output.omitted_bytes,
            exit_code: output.exit_code,
        })
    }

    pub fn terminate(&self, session_id: u64) -> Result<()> {
        let session = self.get_session(session_id)?;
        session.terminate();
        Ok(())
    }

    pub fn shutdown(&self) {
        let sessions = self
            .registry
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .sessions
            .drain()
            .map(|(_, session)| session)
            .collect::<Vec<_>>();
        for session in sessions {
            session.terminate();
        }
    }

    fn runtime(&self) -> &Runtime {
        self.runtime
            .as_ref()
            .expect("runtime is available until ExecRuntime::drop")
    }

    fn get_session(&self, session_id: u64) -> Result<Arc<Session>> {
        self.registry
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .sessions
            .get(&session_id)
            .cloned()
            .ok_or_else(|| {
                ExecError::new(
                    ErrorKind::NotFound,
                    format!("unknown session_id {session_id}"),
                )
            })
    }

    fn finish_pending_spawn(&self) {
        let mut registry = self
            .registry
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        registry.pending_spawns -= 1;
    }
}

impl Drop for ExecRuntime {
    fn drop(&mut self) {
        self.shutdown();
        if let Some(runtime) = self.runtime.take() {
            runtime.shutdown_background();
        }
    }
}

fn validate_spawn_request(request: &SpawnRequest) -> Result<()> {
    if request.cmd.trim().is_empty() {
        return Err(ExecError::new(
            ErrorKind::InvalidInput,
            "cmd must not be empty",
        ));
    }
    if !request.workdir.is_dir() {
        return Err(ExecError::new(
            ErrorKind::InvalidInput,
            format!("workdir is not a directory: {}", request.workdir.display()),
        ));
    }
    Ok(())
}

async fn spawn_shell_command(request: &SpawnRequest) -> anyhow::Result<SpawnedProcess> {
    let (program, args) = shell_command(&request.cmd);
    let environment = std::env::vars().collect::<HashMap<_, _>>();
    if request.tty {
        persistent_exec_pty::spawn_pty_process(
            &program,
            &args,
            Path::new(&request.workdir),
            &environment,
            &None,
            TerminalSize::default(),
            &[],
        )
        .await
    } else {
        persistent_exec_pty::spawn_pipe_process(
            &program,
            &args,
            Path::new(&request.workdir),
            &environment,
            &None,
            &[],
        )
        .await
    }
}

#[cfg(unix)]
fn shell_command(cmd: &str) -> (String, Vec<String>) {
    let shell = std::env::var("SHELL")
        .ok()
        .filter(|shell| !shell.is_empty())
        .unwrap_or_else(|| "/bin/sh".to_string());
    (shell, vec!["-c".to_string(), cmd.to_string()])
}

#[cfg(windows)]
fn shell_command(cmd: &str) -> (String, Vec<String>) {
    let shell = std::env::var("COMSPEC")
        .ok()
        .filter(|shell| !shell.is_empty())
        .unwrap_or_else(|| "cmd.exe".to_string());
    (
        shell,
        vec![
            "/D".to_string(),
            "/S".to_string(),
            "/C".to_string(),
            cmd.to_string(),
        ],
    )
}
