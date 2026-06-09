import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDiff, diffStats } from "../packages/core/src/diff.ts";

const SAMPLE = `diff --git a/src/math.js b/src/math.js
index 111..222 100644
--- a/src/math.js
+++ b/src/math.js
@@ -1,3 +1,4 @@
 export function add(a, b) {
-  return a + b
+  return a + b // sum
+  // note
 }
diff --git a/old/name.js b/new/name.js
similarity index 90%
rename from old/name.js
rename to new/name.js
index aaa..bbb 100644
--- a/old/name.js
+++ b/new/name.js
@@ -1,1 +1,1 @@
-const x = 1
+const x = 2
diff --git a/gone.txt b/gone.txt
deleted file mode 100644
index ccc..0000000
--- a/gone.txt
+++ /dev/null
@@ -1,2 +0,0 @@
-line one
-line two
diff --git a/added.txt b/added.txt
new file mode 100644
index 0000000..ddd
--- /dev/null
+++ b/added.txt
@@ -0,0 +1,1 @@
+brand new
diff --git a/logo.png b/logo.png
new file mode 100644
index 0000000..eee
Binary files /dev/null and b/logo.png differ
`;

test("parses all files with correct status", () => {
  const { files } = parseDiff(SAMPLE);
  assert.equal(files.length, 5);
  const byPath = Object.fromEntries(files.map((f) => [f.path, f]));
  assert.equal(byPath["src/math.js"].status, "modified");
  assert.equal(byPath["new/name.js"].status, "renamed");
  assert.equal(byPath["new/name.js"].oldPath, "old/name.js");
  assert.equal(byPath["gone.txt"].status, "deleted");
  assert.equal(byPath["added.txt"].status, "added");
  assert.equal(byPath["logo.png"].binary, true);
});

test("counts additions and deletions", () => {
  const { files } = parseDiff(SAMPLE);
  const math = files.find((f) => f.path === "src/math.js")!;
  assert.equal(math.additions, 2);
  assert.equal(math.deletions, 1);
});

test("assigns line numbers", () => {
  const { files } = parseDiff(SAMPLE);
  const math = files.find((f) => f.path === "src/math.js")!;
  const hunk = math.hunks[0];
  assert.equal(hunk.newStart, 1);
  const ctx = hunk.lines[0];
  assert.equal(ctx.type, "context");
  assert.equal(ctx.oldNumber, 1);
  assert.equal(ctx.newNumber, 1);
  const added = hunk.lines.find((l) => l.type === "add" && l.content.includes("sum"))!;
  assert.equal(added.oldNumber, null);
  assert.equal(typeof added.newNumber, "number");
});

test("aggregate stats", () => {
  const stats = diffStats(parseDiff(SAMPLE));
  assert.equal(stats.files_changed, 5);
  assert.equal(stats.additions, 2 + 1 + 0 + 1 + 0);
  assert.equal(stats.deletions, 1 + 1 + 2 + 0 + 0);
});

test("empty input yields no files", () => {
  assert.deepEqual(parseDiff(""), { files: [] });
});
