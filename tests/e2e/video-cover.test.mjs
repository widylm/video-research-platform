import assert from "node:assert/strict";
import { test } from "node:test";
import { coverMaxBytes, isCoverJpeg } from "../../lib/video-cover.ts";

test("rejects empty, malformed, oversized or disguised uploads", () => {
  for (const bytes of [
    Buffer.alloc(0),
    Buffer.from("<svg/>"),
    Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
    Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0xfe, 0xff, 0xff, 0xd9]),
    Buffer.alloc(coverMaxBytes + 1),
  ]) {
    assert.equal(isCoverJpeg(bytes), false);
  }
});
