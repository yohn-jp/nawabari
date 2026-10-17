import fs from "node:fs";

import { DomainError, failure, success, type DomainResult } from "./domain/errors.js";

const REQUEST_LIMIT = 1_048_576;

/** Read one bounded, no-follow opened request object, never an unbounded stream. */
export function readSessionVerificationRequestFile(file: string): DomainResult<string> {
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const before = fs.fstatSync(descriptor);
    if (!before.isFile() || before.size > REQUEST_LIMIT) throw new Error("not a bounded regular file");
    const buffer = Buffer.alloc(REQUEST_LIMIT + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = fs.readSync(descriptor, buffer, length, buffer.length - length, null);
      if (count === 0) break;
      length += count;
    }
    const after = fs.fstatSync(descriptor);
    if (
      length > REQUEST_LIMIT ||
      length !== before.size ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs
    )
      throw new Error("request changed or exceeded its read bound");
    return success(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, length)));
  } catch {
    return failure(
      new DomainError(
        "INVALID_ARGUMENT",
        "--request-file must be a stable no-follow regular UTF-8 JSON file no larger than 1 MiB.",
        { option: "--request-file" },
      ),
    );
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}
