use std::collections::VecDeque;

pub(crate) const OUTPUT_BYTES_CAP: usize = 1024 * 1024;

#[derive(Debug, Default)]
pub(crate) struct OutputBuffer {
    head: Vec<u8>,
    tail: VecDeque<u8>,
    omitted_bytes: usize,
}

impl OutputBuffer {
    pub(crate) fn push(&mut self, chunk: &[u8]) {
        let head_cap = OUTPUT_BYTES_CAP / 2;
        let head_remaining = head_cap.saturating_sub(self.head.len());
        let head_len = head_remaining.min(chunk.len());
        self.head.extend_from_slice(&chunk[..head_len]);

        let rest = &chunk[head_len..];
        if rest.is_empty() {
            return;
        }

        let tail_cap = OUTPUT_BYTES_CAP - head_cap;
        if rest.len() >= tail_cap {
            self.omitted_bytes = self
                .omitted_bytes
                .saturating_add(self.tail.len())
                .saturating_add(rest.len() - tail_cap);
            self.tail.clear();
            self.tail
                .extend(rest[rest.len() - tail_cap..].iter().copied());
            return;
        }
        let overflow = self
            .tail
            .len()
            .saturating_add(rest.len())
            .saturating_sub(tail_cap);
        for _ in 0..overflow {
            self.tail.pop_front();
        }
        self.omitted_bytes = self.omitted_bytes.saturating_add(overflow);
        self.tail.extend(rest.iter().copied());
    }

    pub(crate) fn take(&mut self) -> (Vec<u8>, Vec<u8>, usize) {
        let omitted_bytes = std::mem::take(&mut self.omitted_bytes);
        let head = std::mem::take(&mut self.head);
        let tail = self.tail.drain(..).collect();
        (head, tail, omitted_bytes)
    }
}

#[cfg(test)]
#[path = "output_tests.rs"]
mod tests;
