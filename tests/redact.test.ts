import { test } from "node:test";
import assert from "node:assert/strict";
import { redactParsedDiff } from "../packages/core/src/redact.ts";
import type { ParsedDiff } from "../packages/core/src/types.ts";

function diffOf(lines: string[]): ParsedDiff {
  return {
    files: [
      {
        path: ".env",
        status: "modified",
        additions: lines.length,
        deletions: 0,
        binary: false,
        hunks: [
          {
            header: "@@",
            oldStart: 1,
            oldLines: 0,
            newStart: 1,
            newLines: lines.length,
            lines: lines.map((content, i) => ({
              type: "add" as const,
              content,
              oldNumber: null,
              newNumber: i + 1,
            })),
          },
        ],
      },
    ],
  };
}

function contents(d: ParsedDiff): string[] {
  return d.files[0].hunks[0].lines.map((l) => l.content);
}

test("masks key=value secrets but keeps the key", () => {
  const { diff, count } = redactParsedDiff(diffOf(["API_KEY=supersecretvalue123"]));
  const out = contents(diff)[0];
  assert.match(out, /API_KEY=/);
  assert.doesNotMatch(out, /supersecretvalue123/);
  assert.equal(count, 1);
});

test("masks known token shapes", () => {
  const { diff } = redactParsedDiff(
    diffOf(["const t = 'ghp_abcdefghijklmnopqrstuvwxyz0123'", "id = AKIAIOSFODNN7EXAMPLE"]),
  );
  const out = contents(diff);
  assert.doesNotMatch(out[0], /ghp_abcdefghij/);
  assert.doesNotMatch(out[1], /AKIAIOSFODNN7EXAMPLE/);
});

test("leaves ordinary code untouched", () => {
  const code = ["function add(a, b) { return a + b }", "const total = price * qty"];
  const { diff, count } = redactParsedDiff(diffOf(code));
  assert.deepEqual(contents(diff), code);
  assert.equal(count, 0);
});
