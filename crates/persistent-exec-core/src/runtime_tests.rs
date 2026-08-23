use std::path::PathBuf;
#[cfg(unix)]
use std::sync::Arc;
#[cfg(unix)]
use std::sync::Barrier;
use std::time::Duration;
use std::time::Instant;

use pretty_assertions::assert_eq;

use crate::ErrorKind;
use crate::ExecRuntime;
use crate::PollResponse;
use crate::SpawnRequest;

fn request(cmd: &str, tty: bool) -> SpawnRequest {
    SpawnRequest {
        cmd: cmd.to_string(),
        workdir: PathBuf::from(env!("CARGO_MANIFEST_DIR")),
        tty,
    }
}

fn collect_until_exit(runtime: &ExecRuntime, session_id: u64) -> PollResponse {
    let deadline = Instant::now() + Duration::from_secs(5);
    let mut output = Vec::new();
    let mut omitted_bytes = 0;
    loop {
        let response = runtime.poll(session_id).expect("poll should succeed");
        output.extend(response.output);
        omitted_bytes += response.omitted_bytes;
        if let Some(exit_code) = response.exit_code {
            return PollResponse {
                output,
                omitted_bytes,
                exit_code: Some(exit_code),
            };
        }
        assert!(Instant::now() < deadline, "process did not exit in time");
        std::thread::sleep(Duration::from_millis(10));
    }
}

#[tokio::test]
async fn runtime_can_be_dropped_from_an_async_context() {
    drop(ExecRuntime::new().expect("runtime should initialize"));
}

#[test]
fn completed_command_returns_output_and_exit_code() {
    let runtime = ExecRuntime::new().expect("runtime should initialize");
    let session_id = runtime
        .spawn(request(short_output_command(), false))
        .expect("spawn should succeed");

    let response = collect_until_exit(&runtime, session_id);

    assert_eq!(
        response,
        PollResponse {
            output: expected_short_output().to_vec(),
            omitted_bytes: 0,
            exit_code: Some(0),
        }
    );
    assert_eq!(
        runtime
            .poll(session_id)
            .expect_err("session is consumed")
            .kind(),
        ErrorKind::NotFound
    );
}

#[cfg(unix)]
#[test]
fn pipe_session_accepts_stdin_and_returns_incremental_output() {
    let runtime = ExecRuntime::new().expect("runtime should initialize");
    let session_id = runtime
        .spawn(request(
            "printf ready; read line; printf 'received:%s' \"$line\"",
            false,
        ))
        .expect("spawn should succeed");

    let deadline = Instant::now() + Duration::from_secs(5);
    let first = loop {
        let response = runtime.poll(session_id).expect("poll should succeed");
        if !response.output.is_empty() {
            break response;
        }
        assert!(Instant::now() < deadline, "initial output did not arrive");
        std::thread::sleep(Duration::from_millis(10));
    };
    runtime
        .write(session_id, "hello\n".to_string())
        .expect("stdin write should succeed");
    let second = collect_until_exit(&runtime, session_id);

    assert_eq!(first.output, b"ready");
    assert_eq!(second.output, b"received:hello");
    assert_eq!(second.exit_code, Some(0));
}

#[cfg(unix)]
#[test]
fn concurrent_spawns_respect_the_session_limit() {
    const CALLERS: usize = 80;
    const SESSION_LIMIT: usize = 64;
    let runtime = Arc::new(ExecRuntime::new().expect("runtime should initialize"));
    let barrier = Arc::new(Barrier::new(CALLERS));
    let handles = (0..CALLERS)
        .map(|_| {
            let runtime = Arc::clone(&runtime);
            let barrier = Arc::clone(&barrier);
            std::thread::spawn(move || {
                barrier.wait();
                runtime.spawn(request("sleep 60", false))
            })
        })
        .collect::<Vec<_>>();

    let results = handles
        .into_iter()
        .map(|handle| handle.join().expect("spawn thread should not panic"))
        .collect::<Vec<_>>();
    let successes = results.iter().filter(|result| result.is_ok()).count();
    let exhausted = results
        .iter()
        .filter(|result| {
            result
                .as_ref()
                .is_err_and(|error| error.kind() == ErrorKind::ResourceExhausted)
        })
        .count();

    assert_eq!(
        (successes, exhausted),
        (SESSION_LIMIT, CALLERS - SESSION_LIMIT)
    );
    runtime.shutdown();
}

#[test]
fn interrupt_finishes_a_running_session() {
    let runtime = ExecRuntime::new().expect("runtime should initialize");
    let session_id = runtime
        .spawn(request(long_running_command(), cfg!(windows)))
        .expect("spawn should succeed");

    runtime
        .write(session_id, "\u{3}".to_string())
        .expect("interrupt should succeed");
    let response = collect_until_exit(&runtime, session_id);

    assert_ne!(response.exit_code, Some(0));
}

#[cfg(unix)]
fn short_output_command() -> &'static str {
    "printf persistent-exec"
}

#[cfg(unix)]
fn expected_short_output() -> &'static [u8] {
    b"persistent-exec"
}

#[cfg(windows)]
fn short_output_command() -> &'static str {
    "echo persistent-exec"
}

#[cfg(windows)]
fn expected_short_output() -> &'static [u8] {
    b"persistent-exec\r\n"
}

#[cfg(unix)]
fn long_running_command() -> &'static str {
    "sleep 60"
}

#[cfg(windows)]
fn long_running_command() -> &'static str {
    "ping -n 60 127.0.0.1 >NUL"
}
