use pretty_assertions::assert_eq;

use super::OUTPUT_BYTES_CAP;
use super::OutputBuffer;

#[test]
fn overflow_keeps_latest_bytes_and_reports_omission() {
    let mut buffer = OutputBuffer::default();
    buffer.push(&vec![b'a'; OUTPUT_BYTES_CAP]);
    buffer.push(b"tail");

    let (output, omitted_bytes) = buffer.take();

    assert_eq!(output.len(), OUTPUT_BYTES_CAP);
    assert_eq!(&output[OUTPUT_BYTES_CAP - 4..], b"tail");
    assert_eq!(omitted_bytes, 4);
}

#[test]
fn take_is_incremental() {
    let mut buffer = OutputBuffer::default();
    buffer.push(b"first");
    assert_eq!(buffer.take(), (b"first".to_vec(), 0));

    buffer.push(b"second");
    assert_eq!(buffer.take(), (b"second".to_vec(), 0));
}
