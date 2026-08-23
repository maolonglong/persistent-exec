use std::ffi::CStr;
use std::ffi::CString;
use std::ffi::c_void;
use std::time::Duration;
use std::time::Instant;

use pretty_assertions::assert_eq;
use serde::Deserialize;

use super::PersistentExecResult;
use super::decode_utf8;
use super::persistent_exec_create;
use super::persistent_exec_destroy;
use super::persistent_exec_free_result;
use super::persistent_exec_poll;
use super::persistent_exec_spawn;

#[derive(Debug, Deserialize, PartialEq, Eq)]
struct PollResult {
    output: String,
    omitted_bytes: usize,
    exit_code: Option<i32>,
}

unsafe fn take_result(result: *mut PersistentExecResult) -> (*mut c_void, i64, Option<String>) {
    assert!(!result.is_null());
    let result_ref = unsafe { &*result };
    assert!(
        result_ref.success,
        "native error code {}",
        result_ref.error_code
    );
    let data = if result_ref.data.is_null() {
        None
    } else {
        Some(
            unsafe { CStr::from_ptr(result_ref.data) }
                .to_str()
                .expect("data should be UTF-8")
                .to_string(),
        )
    };
    let values = (result_ref.handle, result_ref.int_value, data);
    unsafe { persistent_exec_free_result(result) };
    values
}

#[test]
fn c_abi_runs_and_polls_a_command() {
    let create = persistent_exec_create();
    let (handle, _, _) = unsafe { take_result(create) };
    assert!(!handle.is_null());

    let request = CString::new(format!(
        r#"{{"version":1,"cmd":{},"workdir":{}}}"#,
        serde_json::to_string(short_output_command()).expect("command should serialize"),
        serde_json::to_string(env!("CARGO_MANIFEST_DIR")).expect("path should serialize")
    ))
    .expect("request should not contain NUL");
    let spawn = unsafe { persistent_exec_spawn(handle, request.as_ptr()) };
    let (_, session_id, _) = unsafe { take_result(spawn) };

    let poll_request = CString::new(format!(r#"{{"version":1,"session_id":{session_id}}}"#))
        .expect("request should not contain NUL");
    let deadline = Instant::now() + Duration::from_secs(5);
    let mut output = String::new();
    let exit_code = loop {
        let poll = unsafe { persistent_exec_poll(handle, poll_request.as_ptr()) };
        let (_, _, data) = unsafe { take_result(poll) };
        let data: PollResult = serde_json::from_str(data.as_deref().expect("poll data expected"))
            .expect("poll data should deserialize");
        output.push_str(&data.output);
        if let Some(exit_code) = data.exit_code {
            break exit_code;
        }
        assert!(Instant::now() < deadline, "command did not exit in time");
        std::thread::sleep(Duration::from_millis(10));
    };

    assert_eq!((output, exit_code), ("ffi-ok".to_string(), 0));
    unsafe { persistent_exec_destroy(handle) };
}

#[cfg(unix)]
fn short_output_command() -> &'static str {
    "printf ffi-ok"
}

#[cfg(windows)]
fn short_output_command() -> &'static str {
    "powershell -NoProfile -Command \"[Console]::Out.Write('ffi-ok')\""
}

#[test]
fn utf8_decoder_preserves_code_points_across_poll_boundaries() {
    let mut pending = vec![0xe2, 0x82];
    assert_eq!(decode_utf8(&mut pending, /*flush*/ false), "");
    assert_eq!(pending, vec![0xe2, 0x82]);

    pending.push(0xac);
    assert_eq!(decode_utf8(&mut pending, /*flush*/ false), "€");
    assert_eq!(pending, Vec::<u8>::new());
}

#[test]
fn c_abi_rejects_unknown_request_versions() {
    let create = persistent_exec_create();
    let (handle, _, _) = unsafe { take_result(create) };
    let request =
        CString::new(r#"{"version":2,"session_id":1}"#).expect("request should not contain NUL");

    let result = unsafe { persistent_exec_poll(handle, request.as_ptr()) };
    let result_ref = unsafe { &*result };

    assert_eq!((result_ref.success, result_ref.error_code), (false, 1));
    unsafe {
        persistent_exec_free_result(result);
        persistent_exec_destroy(handle);
    }
}
