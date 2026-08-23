use std::collections::VecDeque;

pub(crate) const OUTPUT_BYTES_CAP: usize = 1024 * 1024;

#[derive(Debug, Default)]
pub(crate) struct OutputBuffer {
    bytes: VecDeque<u8>,
    omitted_bytes: usize,
}

impl OutputBuffer {
    pub(crate) fn push(&mut self, chunk: &[u8]) {
        if chunk.len() >= OUTPUT_BYTES_CAP {
            self.omitted_bytes = self
                .omitted_bytes
                .saturating_add(self.bytes.len())
                .saturating_add(chunk.len() - OUTPUT_BYTES_CAP);
            self.bytes.clear();
            self.bytes
                .extend(chunk[chunk.len() - OUTPUT_BYTES_CAP..].iter().copied());
            return;
        }

        let overflow = self
            .bytes
            .len()
            .saturating_add(chunk.len())
            .saturating_sub(OUTPUT_BYTES_CAP);
        for _ in 0..overflow {
            self.bytes.pop_front();
        }
        self.omitted_bytes = self.omitted_bytes.saturating_add(overflow);
        self.bytes.extend(chunk.iter().copied());
    }

    pub(crate) fn take(&mut self) -> (Vec<u8>, usize) {
        let omitted_bytes = std::mem::take(&mut self.omitted_bytes);
        let bytes = self.bytes.drain(..).collect();
        (bytes, omitted_bytes)
    }
}

#[cfg(test)]
#[path = "output_tests.rs"]
mod tests;
