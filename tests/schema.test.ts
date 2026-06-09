import { test } from "node:test";
import assert from "node:assert/strict";
import { validateWalkthrough, parseWalkthrough } from "../packages/core/src/schema.ts";

const VALID = {
  version: "0.1",
  title: "A change",
  summary: "Does a thing.",
  source: { type: "git_diff" },
  stats: { files_changed: 1, additions: 1, deletions: 0 },
  chapters: [
    { id: "c1", title: "One", summary: "s", risk_level: "low", files: ["a.ts"] },
  ],
};

test("accepts a valid document", () => {
  const r = validateWalkthrough(VALID);
  assert.equal(r.valid, true, r.errors.join("; "));
});

test("rejects missing required fields", () => {
  const r = validateWalkthrough({ version: "0.1" });
  assert.equal(r.valid, false);
  assert.ok(r.errors.length > 0);
});

test("rejects a bad risk level and duplicate chapter ids", () => {
  const bad = {
    ...VALID,
    chapters: [
      { id: "dup", title: "A", risk_level: "extreme", files: [] },
      { id: "dup", title: "B", risk_level: "low", files: [] },
    ],
  };
  const r = validateWalkthrough(bad);
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => /risk_level/.test(e)));
  assert.ok(r.errors.some((e) => /duplicated/.test(e)));
});

test("parseWalkthrough throws on invalid JSON", () => {
  assert.throws(() => parseWalkthrough("{ not json"));
});

test("parseWalkthrough round-trips a valid document", () => {
  const doc = parseWalkthrough(JSON.stringify(VALID));
  assert.equal(doc.title, "A change");
});
