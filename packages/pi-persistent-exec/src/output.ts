import type { NativePollResult } from "persistent-exec-node";

const MAX_SIDE_LINES = 1_000;

/** Bounded head/tail for one tool call, including all polls and cancellation drain. */
export class OutputBuffer {
  private head = "";
  private tail = "";
  private headFull = false;
  private middleOmitted = false;
  originalBytes = 0;
  truncated = false;

  constructor(private readonly maxBytes: number) {}

  append(poll: NativePollResult): void {
    this.originalBytes += poll.original_bytes;
    this.truncated ||= poll.omitted_bytes > 0;
    let remaining = poll.output;
    const headBytes = Math.floor(this.maxBytes / 2);
    if (!this.headFull) {
      const candidate = this.head + remaining;
      this.head = sliceBytes(candidate, headBytes, false)
        .split("\n")
        .slice(0, MAX_SIDE_LINES)
        .join("\n");
      remaining = candidate.slice(this.head.length);
      this.headFull = remaining.length > 0;
    }
    const candidate = this.tail + remaining;
    this.tail = sliceBytes(candidate, this.maxBytes - headBytes, true)
      .split("\n")
      .slice(-MAX_SIDE_LINES)
      .join("\n");
    this.middleOmitted ||= this.tail !== candidate;
    this.truncated ||= this.middleOmitted;
  }

  get output(): string {
    return this.head + (this.middleOmitted ? "\n... output omitted ...\n" : "") + this.tail;
  }
}

function sliceBytes(text: string, maxBytes: number, tail: boolean): string {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= maxBytes) return text;
  let boundary = tail ? bytes.length - maxBytes : maxBytes;
  // Do not split a UTF-8 code point at either retained boundary.
  while (boundary > 0 && boundary < bytes.length && (bytes[boundary] & 0xc0) === 0x80) {
    boundary += tail ? 1 : -1;
  }
  return (tail ? bytes.subarray(boundary) : bytes.subarray(0, boundary)).toString("utf8");
}
