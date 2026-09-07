use pretty_assertions::assert_eq;

use super::OUTPUT_BYTES_CAP;
use super::OutputBuffer;

#[test]
fn overflow_keeps_symmetric_head_and_tail_and_reports_omission() {
    let mut buffer = OutputBuffer::default();
    buffer.push(b"head");
    buffer.push(&vec![b'a'; OUTPUT_BYTES_CAP]);
    buffer.push(b"tail");

    let (head, tail, omitted_bytes) = buffer.take();

    assert_eq!(head.len(), OUTPUT_BYTES_CAP / 2);
    assert_eq!(tail.len(), OUTPUT_BYTES_CAP / 2);
    assert_eq!(&head[..4], b"head");
    assert_eq!(&tail[tail.len() - 4..], b"tail");
    assert_eq!(omitted_bytes, 8);
    assert_eq!(buffer.take(), (vec![], vec![], 0));
}

#[test]
fn take_is_incremental() {
    let mut buffer = OutputBuffer::default();
    buffer.push(b"first");
    assert_eq!(buffer.take(), (b"first".to_vec(), vec![], 0));

    buffer.push(b"second");
    assert_eq!(buffer.take(), (b"second".to_vec(), vec![], 0));
}
