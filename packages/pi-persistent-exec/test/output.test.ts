import { expect, test } from "bun:test";
import { OutputBuffer } from "../src/output";

function append(
  buffer: OutputBuffer,
  output: string,
  omittedBytes = 0,
  originalBytes = Buffer.byteLength(output) + omittedBytes,
) {
  buffer.append({
    output,
    omitted_bytes: omittedBytes,
    original_bytes: originalBytes,
    exit_code: null,
  });
}

test("preserves the first and last output across incremental polls", () => {
  const output = new OutputBuffer(16);
  append(output, "START---");
  append(output, "x".repeat(1_000_000));
  append(output, "-----END");
  expect(output.output).toBe("START---\n... output omitted ...\n-----END");
  expect(output.originalBytes).toBe(1_000_016);
  expect(output.truncated).toBe(true);
});

test("preserves newlines and UTF-8 at byte boundaries", () => {
  const output = new OutputBuffer(9);
  append(output, "€\n");
  append(output, "€\n");
  expect(output.output).toBe("€\n€\n");
  expect(output.truncated).toBe(false);
  append(output, "界\n");
  expect(output.output).toBe("€\n\n... output omitted ...\n\n界\n");
  expect(output.output).not.toContain("�");
});

test("bounds both sides by lines as well as bytes", () => {
  const output = new OutputBuffer(50_000);
  append(output, Array.from({ length: 3_000 }, (_, i) => `line${i}\n`).join(""));
  expect(output.output).toStartWith("line0\n");
  expect(output.output).toEndWith("line2999\n");
  expect(output.output.split("\n").length).toBeLessThanOrEqual(2_002);
  expect(output.truncated).toBe(true);
});

test("counts native raw bytes rather than omission notices", () => {
  const output = new OutputBuffer(100);
  append(output, "head\n... 1000 bytes omitted ...\ntail", 1_000, 1_008);
  expect(output.originalBytes).toBe(1_008);
  expect(output.truncated).toBe(true);
});

test("zero budget retains no process output", () => {
  const output = new OutputBuffer(0);
  append(output, "secret output");
  expect(output.output).not.toContain("secret output");
  expect(output.originalBytes).toBe(13);
  expect(output.truncated).toBe(true);
});
